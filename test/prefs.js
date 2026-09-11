"use strict";
/**
 * 个人偏好 vs 服务器级设置 —— 那条线画在哪儿，以及它有没有真的接上。
 *
 * 跑法：node test/prefs.js
 * 用临时 WB_DATA_DIR，绝不碰真账号、真偏好、真 config.json。
 *
 * 起因是两条用户抱怨：普通成员点一下桌面宠物的开关，回「这块是服务器级设置，归平台管理员管」；
 * 切底层引擎，界面上只显示四个字「切换失败」。改法是把设置分成两层。分层这件事一旦做错，
 * 错法只有两种，而且都是静默的：
 *
 *   放宽过头 —— 普通成员顺手把整台服务器的模型清单、安全档位、可执行文件路径改了；
 *   接线漏了 —— 闸放行、处理器没接，用户点完显示「已保存」，回头一看什么都没变。
 *
 * 所以这个文件的重点不是「接口返回 200」，是下面这几条一破就出事的线，每条后面都跟一个反向对照：
 *
 *   1. isPersonalPatch 那张白名单：bin / permissionMode / max_steps / models 一个都不许溜进去
 *   2. 闸和处理器共用同一张表：凡是闸放行的请求体，split 出来的「服务器级那半」必须是空的
 *   3. soloDesktop 真值表：只有「Electron 壳 + 只听回环」两个都成立才算个人桌面版
 *   4. 拆墙和脱敏必须同生共死：只拆一半的话，界面把真 Key 显示成空，用户随手一存就抹了
 *   5. 偏好真的进了执行层：engines.resolve 拿到的是**这个账号**选的引擎，不是别人的
 *   6. 启动失败有出口：桌面壳在的时候把错误交回去画窗口，纯命令行照旧退出码 1
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wb-prefs-"));
process.env.WB_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.WB_DATA_DIR, { recursive: true });

const express = require("express");
const ROOT = path.join(__dirname, "..");
const account = require(path.join(ROOT, "account"));
const org = require(path.join(ROOT, "org"));
const admin = require(path.join(ROOT, "admin"));
const prefs = require(path.join(ROOT, "prefs"));
const tools = require(path.join(ROOT, "tools"));
const engines = require(path.join(ROOT, "engines"));
const thinking = require(path.join(ROOT, "thinking"));

const BASE_WS = path.join(TMP, "workspace");
tools.setWorkspaceDir(BASE_WS);

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });

// 一份假 config，形状照抄真的那份。故意在 claude-code 上同时放 bin（服务器级）和 model（个人）,
// 覆盖时这两样的去向不一样，正是最容易写错的地方
const makeConfig = () => ({
  agent: {
    engine: "builtin",
    thinking: "auto",
    max_steps: 30,
    engine_options: { "claude-code": { bin: "/opt/bin/claude", model: "sonnet" } },
  },
  pet: { enabled: false, scale: 1, opacity: 1, character: "cat" },
  shortcuts: { toggle: "Alt+Space" },
  model_follow_last: false,
  last_picked_model: "",
  assist_model: "",
  models: [{ name: "m1", model: "gpt-x", api_key: "REAL-MODEL-KEY" }],
  search: { provider: "jina", jina_key: "REAL-JINA-KEY" },
  im: { feishu: { app_id: "cli_x", app_secret: "REAL-APP-SECRET" } },
});
let CONFIG = makeConfig();

// ===================================================================
// 【1】isPersonalPatch：白名单一个字段都不许多
// ===================================================================
console.log("\n【1】哪些字段算「个人的」——这张表是唯一真源，闸和处理器都靠它");

const ACCEPT = [
  ["宠物开关", { pet: { enabled: true } }],
  ["宠物的一堆参数", { pet: { enabled: true, scale: 1.4, opacity: 0.8, character: "cat", notify: false } }],
  ["全局快捷键", { shortcuts: { toggle: "Alt+Space" } }],
  ["新对话沿用上次的模型", { model_follow_last: true }],
  ["上次选的模型", { last_picked_model: "m1" }],
  ["底层引擎", { agent: { engine: "claude-code" } }],
  ["思考档位", { agent: { thinking: "high" } }],
  ["某个引擎单独用哪个模型", { agent: { engine_options: { "claude-code": { model: "opus" } } } }],
  ["某个引擎单独的思考档", { agent: { engine_options: { "claude-code": { thinking: "high" } } } }],
  ["清空某个引擎的模型（空串也是写）", { agent: { engine_options: { "claude-code": { model: "" } } } }],
  ["几样一起改", { pet: { enabled: true }, agent: { engine: "codex", engine_options: { codex: { model: "o3" } } } }],
];
for (const [name, body] of ACCEPT) ok(prefs.isPersonalPatch(body) === true, "放行：" + name, body);

const REJECT = [
  ["引擎的可执行文件路径（多人服务器上等于任意命令执行）", { agent: { engine_options: { "claude-code": { bin: "/bin/sh" } } } }],
  ["bin 混在 model 里想蹭过去", { agent: { engine_options: { "claude-code": { model: "opus", bin: "/bin/sh" } } } }],
  ["CLI 的权限档（能绕开组织的 allow_shell=false）", { agent: { engine_options: { "claude-code": { permissionMode: "bypassPermissions" } } } }],
  ["CLI 的沙箱开关", { agent: { engine_options: { codex: { sandbox: "danger-full-access" } } } }],
  ["CLI 的联网开关", { agent: { engine_options: { codex: { network: true } } } }],
  ["CLI 的额外命令行参数", { agent: { engine_options: { codex: { extraArgs: "--yolo" } } } }],
  ["整台机器的最大执行步数", { agent: { max_steps: 999 } }],
  ["整台机器的超时", { agent: { timeout_ms: 1 } }],
  ["模型清单（里面是 API Key）", { models: [{ name: "x", model: "y", api_key: "k" }] }],
  ["安全档位", { security: { level: "off" } }],
  ["全局工作目录", { workspace_dir: "/" }],
  ["个人项夹带服务器项", { pet: { enabled: true }, models: [] }],
  ["个人项夹带一个不认识的字段", { pet: { enabled: true }, whatever: 1 }],
  ["空请求体（没改任何东西，不该当个人写放行）", {}],
  ["数组", []],
  ["null", null],
  ["字符串", "pet"],
  ["agent 是 null", { agent: null }],
  ["engine_options 是 null", { agent: { engine_options: null } }],
  ["engine_options 里挂的是字符串", { agent: { engine_options: { "claude-code": "opus" } } }],
];
for (const [name, body] of REJECT) ok(prefs.isPersonalPatch(body) === false, "拦下：" + name, body);

// ===================================================================
// 【2】split：闸和处理器必须看同一张表
// ===================================================================
console.log("\n【2】拆请求体：闸放行的，处理器一个字段都不许落到 config 上");

// 这条是本文件里最重要的不变量。闸用 isPersonalPatch 判「能不能进」，处理器用 split 判
// 「哪半落偏好文件、哪半落 config.json」。两者一旦对不上，就会出现最难查的那种事故：
// 闸放行了一个成员的请求，处理器把里面某个字段当服务器级设置写进了 config——静默、全局、没人知道。
for (const [name, body] of ACCEPT) {
  const { personal, rest } = prefs.split(body);
  ok(Object.keys(rest).length === 0, `闸放行的请求体，服务器级那半必须是空的：${name}`, rest);
  ok(prefs.isPersonalPatch(personal) === true, `拆出来的个人那半，自己也得过闸：${name}`, personal);
}

// 反向：混合请求体要拆干净，一个字段都不能丢，也不能两边都算
const mixed = {
  pet: { enabled: true },
  models: [{ name: "x" }],
  workspace_dir: "/tmp",
  agent: {
    engine: "codex",
    thinking: "high",
    max_steps: 99,
    engine_options: { "claude-code": { model: "opus", bin: "/bin/sh" }, codex: { thinking: "low" } },
  },
};
const sp = prefs.split(mixed);
ok(sp.personal.pet && sp.personal.pet.enabled === true, "宠物开关落到个人那半", sp.personal);
ok(sp.rest.models && sp.rest.workspace_dir === "/tmp", "模型清单和全局工作目录落到服务器那半", Object.keys(sp.rest));
eq(sp.personal.agent.engine, "codex", "底层引擎落个人");
eq(sp.personal.agent.thinking, "high", "思考档落个人");
eq(sp.rest.agent.max_steps, 99, "最大执行步数落服务器");
eq(sp.personal.agent.engine_options["claude-code"].model, "opus", "同一个引擎里，model 落个人");
eq(sp.rest.agent.engine_options["claude-code"].bin, "/bin/sh", "同一个引擎里，bin 落服务器（这一条最容易写成整块归一边）");
ok(sp.personal.agent.engine_options["claude-code"].bin === undefined, "个人那半绝不能捎带 bin", sp.personal.agent.engine_options);
eq(sp.personal.agent.engine_options.codex.thinking, "low", "另一个引擎的思考档也落个人");
ok(prefs.isPersonalPatch(sp.personal) === true, "混合体拆出来的个人那半，能独立过闸", sp.personal);
ok(prefs.isPersonalPatch(sp.rest) === false, "反向对照：服务器那半独立喂给闸必须被拦", sp.rest);
// 不丢字段
const flat = (o, pre = "") => Object.entries(o || {}).flatMap(([k, v]) =>
  v && typeof v === "object" && !Array.isArray(v) ? flat(v, pre + k + ".") : [pre + k]);
const all = new Set([...flat(sp.personal), ...flat(sp.rest)]);
for (const k of flat(mixed)) ok(all.has(k), "拆完没丢字段：" + k);
eq(flat(sp.personal).length + flat(sp.rest).length, flat(mixed).length, "也没有哪个字段被算了两遍");
// 空的引擎项不该凭空造出一个壳
const only = prefs.split({ agent: { engine_options: { "claude-code": { bin: "/x" } } } });
ok(Object.keys(only.personal).length === 0, "整块都是服务器级时，个人那半是空对象而不是 {agent:{}}", only.personal);

// ===================================================================
// 【3】文件名：中文账号、大小写、../
// ===================================================================
console.log("\n【3】一人一个文件：文件名不许被账号名带沟里");

const PREFS_DIR = path.join(process.env.WB_DATA_DIR, "prefs");
eq(prefs.keyOf(""), "", "空账号名不给文件名（拿不到当前账号时就该回落 config）");
eq(prefs.fileOf(""), "", "自然也没有文件路径");
ok(/^[a-z0-9_-]+$/.test(prefs.keyOf("张三")), "中文账号名也只产出安全字符", prefs.keyOf("张三"));
ok(prefs.keyOf("Alice") !== prefs.keyOf("alice"), "大小写不同的两个账号不共用一个文件（大小写不敏感的盘上会撞）", {
  a: prefs.keyOf("Alice"), b: prefs.keyOf("alice") });
eq(prefs.keyOf("catuncle"), prefs.keyOf("catuncle"), "同一个账号名两次算出来一样（不然设置会随机丢）");
for (const bad of ["../../etc/passwd", "a/b", "..", "C:\\x", "空 格"]) {
  const f = prefs.fileOf(bad);
  ok(path.resolve(f).startsWith(path.resolve(PREFS_DIR) + path.sep), "逃不出偏好目录：" + JSON.stringify(bad), f);
}
ok(prefs.fileOf({ username: "catuncle" }) === prefs.fileOf("catuncle"), "传 user 对象和传用户名是同一个文件");

// ===================================================================
// 【4】读写与缓存：别的进程改了，这边得看得见
// ===================================================================
console.log("\n【4】读写：缓存要带 mtime 校验（命令行 wb 是另一个进程，多开的窗口也是）");

const U = "cachetest";
ok(Object.keys(prefs.read(U)).length === 0, "没写过就是空的（不是抛错）");
prefs.write(U, { agent: { engine: "codex" }, pet: { enabled: true } });
eq(prefs.read(U).agent.engine, "codex", "写完读得回来");
prefs.write(U, { agent: { thinking: "high" } });
eq(prefs.read(U).agent.engine, "codex", "第二次写只合并，没提到的原样留着");
eq(prefs.read(U).agent.thinking, "high", "新写的也在");
eq(prefs.read(U).pet.enabled, true, "另一棵子树没被踩");
// 模拟另一个进程改这个文件
const f = prefs.fileOf(U);
prefs.read(U); // 先建上缓存
fs.writeFileSync(f, JSON.stringify({ agent: { engine: "claude-code" }, 从别的进程写的: true }));
fs.utimesSync(f, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
eq(prefs.read(U).agent.engine, "claude-code", "别的进程改完，这边下一次读就看得见（缓存按 mtime+size 失效）");
ok(prefs.read(U)["从别的进程写的"] === true, "整份都是新的，不是新旧混着");
fs.writeFileSync(f, "{ 这不是 JSON");
fs.utimesSync(f, new Date(Date.now() + 4000), new Date(Date.now() + 4000));
ok(Object.keys(prefs.read(U)).length === 0, "文件坏了就当没配过，不许把整台服务器带崩");
fs.rmSync(f);
ok(Object.keys(prefs.read(U)).length === 0, "文件被删了也读得动（缓存跟着清）");
ok(Object.keys(prefs.read("")).length === 0, "拿不到账号时读出来是空的");
eq(Object.keys(prefs.write("", { pet: {} })).length, 0, "拿不到账号时写是个空操作，不会在偏好目录里造出个怪文件");

// ===================================================================
// 【5】soloDesktop 真值表
// ===================================================================
console.log("\n【5】什么才算「个人桌面版」：壳 + 回环，两个都得成立");

const DEPLOY = [
  [{ shell: true, host: "127.0.0.1" }, true, "Electron 壳 + 只听 127.0.0.1 —— 双击打开的那份"],
  [{ shell: true, host: "::1" }, true, "IPv6 回环也算"],
  [{ shell: true, host: "[::1]" }, true, "带方括号的 IPv6 写法也认"],
  [{ shell: true, host: "localhost" }, true, "写成 localhost 也算"],
  [{ shell: true, host: " 127.0.0.1 " }, true, "配置里带空格也认"],
  [{ shell: true, host: "0.0.0.0" }, false, "壳在但绑了 0.0.0.0：别人连得进来，闸必须留着"],
  [{ shell: true, host: "192.168.1.9" }, false, "壳在但绑了局域网地址：同上"],
  [{ shell: true, host: "" }, false, "壳在但没说监听哪儿：按最严的算"],
  [{ shell: false, host: "127.0.0.1" }, false, "node server.js 只听本机：仍可能是给别人用的服务器，闸留着"],
  [{ shell: false, host: "0.0.0.0" }, false, "Docker 部署，正是要拦的那种"],
  [{}, false, "什么都没传"],
];
for (const [arg, want, why] of DEPLOY) {
  eq(admin.setDeployment(arg), want, why);
  eq(admin.isSoloDesktop(), want, "  └ isSoloDesktop() 跟着一起变");
}
admin.setDeployment({ shell: false, host: "0.0.0.0" }); // 回到服务器形态，下面几节都建立在这个前提上

// ===================================================================
// 【6】~【8】起一个跟 server.js 中间件顺序一模一样的最小应用
// ===================================================================
const app = express();
app.use(express.json());
app.use(account.createRouter({}));
app.use(account.authGuard);
app.use(admin.tenantScope({ withWorkspace: tools.withWorkspace, withPolicy: tools.withPolicy, getWorkspaceDir: tools.getWorkspaceDir }));
app.use(admin.platformGuard);
app.use(admin.redactGuard);
app.use(admin.createAdminRouter({ orgUsage: () => ({ files: 0 }) }));
// 下面这些是 server.js 上真实接口的替身，形状照抄，用来验中间件
app.post("/api/settings", (req, res) => res.json({ ok: true, got: req.body }));
app.get("/api/settings", (_req, res) => res.json({ search: CONFIG.search, im: CONFIG.im, models: CONFIG.models }));
app.post("/api/pet/avatar", (_req, res) => res.json({ ok: true }));
app.delete("/api/pet/avatar", (_req, res) => res.json({ ok: true }));
app.post("/api/engines/test", (_req, res) => res.json({ ok: true }));
app.post("/api/assist/model", (_req, res) => res.json({ ok: true }));
app.post("/api/engines", (_req, res) => res.json({ ok: true }));
app.post("/api/schedules", (_req, res) => res.json({ ok: true }));
// 探针：这条请求里执行层看到的是什么。验「偏好真的进了执行层」，而不是只躺在文件里没人读
app.get("/api/prefs-probe", (_req, res) => {
  const view = prefs.agentView(CONFIG);
  let picked = null;
  try { picked = engines.resolve(view); } catch (e) { picked = { error: e.message }; }
  res.json({
    engine: prefs.agentCfg(CONFIG).engine,
    thinking: prefs.agentCfg(CONFIG).thinking,
    opts: prefs.agentCfg(CONFIG).engine_options,
    resolved: picked && picked.error ? picked : { id: picked.backend ? picked.backend.id : "builtin", opts: picked.opts },
    pet: prefs.petCfg(CONFIG),
    shortcuts: prefs.shortcutsCfg(CONFIG),
    model: prefs.modelCfg(CONFIG),
    sameObject: view === CONFIG,
  });
});

const server = app.listen(0, "127.0.0.1");
const listening = new Promise((r) => server.once("listening", r));

function call(method, url, { body, cookie } = {}) {
  const port = server.address().port;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = require("http").request(
      { host: "127.0.0.1", port, method, path: url,
        headers: { ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
                   ...(cookie ? { cookie } : {}) } },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(buf); } catch {}
          const sc = res.headers["set-cookie"];
          resolve({ status: res.statusCode, json, cookie: sc ? String(sc[0]).split(";")[0] : null });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  await listening;

  // ---------- 两个账号：平台管理员 + 普通成员 ----------
  let r = await call("POST", "/api/auth/register", { body: { username: "laoban", password: "pw-laoban-123" } });
  eq(r.status, 200, "\n开局：第一个账号注册成功（他是平台管理员）");
  const boss = r.cookie;
  r = await call("POST", "/api/admin/invites", { cookie: boss, body: { role: "member", max_uses: 5 } });
  const inv = r.json.code;
  r = await call("POST", "/api/auth/register", { body: { username: "xiaozhang", password: "pw-zhang-123", invite: inv } });
  eq(r.status, 200, "普通成员注册成功");
  const zhang = r.cookie;
  eq(r.json.user.role, "member", "他确实只是个成员");

  console.log("\n【6】普通成员：自己那几项随便改，服务器那几项一个都碰不了");
  r = await call("POST", "/api/settings", { cookie: zhang, body: { pet: { enabled: true } } });
  eq(r.status, 200, "开桌面宠物 —— 就是这条以前回「这块是服务器级设置，归平台管理员管」");
  r = await call("POST", "/api/settings", { cookie: zhang, body: { agent: { engine: "claude-code" } } });
  eq(r.status, 200, "切底层引擎 —— 就是这条以前只显示「切换失败」");
  r = await call("POST", "/api/settings", { cookie: zhang, body: { agent: { thinking: "high" } } });
  eq(r.status, 200, "换思考档位");
  r = await call("POST", "/api/settings", { cookie: zhang, body: { shortcuts: { toggle: "Alt+K" } } });
  eq(r.status, 200, "改自己的全局快捷键");
  r = await call("POST", "/api/settings", { cookie: zhang, body: { last_picked_model: "m1", model_follow_last: true } });
  eq(r.status, 200, "记住上次选的模型");
  r = await call("POST", "/api/pet/avatar", { cookie: zhang, body: { data: "x" } });
  eq(r.status, 200, "换宠物头像（/api/pet/ 已经从平台写表里拿掉了）");
  r = await call("DELETE", "/api/pet/avatar", { cookie: zhang });
  eq(r.status, 200, "删宠物头像");
  r = await call("POST", "/api/engines/test", { cookie: zhang, body: { id: "claude-code" } });
  eq(r.status, 200, "一键连接自己本机那份 CLI（花的是他自己的订阅）");
  r = await call("POST", "/api/assist/model", { cookie: zhang, body: { model: "m1" } });
  eq(r.status, 200, "改助理页用哪个模型");

  // 反向对照：墙还在
  r = await call("POST", "/api/settings", { cookie: zhang, body: { models: [{ name: "x", model: "y", api_key: "k" }] } });
  eq(r.status, 403, "改模型清单（里面是 API Key）：拦下");
  ok(r.json && r.json.platform_only === true, "而且明确告诉前端这是平台级的，别只显示「切换失败」", r.json);
  r = await call("POST", "/api/settings", { cookie: zhang, body: { agent: { max_steps: 99 } } });
  eq(r.status, 403, "改整台机器的最大执行步数：拦下");
  r = await call("POST", "/api/settings", { cookie: zhang, body: { agent: { engine_options: { "claude-code": { bin: "/bin/sh" } } } } });
  eq(r.status, 403, "改引擎的可执行文件路径：拦下（这条放过去等于任意命令执行）");
  r = await call("POST", "/api/settings", { cookie: zhang, body: { pet: { enabled: true }, models: [] } });
  eq(r.status, 403, "个人项夹带服务器项想蹭过去：整单拦下");
  r = await call("POST", "/api/settings", { cookie: zhang, body: { agent: { engine: "codex", max_steps: 99 } } });
  eq(r.status, 403, "同一个 agent 块里夹带：也整单拦下");
  r = await call("POST", "/api/engines", { cookie: zhang, body: { engine: "codex" } });
  eq(r.status, 403, "改引擎的服务器默认值：仍归平台管理员（只放行了 /api/engines/test 这一条）");
  r = await call("POST", "/api/schedules", { cookie: zhang, body: { task: "x" } });
  eq(r.status, 403, "建定时任务：仍归平台管理员");
  r = await call("POST", "/api/settings", { cookie: boss, body: { models: [{ name: "x", model: "y" }] } });
  eq(r.status, 200, "反向对照：平台管理员改这些一切照旧");

  console.log("\n【7】拆墙和脱敏必须同生共死");
  r = await call("GET", "/api/settings", { cookie: zhang });
  eq(r.status, 200, "成员读得到设置页");
  eq(r.json.search.jina_key, "", "但读不到搜索的 Key");
  eq(r.json.im.feishu.app_secret, "", "读不到飞书的 App Secret");
  eq(r.json.models[0].api_key, "", "读不到模型的 API Key");
  eq(r.json.im.feishu.app_id, "cli_x", "反向对照：不像凭证的字段原样返回（别把 app_id 也抹了）");
  r = await call("GET", "/api/settings", { cookie: boss });
  eq(r.json.search.jina_key, "REAL-JINA-KEY", "反向对照：平台管理员读得到真值");

  // 切成个人桌面版：两个开关必须一起松。只松一半的话，界面把 Key 显示成空，
  // 用户随手点一下保存就把真 Key 抹了 —— 这是整套改动里唯一真会丢数据的坑
  admin.setDeployment({ shell: true, host: "127.0.0.1" });
  r = await call("POST", "/api/settings", { cookie: zhang, body: { models: [{ name: "x", model: "y" }] } });
  eq(r.status, 200, "桌面版：没有「平台管理员」这回事，服务器级设置也能改");
  r = await call("GET", "/api/settings", { cookie: zhang });
  eq(r.json.search.jina_key, "REAL-JINA-KEY", "同一趟里脱敏也必须跟着关（否则一存就把真 Key 抹成空）");
  eq(r.json.models[0].api_key, "REAL-MODEL-KEY", "模型的 Key 同样是真值");
  admin.setDeployment({ shell: false, host: "0.0.0.0" });
  r = await call("POST", "/api/settings", { cookie: zhang, body: { models: [] } });
  eq(r.status, 403, "切回服务器形态：墙立刻回来（说明是每次请求现判，不是启动时烙死的）");
  r = await call("GET", "/api/settings", { cookie: zhang });
  eq(r.json.search.jina_key, "", "脱敏也一起回来");

  console.log("\n【8】偏好真的进了执行层（不然就是「设置能存，但一个字节都不生效」）");
  // 给成员写一份偏好：换引擎、换思考档、只改这个引擎的模型
  prefs.write("xiaozhang", {
    agent: { engine: "claude-code", thinking: "high", engine_options: { "claude-code": { model: "opus" } } },
    pet: { enabled: true, scale: 1.5 },
    shortcuts: { toggle: "Alt+K" },
    last_picked_model: "m1",
  });
  r = await call("GET", "/api/prefs-probe", { cookie: zhang });
  eq(r.json.engine, "claude-code", "这条请求里，执行层看到的引擎是**他自己**选的");
  eq(r.json.thinking, "high", "思考档也是他自己的");
  eq(r.json.resolved.id, "claude-code", "engines.resolve 解出来的就是这一个（agent.js 走的正是这条路）");
  eq(r.json.resolved.opts.model, "opus", "解出来的模型是他自己填的");
  eq(r.json.resolved.opts.bin, "/opt/bin/claude", "可执行文件路径仍然用服务器上配的那份（他改不了，也不该被他的偏好抹掉）");
  eq(r.json.pet.enabled, true, "宠物开关是他自己的");
  eq(r.json.pet.scale, 1.5, "缩放是他自己的");
  eq(r.json.pet.opacity, 1, "他没设过的项回落到服务器默认（不是变 undefined）");
  eq(r.json.shortcuts.toggle, "Alt+K", "快捷键是他自己的");
  eq(r.json.model.last_picked_model, "m1", "上次选的模型是他自己的");
  eq(r.json.sameObject, false, "有偏好时给执行层的是覆盖过的视图");

  r = await call("GET", "/api/prefs-probe", { cookie: boss });
  eq(r.json.engine, "builtin", "反向对照：平台管理员这一趟看到的还是服务器默认的内置引擎");
  eq(r.json.resolved.id, "builtin", "  └ 解出来的也是内置");
  eq(r.json.pet.enabled, false, "  └ 宠物也没被别人的偏好带跑");
  eq(r.json.model.last_picked_model, "", "  └ 上次选的模型也是各归各的");
  eq(r.json.sameObject, true, "没偏好时原样把 config 交出去（同一个对象——config.agent 是会被热更新就地改的，复制一份会让改动看起来「没生效」）");
  eq(CONFIG.agent.engine, "builtin", "全程没有谁把成员的选择写回 config.agent");
  eq(CONFIG.agent.engine_options["claude-code"].model, "sonnet", "config 里那份 engine_options 也没被就地改（覆盖必须是复制一层）");

  // 桌面版短路：那边一切照旧落 config.json，就算偏好文件在也不该被读
  admin.setDeployment({ shell: true, host: "127.0.0.1" });
  r = await call("GET", "/api/prefs-probe", { cookie: zhang });
  eq(r.json.engine, "builtin", "桌面版：不读偏好文件，一切照旧看 config（壳在任何人登录之前就靠 config 装宠物和快捷键）");
  eq(r.json.sameObject, true, "  └ 也不白复制一份视图出来");
  admin.setDeployment({ shell: false, host: "0.0.0.0" });

  console.log("\n【9】没有请求上下文的地方（定时任务 / IM / 命令行 wb）必须回落到 config");
  eq(prefs.current(), null, "ALS 外面取不到当前账号");
  eq(prefs.agentCfg(CONFIG).engine, "builtin", "取值回落到 config.agent");
  eq(prefs.agentView(CONFIG), CONFIG, "整份 config 原样交出去");
  eq(prefs.petCfg(CONFIG).enabled, false, "宠物回落到 config.pet");
  eq(prefs.modelCfg(CONFIG).last_picked_model, "", "上次选的模型回落到 config");
  await prefs.withPrefs({ agent: { engine: "codex" } }, async () => {
    eq(prefs.agentCfg(CONFIG).engine, "codex", "反向对照：套上 ALS 之后立刻生效");
    await new Promise((r2) => setImmediate(r2));
    eq(prefs.agentCfg(CONFIG).engine, "codex", "跨一次 await 也还在（AsyncLocalStorage 的意义就在这儿）");
  });
  eq(prefs.agentCfg(CONFIG).engine, "builtin", "出了这段又回落");

  server.close();
  runSourcePins();
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});

// ===================================================================
// 【10】起不了进程内 HTTP 测试的那几段，钉在源码上 + 切片跑
//       （server.js 是 require 即 listen，electron-main.js 要有 electron 才 require 得动）
// ===================================================================
function slice(file, name) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${file} 里找不到函数 ${name}`);
  const j = src.indexOf("\n}\n", i);
  if (j < 0) throw new Error(`${file} 里 ${name} 没有以顶格 } 结尾，切不出来`);
  return src.slice(i, j + 3);
}

function runSourcePins() {
  const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const agentSrc = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8");
  const mainSrc = fs.readFileSync(path.join(ROOT, "electron-main.js"), "utf8");

  console.log("\n【10】接线钉在源码上：闸放行了，处理器得真的接住");
  // 上面第 6 节验的是「闸放不放行」。放行之后由谁落盘、落到哪，是 server.js 里的事，
  // 而 server.js require 即 listen，起不了进程内测试。谁把这几行改回去，上面照样全绿。
  ok(/function ownPrefs\(req\)\s*\{\s*return !\(admin\.isSoloDesktop\(\) \|\| ownsGlobalWorkspace\(/.test(serverSrc),
     "ownPrefs 的判据是「桌面版 or 平台管理员 → 写 config，其余人写自己那份」");
  ok(/if \(ownPrefs\(req\)\) \{[\s\S]{0,400}?const \{ personal, rest \} = prefs\.split\(b\);/.test(serverSrc),
     "POST /api/settings 真的按 prefs.split 分流（跟闸共用同一张表）");
  ok(/if \(!Object\.keys\(b\)\.length\) return res\.json\(\{ ok: true, personal: true/.test(serverSrc),
     "整单都是个人项时不去动 config.json");
  ok(/const fields = ownPrefs\(req\) \? \["model"\] : \["bin", "model"\]/.test(serverSrc),
     "/api/engines/test 把非平台管理员传来的 bin 丢掉（闸放行了这条路，bin 就得在路由里挡）");
  ok(/if \(ownPrefs\(req\)\) prefs\.write\(req\.user, \{ last_picked_model:/.test(serverSrc),
     "选模型时按账号记「上次用的」");
  ok(/if \(ownPrefs\(req\)\) \{\s*\n\s*prefs\.write\(req\.user, \{ assist_model:/.test(serverSrc),
     "助理页的模型也按账号存");
  // 锚在整条语句上而不是光看 setDeployment 这几个字：写成 `const solo = false && admin.setDeployment(...)`
  // 或者在前面 return 掉，字面量照样在文件里，宠物照样开不了
  const dep = serverSrc.match(/\n\s*const solo = admin\.setDeployment\(\{[\s\S]{0,400}?\}\);/);
  ok(dep && /^\s*host,\s*$/m.test(dep[0]) &&
     /shell: !!\(process\.versions\.electron && !process\.env\.ELECTRON_RUN_AS_NODE\)/.test(dep[0]),
     "启动时把部署形态告诉 admin：监听地址 + 是不是 Electron 壳（少了这一行，桌面版永远算「服务器」，宠物又开不了了）",
     dep && dep[0]);
  ok(/const myAgent = prefs\.agentCfg\(config\);/.test(serverSrc), "GET /api/settings 返回的是这个账号自己的那份");
  ok(/const isPlatformOwner = \(req\) => admin\.isSoloDesktop\(\) \|\| ownsGlobalWorkspace\(req && req\.user\);/.test(serverSrc),
     "「他是不是平台管理员」只有一处判定（设置页、档位菜单都读它，别各写各的）");
  ok(/platform_owner: isPlatformOwner\(req\)/.test(serverSrc),
     "而且告诉前端他是不是平台管理员（界面据此决定服务器级的那些控件画不画）");
  // 外面套了一层 lanes.viewFor（顶栏那两条工作线）：它只按当前这条线换 agent.engine，别的一律不动。
  // 这条断言要钉死的是「个人偏好那层不许被工作线绕过去」——写成 engines.resolve(lanes.viewFor(lane, config))
  // 就等于所有人共用一份服务器配置，别人选的模型会跑到你头上。
  ok(/engines\.resolve\(lanes\.viewFor\(lane, prefs\.agentView\(config\)\)\)/.test(agentSrc),
     "agent.js 跑任务时解的是**发起人**选的引擎，不是 config 里那份（工作线只在它外面套一层）");
  ok(/thinking: prefs\.agentCfg\(config\)\.thinking/.test(agentSrc), "思考档同理");
  ok(!/["']\/api\/pet\/["']/.test(fs.readFileSync(path.join(ROOT, "admin.js"), "utf8").split("PERSONAL_WRITE")[0]),
     "/api/pet/ 已经从平台写表里拿掉了（一只宠物出不出现，跟谁掏 API 的钱没关系）");

  console.log("\n【11】启动失败得有出口：桌面上不能「有进程、没界面」");
  // 顺序钉子：__wbBootFail 必须挂在 require("./server.js") 之前。挂晚了，server.js 的 require
  // 一抛异常就直接走 process.exit，主进程当场没了，那个 3 秒兜底亮窗根本轮不到。
  const iHook = mainSrc.indexOf("global.__wbBootFail =");
  const iReq = mainSrc.indexOf('require(path.join(__dirname, "server.js"))');
  ok(iHook > 0 && iReq > 0 && iHook < iReq,
     "electron-main.js 里 __wbBootFail 挂在 require(server.js) 之前", { iHook, iReq });

  // bootFailed 切出来真跑：有壳交回去、没壳退出码 1、壳自己也炸了要兜住
  const bootFailed = new Function("console", "process", slice("server.js", "bootFailed") + "\nreturn bootFailed;")(
    { error: () => {} }, { exit: (c) => { throw new Error("EXIT:" + c); } });
  let got = null;
  global.__wbBootFail = (e) => { got = e; };
  let exited = null;
  try { bootFailed(new Error("boom")); } catch (e) { exited = e.message; }
  ok(got && got.message === "boom", "有桌面壳时，错误交回壳去画窗口", got && got.message);
  eq(exited, null, "  └ 而且不退进程（窗口还要留着显示原因）");
  delete global.__wbBootFail;
  exited = null;
  try { bootFailed(new Error("boom")); } catch (e) { exited = e.message; }
  eq(exited, "EXIT:1", "纯命令行（node server.js）没有壳，维持原来的退出码 1，行为一字不变");
  global.__wbBootFail = () => { throw new Error("壳自己也炸了"); };
  exited = null;
  try { bootFailed(new Error("boom")); } catch (e) { exited = e.message; }
  eq(exited, "EXIT:1", "壳没接住也得退回命令行行为，不能连报错都吞了");
  delete global.__wbBootFail;

  // bootHint：这段文案是「什么都打不开」时用户手里唯一的线索
  const bootHint = new Function(slice("electron-main.js", "bootHint") + "\nreturn bootHint;")();
  ok(/重新下载/.test(bootHint("Cannot find module './engines/index.js'", 3800)),
     "装机包缺文件 → 让用户重下（v0.1.1 缺 engines/ 时用户看到的正是「双击没反应」）");
  const eacces = bootHint("listen EACCES: permission denied 0.0.0.0:3800", 3800);
  ok(/excludedportrange/.test(eacces), "EACCES → 提示 Hyper-V/WSL 预留了端口段，并给出查询命令", eacces.slice(0, 40));
  ok(/换成一个没被预留的/.test(eacces), "  └ 并且告诉他改哪个字段");
  ok(!/被别的程序占了/.test(eacces), "  └ EACCES 不能走成「端口被占用」那条（解法完全不同：一个换端口，一个去关程序）");
  ok(/被别的程序占了/.test(bootHint("listen EADDRINUSE: address already in use", 3800)), "EADDRINUSE → 让他关掉占用的程序");
  ok(/server\.host/.test(bootHint("listen EADDRNOTAVAIL 192.168.1.9", 3800)), "EADDRNOTAVAIL → 让他把 host 改回 127.0.0.1（换过网络之后常见）");
  ok(/issue/.test(bootHint("something exploded", 3800)), "认不出来的错 → 至少让他把这行贴到 issue 里");
  ok(bootHint("listen EACCES", 3810).includes("3810"), "端口号是传进去的那个，不是写死的 3800");
  ok(bootHint(null, 3800).length > 0, "错误对象是空的也得给句人话");

  // 数据目录写不了跟端口用不了都报 EACCES，但一个要换目录、一个要换端口。
  // 混成一条的代价：用户照着改了 server.port，问题原封不动。
  const seedErr = bootHint("EACCES: permission denied, mkdir '/Users/x/OpenWorkBuddy'", 3800);
  ok(/OPENWORKBUDDY_HOME/.test(seedErr), "数据目录建不起来 → 告诉他换一个能写的文件夹", seedErr.slice(0, 30));
  ok(!/excludedportrange|被别的程序占了/.test(seedErr), "  └ 不能滑进端口那两条（照着改 server.port 是白改）");
  ok(/OPENWORKBUDDY_HOME/.test(bootHint("ENOSPC: no space left on device, mkdir '/x'", 3800)), "磁盘满了也归到这条");
  ok(/excludedportrange/.test(bootHint("listen EACCES: permission denied 0.0.0.0:3800", 3800)),
     "  └ 反向：listen EACCES 仍旧走端口那条，没被新分支抢走");
  ok(mainSrc.indexOf("OPENWORKBUDDY_HOME") < mainSrc.indexOf("excludedportrange"),
     "  └ 顺序钉子：数据目录那条写在端口 EACCES 前面（写后面就永远轮不到）");

  // pickBootLog：日志是出事时用户手里唯一的物证，它自己绝不许成为新的错因
  const pickBootLog = new Function("fs", "path", slice("electron-main.js", "pickBootLog") + "\nreturn pickBootLog;")(
    { mkdirSync: (d) => { if (/网络盘/.test(d)) throw new Error("EACCES"); }, statSync: () => ({ size: 0 }), truncateSync: () => {}, appendFileSync: () => {} },
    path);
  eq(pickBootLog(["/网络盘/logs/boot.log", "/tmp/ow.log"]), "/tmp/ow.log", "数据目录写不了就退到临时目录写日志");
  eq(pickBootLog([null, "/tmp/ow.log"]), "/tmp/ow.log", "算路径时就抛了（家目录都读不到）也不影响下一个候选");
  const allDead = new Function("fs", "path", slice("electron-main.js", "pickBootLog") + "\nreturn pickBootLog;")(
    { mkdirSync: () => { throw new Error("nope"); } }, path);
  eq(allDead(["/a/b.log", "/c/d.log"]), null, "哪儿都写不了就返回 null——记不上日志是小事，为此崩掉启动是大事");

  // fatal：启动阶段每一声崩溃都得有出口，这是 issue #1 的正解
  const mkFatal = (over) => {
    const calls = { box: [], exit: [], failure: [] };
    const env = {
      bootLog: () => {}, PAGE_UP: false, FATAL_SHOWN: false, win: null,
      showBootFailure: (e) => calls.failure.push(e),
      dialog: { showErrorBox: (t, b) => calls.box.push(t + "\n" + b) },
      bootHint: () => "照着这句做", PORT: 3800, BOOT_LOG: "/tmp/ow.log",
      app: { isReady: () => true, whenReady: () => Promise.resolve(), exit: (c) => calls.exit.push(c) },
      ...over,
    };
    const keys = Object.keys(env);
    const fn = new Function(...keys, slice("electron-main.js", "fatal") + "\nreturn fatal;")(...keys.map((k) => env[k]));
    return { fatal: fn, calls };
  };
  let f = mkFatal({});
  f.fatal("测试阶段", new Error("boom"));
  eq(f.calls.box.length, 1, "没有窗口时弹系统报错框（它不需要窗口就能显示——这是最后一道出口）");
  ok(/照着这句做/.test(f.calls.box[0]) && /\/tmp\/ow\.log/.test(f.calls.box[0]), "  └ 框里有人话建议，也有日志路径");
  eq(f.calls.exit[0], 1, "  └ 然后退进程，别留一个僵尸进程占着单实例锁");

  f = mkFatal({ win: { isDestroyed: () => false } });
  f.fatal("测试阶段", new Error("boom"));
  eq(f.calls.failure.length, 1, "窗口在就把原因画进窗口（比系统框能写下的多）");
  eq(f.calls.exit.length, 0, "  └ 而且不退进程，窗口还要留着给他看");

  f = mkFatal({ PAGE_UP: true, win: { isDestroyed: () => false } });
  f.fatal("跑起来之后的偶发异常", new Error("boom"));
  eq(f.calls.failure.length + f.calls.box.length + f.calls.exit.length, 0,
     "页面已经加载出来之后再炸，只记日志——不能把用户正在做的事换成一张报错页");

  f = mkFatal({ FATAL_SHOWN: true });
  f.fatal("第二声", new Error("boom"));
  eq(f.calls.box.length, 0, "同一次启动只报一次，别弹一排框");

  // 看门狗 + 成功线：这两条钉住「有进程、没窗口」不可能再沉默
  ok(/const watchdog = setTimeout\(/.test(mainSrc) && /没有可见窗口/.test(mainSrc),
     "有启动看门狗：到点还没有一个亮着的窗口就报错");
  ok(/PAGE_UP = true;[\s\S]{0,120}clearTimeout\(watchdog\)/.test(mainSrc),
     "  └ 页面加载完成就撤掉看门狗（跑起来了就别再自己掐自己）");
  ok(mainSrc.includes('process.on("uncaughtException"') && mainSrc.includes('process.on("unhandledRejection"'),
     "主进程的未捕获异常和未处理 Promise 都接住了（漏一个就又是静默死亡）");
  ok(/unhandledRejection[\s\S]{0,320}if \(!win\) return fatal\(/.test(mainSrc),
     "  └ 但没人接的 Promise 拒绝只在「窗口都还没建出来」时才当启动失败办"
     + "（后台一个 fetch 挂了就把能用的应用换成报错页，那是新的坑）");
  ok(/try \{\s*\n\s*seedDataDir\(\);/.test(mainSrc),
     "seedDataDir 被 try 住了（它在用户家目录建文件夹，公司电脑上真会炸）");
  ok(/if \(SEED_ERR\) return fatal\(/.test(mainSrc), "  └ 而且等窗口建好后把原因交出来，不是吞掉");
  ok(!/http:\/\/localhost:\$\{PORT\}/.test(mainSrc),
     "壳里连的是 127.0.0.1 不是 localhost（localhost 可能解析到 ::1，而服务端只听 IPv4）");
  ok(/OPENWORKBUDDY_DISABLE_GPU/.test(mainSrc) && /disable_gpu/.test(mainSrc),
     "留了关硬件加速的逃生门：显卡画不出窗口时不用改代码也能打开");

  // 端口：壳和服务端必须按同一套优先级算，不然就是「服务端听 A、壳去连 B」——
  // 窗口永远等不到人，用户看到的是一个「启动失败」的弹框，而他只是设了个环境变量。
  const resolvePort = new Function(slice("electron-main.js", "resolvePort") + "\nreturn resolvePort;")();
  eq(resolvePort({ PORT: "3810" }, { server: { port: 3900 } }), 3810,
     "PORT 环境变量说了算（server.js 就是这个优先级；壳以前只读 config，设了 PORT 必然连错端口）");
  eq(resolvePort({}, { server: { port: 3900 } }), 3900, "没设环境变量就听 config.json 的");
  eq(resolvePort({}, null), 3800, "config 读不出来也得有个默认值，不能是 NaN");
  eq(resolvePort({ PORT: "" }, { server: { port: 3900 } }), 3900, "PORT 是空串等于没设，别把 config 顶掉");
  eq(resolvePort({ PORT: "不是数字" }, null), 3800, "PORT 填了句人话也不能算出 NaN（NaN 端口连不上任何东西）");
  ok(/\+process\.env\.PORT \|\| srvCfg\.port \|\| 3800/.test(serverSrc),
     "  └ 反向对照：server.js 那头确实是 env > config > 3800，两边不是各写各的");
}
