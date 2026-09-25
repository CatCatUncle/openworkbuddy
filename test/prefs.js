"use strict";
/**
 * 个人偏好 vs 服务器级设置 —— 那条线画在哪儿，以及它有没有真的接上。
 *
 * 跑法：node test/prefs.js
 * 用临时 OPENWORKBUDDY_DATA_DIR，绝不碰真账号、真偏好、真 config.json。
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
 *   7. 桌面壳退出先问、收尾只走一遍；托盘三条；窗口记忆遇到坏文件、拔掉的屏照样开得出来（【11c】）
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-prefs-"));
process.env.OPENWORKBUDDY_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });

const express = require("express");
const ROOT = path.join(__dirname, "..");
const srcLib = require("./lib/src"); // server / tools / canvas 三组源码的唯一读法，见 test/lib/src.js
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

const PREFS_DIR = path.join(process.env.OPENWORKBUDDY_DATA_DIR, "prefs");
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
console.log("\n【4】读写：缓存要带 mtime 校验（命令行 openworkbuddy 是另一个进程，多开的窗口也是）");

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
// 偏好文件坏了。老写法是 catch { data = {} }：坏一个字节就当「这人从没配过」，
// 而下一次切个引擎、拖下滑块，write() 就把这份空的合并着写回去——引擎、快捷键、宠物开关
// 一起没了，全程一句提示都没有。现在走 store：先拿旁边那份 .bak 把人救回来。
fs.writeFileSync(f, "{ 这不是 JSON");
fs.utimesSync(f, new Date(Date.now() + 4000), new Date(Date.now() + 4000));
const recovered = prefs.read(U);
// .bak 是上一次**经程序**存盘时留下的那份（刚才那次是测试直接 writeFileSync 伪造的，绕过了 store，
// 所以 .bak 里仍是 codex 那一版）。救回来的正是它——比「当这人没配过」强太多了。
eq(recovered.agent && recovered.agent.engine, "codex",
   "偏好文件坏了先从 .bak 救回来，不是当「这人没配过」（当没配过的话，他下一次保存就把自己的设置抹干净了）");
ok(recovered.pet && recovered.pet.enabled === true, "  └ 另一棵子树也跟着回来了，不是只剩个空壳");
eq(recovered.agent && recovered.agent.thinking, undefined,
   "  └ 少的只是最后一次改动（.bak 天生落后一版）——store 的提示里就是这么说的，用户知道该去补哪一下");
// ★反向对照★：.bak 也坏了才认栽。这条要是没有，上面两条在「读坏文件直接抛」的实现下也能过
fs.writeFileSync(f + ".bak", "这份也坏了");
fs.writeFileSync(f, "{ 还是不是 JSON");
fs.utimesSync(f, new Date(Date.now() + 6000), new Date(Date.now() + 6000));
eq(Object.keys(prefs.read(U)).length, 0, ".bak 也坏了就从空的重来——记不上偏好是小事，为此把整台服务器带崩是大事");
ok(fs.readdirSync(path.dirname(f)).some((n) => n.startsWith(path.basename(f) + ".corrupt")),
   "  └ 坏的那份改名留在旁边（用户还有机会自己捞回来），不是直接删掉");
// 写也得是原子的：偏好是被高频写的（切引擎、拖透明度滑块都写一次），
// writeFileSync 那一刻断电或者被 kill，下次读到的就是半份 JSON
ok(/jsonStore\.writeJsonAtomic\(file, next/.test(fs.readFileSync(path.join(ROOT, "prefs.js"), "utf8")),
   "prefs.write 走原子写 + 留 .bak（上面那条自愈路，靠的就是这份 .bak）");
ok(!/fs\.writeFileSync\(file/.test(fs.readFileSync(path.join(ROOT, "prefs.js"), "utf8")),
   "  └ 反向对照：prefs.js 里没有直接 writeFileSync 的后门");
fs.rmSync(f, { force: true }); // 上一步隔离时已经把它改名搬走了，这里只是确保它确实不在
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

/**
 * 把这台机器临时缩回「只有老板一个账号」，跑完原样放回去。
 *
 * 「个人桌面版」这个身份现在是三个条件与起来的：Electron 壳 + 只听本机 + 这台机器上只有一个账号。
 * 前两个条件下面用 setDeployment 摆，第三个得真去动账号表——因为它判的就是账号表。
 */
function 只剩一个账号(fn) {
  const st = account._internals.loadUsers();
  const 全部 = st.users;
  st.users = 全部.slice(0, 1);
  account._internals.saveUsers(st);
  try { return fn(); } finally { st.users = 全部; account._internals.saveUsers(st); }
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

  // 「个人桌面版」拆墙的前提是「屏幕前就这一个人」。壳装在本机、只听 127.0.0.1 —— 这两条
  // 还不够：同一台 Mac 上开了两个账号，这话就不成立了，拆了墙等于小张能改老板的 Key 和 MCP。
  // 用户的原话是「怎么切换账号了我的宠物设置还有什么通信渠道这些设置还是没有变的啊」——
  // 就是这儿塌的：两个人共用一份 config.json。
  admin.setDeployment({ shell: true, host: "127.0.0.1" });
  r = await call("POST", "/api/settings", { cookie: zhang, body: { models: [{ name: "x", model: "y" }] } });
  eq(r.status, 403, "壳 + 本机，但机器上有两个账号：墙不许拆（这是用户报的那个串台）");
  r = await call("GET", "/api/settings", { cookie: zhang });
  eq(r.json.search.jina_key, "", "  └ 脱敏也照旧，成员读不到别人的 Key");

  // 缩回一个账号：这才是出厂就装一份、自己一个人用的那台机器，一切照旧
  await 只剩一个账号(async () => {
    admin.setDeployment({ shell: true, host: "127.0.0.1" }); // 重新判一次账号数
    r = await call("POST", "/api/settings", { cookie: boss, body: { models: [{ name: "x", model: "y" }] } });
    eq(r.status, 200, "桌面版（真就一个账号）：没有「平台管理员」这回事，服务器级设置也能改");
    // 两个开关必须一起松。只松一半的话，界面把 Key 显示成空，用户随手点一下保存就把真 Key 抹了
    r = await call("GET", "/api/settings", { cookie: boss });
    eq(r.json.search.jina_key, "REAL-JINA-KEY", "同一趟里脱敏也必须跟着关（否则一存就把真 Key 抹成空）");
    eq(r.json.models[0].api_key, "REAL-MODEL-KEY", "模型的 Key 同样是真值");
  });
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

  // 桌面版短路：只有一个账号时那边一切照旧落 config.json，就算偏好文件在也不该被读
  admin.setDeployment({ shell: true, host: "127.0.0.1" });
  r = await call("GET", "/api/prefs-probe", { cookie: zhang });
  eq(r.json.engine, "claude-code", "壳 + 本机，但有两个账号：偏好照读，小张看到的还是他自己选的引擎");
  eq(r.json.pet.scale, 1.5, "  └ 宠物缩放也是他自己的（用户报的「切换账号宠物设置没变」就是这条）");
  r = await call("GET", "/api/prefs-probe", { cookie: boss });
  eq(r.json.engine, "builtin", "  └ 同一台机器上老板看到的仍是他自己那份，没被小张的偏好带跑");
  await 只剩一个账号(async () => {
    admin.setDeployment({ shell: true, host: "127.0.0.1" });
    r = await call("GET", "/api/prefs-probe", { cookie: boss });
    eq(r.json.engine, "builtin", "桌面版（真就一个账号）：不读偏好文件，一切照旧看 config（壳在任何人登录之前就靠 config 装宠物和快捷键）");
    eq(r.json.sameObject, true, "  └ 也不白复制一份视图出来");
  });
  admin.setDeployment({ shell: false, host: "0.0.0.0" });

  console.log("\n【9】没有请求上下文的地方（定时任务 / IM / 命令行 openworkbuddy）必须回落到 config");
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
  await runSourcePins();
  await runShellLifecycle();
  runConfigGates();
  runSeedCopy();
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
  const group = { "server.js": "server", "tools.js": "tools" }[file];
  const src = group ? srcLib.src(group) : fs.readFileSync(path.join(ROOT, file), "utf8");
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${file} 里找不到函数 ${name}`);
  const j = src.indexOf("\n}\n", i);
  if (j < 0) throw new Error(`${file} 里 ${name} 没有以顶格 } 结尾，切不出来`);
  return src.slice(i, j + 3);
}

/**
 * 铺出厂内容那一下：拷得对，而且别把盘写满。
 *
 * seedDataDir 每铺一个新数据目录都要把 skills/ 整份拷过去。本机装了几个第三方技能之后
 * 这一份是 189M，装机用户首次启动就得干等它落盘；更凶的是端到端测试——每个用例起一个
 * 新 HOME，一轮几十个用例约 7.5G 白写，攒几十轮就是上百 G，磁盘报到 99% 才被发现。
 *
 * 所以 paths.js 的 copyTree 在 macOS 上走 APFS 的 clonefile（cp -c）：写时复制，两边
 * 各是各的文件，底下共享数据块。这一节钉三件事，缺一件这个优化就是个定时炸弹：
 *
 *   1. 拷出来的东西必须一模一样（嵌套目录、空目录、内容）；
 *   2. 写时复制的语义必须真的是「拷贝」——改哪边都不许串到对面；
 *   3. 真省盘。这条用 df 量真占用，不用 du：du 看不见 clone 的共享块，量出来是满的。
 *      同一轮里拿 fs.cpSync 当负向对照，证明这个量法看得见占盘，不是量什么都是 0。
 */
function runSeedCopy() {
  console.log("\n【铺出厂内容】拷得对，而且别把盘写满");
  const cp = require("child_process");
  const paths = require("../paths");
  const copyTree = paths._copyTree;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-seedcopy-"));
  try {
    // ---- 1. 拷得对 ----
    const src = path.join(root, "src");
    fs.mkdirSync(path.join(src, "nested", "deep"), { recursive: true });
    fs.mkdirSync(path.join(src, "空目录"), { recursive: true });
    fs.writeFileSync(path.join(src, "SKILL.md"), "出厂那一份");
    fs.writeFileSync(path.join(src, "nested", "deep", "a.txt"), "深处那个文件");
    const dst = path.join(root, "dst");
    copyTree(src, dst);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? [e.name + "/"].concat(walk(path.join(d, e.name)).map((s) => e.name + "/" + s)) : [e.name]).sort();
    ok(JSON.stringify(walk(src)) === JSON.stringify(walk(dst)),
      "整棵树原样拷过去（嵌套目录、空目录一个不少）", { src: walk(src), dst: walk(dst) });
    eq(fs.readFileSync(path.join(dst, "nested", "deep", "a.txt"), "utf8"), "深处那个文件",
      "  └ 深处那个文件内容也对");

    // ---- 2. 写时复制的语义必须就是「拷贝」----
    // 这条是这个优化最要命的地方：clonefile 底下共享数据块，万一哪天换成 hardlink 之类的
    // 写法，改用户那份就会把包里的出厂原件一起改了，而且要等到下次升级才看得出来。
    fs.writeFileSync(path.join(dst, "SKILL.md"), "用户自己改过的");
    eq(fs.readFileSync(path.join(src, "SKILL.md"), "utf8"), "出厂那一份",
      "改副本不会串回原件（要是串了，用户一改技能就把包里的出厂版改了）");
    fs.writeFileSync(path.join(src, "SKILL.md"), "升级后的新版");
    eq(fs.readFileSync(path.join(dst, "SKILL.md"), "utf8"), "用户自己改过的",
      "改原件也不会串到副本（要是串了，升一次级用户的改动就没了）");

    // ---- 3. 真省盘：df 量真占用 ----
    const free = () => Number(cp.execFileSync("df", ["-k", root], { encoding: "utf8" })
      .split("\n")[1].split(/\s+/)[3]);
    const big = path.join(root, "big");
    fs.mkdirSync(big);
    const BUF = Buffer.alloc(8 * 1024 * 1024, 7);
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(big, "f" + i + ".bin"), BUF); // 48M
    try { cp.execFileSync("sync"); } catch {}
    // 量三次取最好的一次。df 量的是整块盘的空闲，不是这棵树的占用——同一台机器上别的进程
    // （前一个用例留下的 Electron 还在往缓存里写、系统自己的日志）随时会在这几十毫秒的窗口里
    // 写进几十 M。一次量出来 50M，分不清是「clone 没生效」还是「别人在写」；连量三次回回超标，
    // 才是真没生效——噪声不会三次都恰好落在这个窗口里，而退回了 cpSync 的 clone 三次都是 48M。
    // v0.9.0 就是这么在标签流水线上挂的：同一个 commit、同一种机器，push 那条绿、标签那条红，
    // 量出来 clone 50.1M 比普通拷贝 48M 还大——多出来那 2M 是别人的字节，那 48M 也是。
    const tries = [];
    let best = null;
    for (let i = 0; i < 3; i++) {
      const a = free();
      copyTree(big, path.join(root, "big-clone-" + i));
      const b = free();
      fs.cpSync(big, path.join(root, "big-plain-" + i), { recursive: true }); // 负向对照
      const c = free();
      const t = { cloneMB: (a - b) / 1024, plainMB: (b - c) / 1024 };
      tries.push(t);
      // 两条都站住才算量准了：普通拷贝量得出实打实的占用，clone 又明显比它小
      if (t.plainMB > 24 && t.cloneMB < t.plainMB / 4) { best = t; break; }
      // 两次量之间让盘歇一下：刚才那个写 50M 的家伙，多半几百毫秒就写完了
      try { cp.execFileSync("sync"); } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
    const { cloneMB, plainMB } = best || tries[tries.length - 1];
    // 负向对照先站住：普通拷贝必须量得出实打实的占用，否则下面那条是靠「量法坏了」变绿的
    ok(plainMB > 24, "负向对照：普通拷贝 48M 真占掉了 " + plainMB.toFixed(1) + "M（量法看得见占盘）",
      { tries });
    if (process.platform === "darwin") {
      ok(cloneMB < plainMB / 4, "clone 只占 " + cloneMB.toFixed(1) + "M，不到普通拷贝的四分之一"
        + (tries.length > 1 ? "（量了 " + tries.length + " 次才量准，前几次有别的进程在写盘）" : ""),
        { tries });
    } else {
      console.log("  - 跳过省盘那条：clonefile 是 APFS 的本事，这台不是 macOS");
    }

    // ---- 4. 退路：不是 macOS 也得拷得对 ----
    // 直接把 platform 改成 linux 再重新加载一次 paths.js，走的就是 fs.cpSync 那条路。
    // 不测这条的话，Windows 用户首次启动技能一个都铺不出来，而我们本机永远看不见。
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    delete require.cache[require.resolve("../paths")];
    try {
      const fallbackDst = path.join(root, "dst-linux");
      require("../paths")._copyTree(src, fallbackDst);
      ok(fs.readFileSync(path.join(fallbackDst, "nested", "deep", "a.txt"), "utf8") === "深处那个文件",
        "不是 macOS 时退回 fs.cpSync，照样拷得对（退回的是慢，不是错）");
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
      delete require.cache[require.resolve("../paths")];
      require("../paths");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function runSourcePins() {
  const serverSrc = srcLib.src("server");
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
  // 这条断言要钉死的是「个人偏好那层不许被绕过去」——写成 engines.resolve(config) 就等于
  // 所有人共用一份服务器配置，别人选的模型会跑到你头上。
  ok(/engines\.resolve\(prefs\.agentView\(config\)\)/.test(agentSrc),
     "agent.js 跑任务时解的是**发起人**选的引擎，不是 config 里那份");
  // 反向对照：工作线（办公 / 工程）不许再插手引擎。曾经这里套过一层 lanes.viewFor(lane, …)，
  // 后果是切个标签就把别人配的模型换掉了——服务器上两个人共用一份配置时，这是实打实的越权。
  ok(!/lanes\.viewFor|lanes\.engineIdFor|CLI_FALLBACK/.test(agentSrc),
     "agent.js 里没有「按工作线换引擎」那层（切标签不许动引擎）");
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

  // 壳自己那本字典（中英各一份）。下面这些断言量的是中文那本的措辞——
  // 英文那本翻没翻全、有没有人又把界面上的字写死回代码里，归 e2e 的 testShellI18n 管。
  const SHELL_TEXT = new Function(mainSrc.slice(
    mainSrc.indexOf("const SHELL_TEXT = {"), mainSrc.indexOf("\nfunction osLang(")
  ).replace("const SHELL_TEXT =", "return") + ";")();
  const zhText = SHELL_TEXT.zh;
  ok(zhText && zhText.hintMissingFiles, "electron-main.js 里抠不出 SHELL_TEXT.zh");

  // bootHint：这段文案是「什么都打不开」时用户手里唯一的线索
  const bootHintRaw = new Function(slice("electron-main.js", "bootHint") + "\nreturn bootHint;")();
  const bootHint = (msg, port) => String(bootHintRaw(msg, port, zhText));
  ok(/重新下载/.test(bootHint("Cannot find module './engines/index.js'", 3800)),
     "装机包缺文件 → 让用户重下（v0.1.1 缺 engines/ 时用户看到的正是「双击没反应」）");
  const eacces = bootHint("listen EACCES: permission denied 0.0.0.0:3800", 3800);
  ok(/excludedportrange/.test(eacces), "EACCES → 提示 Hyper-V/WSL 预留了端口段，并给出查询命令", eacces.slice(0, 40));
  ok(/换成一个没被预留的/.test(eacces), "  └ 并且告诉他改哪个字段");
  ok(!/占了|占着/.test(eacces), "  └ EACCES 不能走成「端口被占用」那条（解法完全不同：一个换端口，一个去关程序）");
  // 钉的是这句话里有没有那两条出路，不是它的措辞——文案改一个字就变红的尺子量不出任何东西。
  // （能走到这条提示已经很稀罕了：本机版被占会自己往后换口，见 server.js 的 listenWithFallback。）
  const inuse = bootHint("listen EADDRINUSE: address already in use", 3800);
  ok(/占/.test(inuse) && /关掉/.test(inuse) && /server\.port/.test(inuse),
     "EADDRINUSE → 得说清楚口被占了，并给出「关掉占用的程序」和「改 server.port」两条出路", inuse.slice(0, 40));
  ok(inuse !== eacces, "  └ 跟 EACCES 那条不是同一句话（合并成一句就等于把两种解法混成一种）");
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
  // 顺序钉子得钉在分支上。措辞搬进字典之后，再拿 OPENWORKBUDDY_HOME / excludedportrange
  // 在整份源码里比先后，量到的是字典里两条的排版顺序——跟哪个分支先判没有关系。
  const hintBody = slice("electron-main.js", "bootHint");
  ok(hintBody.indexOf("hintDataDir") < hintBody.indexOf("hintPortDenied"),
     "  └ 顺序钉子：数据目录那条写在端口 EACCES 前面（写后面就永远轮不到）");

  // bootAdvice：开机闸门已经查出病因的三种死法，页面上不许再去猜。
  // 闸门给的是中文人话（「依赖还没装…跑一次 npm install」），bootHint 认的是 Cannot find module、
  // EADDRINUSE 这些英文报错——一条都对不上，于是最知道该怎么修的三种情况，
  // 启动失败页的大标题全是「服务端启动时崩了，把这行贴到 issue 里」。
  const bootAdviceRaw = new Function("bootHint",
    slice("electron-main.js", "bootAdvice") + "\nreturn bootAdvice;")(bootHintRaw);
  const bootAdvice = (err, msg, port) => String(bootAdviceRaw(err, msg, port, zhText));
  const bc = require(path.join(ROOT, "boot-check"));
  for (const [what, facts, want] of [
    ["Node 太老", { nodeVersion: "v16.20.2", missingDeps: [] }, /nodejs\.org|nvm/],
    ["源码版依赖没装", { nodeVersion: "v20.0.0", missingDeps: ["express"] }, /npm install/],
    ["装机版缺文件", { nodeVersion: "v20.0.0", missingDeps: ["express"], packaged: true }, /重新下载|Releases/],
  ]) {
    const p = bc.bootProblem(facts);
    const err = Object.assign(new Error(p.title + " " + p.fix), { bootProblem: p });
    const said = bootAdvice(err, err.message, 3800);
    ok(want.test(said), `★启动失败页·${what}：写的是该怎么修★ 闸门已经知道了，页面上不许再写「去提 issue」`, said.slice(0, 50));
    ok(!/贴到 GitHub issue/.test(said), `  └ ${what}：不许滑进「认不出来」那条兜底`);
  }
  // 反向对照：闸门没查出来的错（真崩了），照旧走 bootHint 那套猜
  ok(/excludedportrange/.test(bootAdvice(new Error("listen EACCES: permission denied 0.0.0.0:3800"), "listen EACCES: permission denied 0.0.0.0:3800", 3800)),
     "反向对照：不是闸门查出来的错，照旧按报错文本分诊（端口那条一字未动）");
  ok(/issue/.test(bootAdvice(new Error("something exploded"), "something exploded", 3800)),
     "反向对照：真认不出来的还是让他贴 issue");
  // 先验料：不接上 bootProblem 的话，这三条确实全滑到兜底去——证明上面那几条测的是真东西
  const bare = bc.bootProblem({ nodeVersion: "v16.20.2", missingDeps: [] });
  ok(/贴到 GitHub issue/.test(bootHint(bare.title + " " + bare.fix, 3800)),
     "先验料：光凭闸门那句中文，bootHint 认不出来（这正是这组断言要挡的东西）");
  ok(/err\.bootProblem/.test(fs.readFileSync(path.join(ROOT, "boot-check.js"), "utf8")),
     "闸门得把判据挂在错误上，壳那头才接得住");

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
      bootLog: () => {}, PAGE_UP: false, FATAL_SHOWN: false, QUIT_STATE: "", win: null,
      showBootFailure: (e) => calls.failure.push(e),
      dialog: { showErrorBox: (t, b) => calls.box.push(t + "\n" + b) },
      bootHint: () => "照着这句做", bootAdvice: (e, m, p) => (e && e.bootProblem ? e.bootProblem.fix : "照着这句做"),
      T: () => zhText, osLang: () => "zh",
      PORT: 3800, BOOT_LOG: "/tmp/ow.log",
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
  // 没有窗口那条路（Windows 上「双击没反应」的正解）也得走同一套话：
  // 系统报错框是这时候唯一的出口，在它里面写「去提 issue」而不是「跑一次 npm install」，
  // 等于把已经查出来的病因又埋回去
  f = mkFatal({});
  f.fatal("测试阶段", Object.assign(new Error("依赖还没装"), { bootProblem: { title: "依赖还没装（找不到 express）。", fix: "在项目目录里跑一次 npm install。" } }));
  ok(/npm install/.test(f.calls.box[0]),
     "★系统报错框里也是闸门那句该怎么修★ 没有窗口的时候，这个框是唯一的出口", f.calls.box[0]);
  ok(!/照着这句做/.test(f.calls.box[0]), "  └ 没有绕回去猜（猜出来的那句在这儿是错的）");
  // 启动到一半他点了关窗：窗口一销毁，还没跑完的启动流程撞上死窗口抛错，又走到这里
  for (const st of ["closing", "done"]) {
    f = mkFatal({ QUIT_STATE: st });
    f.fatal("桌面窗口初始化", new Error("Object has been destroyed"));
    ok(f.calls.box.length === 0 && f.calls.exit.length === 0 && f.calls.failure.length === 0,
       `已经在退了（${st}）：不再弹「启动失败」吓人，退出那条路自己会走完`, f.calls);
  }

  // 启动失败页那张真页面：大标题写该怎么修，下面红框里只放结论。
  // 红框里再把解法原样重复一遍，等于同一句话读两遍，而红色的等宽字看着就像「又一条报错」
  const mkPage = (over) => {
    const seen = { url: "" };
    const env = {
      bootAdvice: (e, m, p) => (e && e.bootProblem ? e.bootProblem.fix : "猜出来的那句"),
      bootHint: () => "猜出来的那句", PORT: 3800, BOOT_LOG: "/tmp/ow.log",
      T: () => zhText, osLang: () => "zh",
      win: { isDestroyed: () => false, loadURL: (u) => { seen.url = u; }, show: () => {}, focus: () => {} },
      fatal: () => {}, FATAL_SHOWN: false,
      dataPath: (f) => "/家/OpenWorkBuddy/" + f,
      require: (id) => (id === "./package.json" ? { version: "9.9.9" } : require(id)),
      ...(over || {}),
    };
    const keys = Object.keys(env);
    const fn = new Function(...keys, slice("electron-main.js", "showBootFailure") + "\nreturn showBootFailure;")(...keys.map((k) => env[k]));
    return { show: fn, seen };
  };
  {
    const { show, seen } = mkPage();
    show(Object.assign(new Error("依赖还没装（找不到 express）。 在项目目录里跑一次 npm install。"),
      { bootProblem: { title: "依赖还没装（找不到 express）。", fix: "在项目目录里跑一次 npm install。" } }));
    const page = decodeURIComponent(seen.url.replace(/^data:text\/html;charset=utf-8,/, ""));
    const big = (page.match(/<p>([^<]*)<\/p>/) || [])[1] || "";
    const box = (page.match(/<pre>([\s\S]*?)<\/pre>/) || [])[1] || "";
    ok(/npm install/.test(big), "★启动失败页的大标题就是该怎么修★", big);
    ok(/找不到 express/.test(box), "  └ 红框里放的是结论（缺了谁）", box);
    ok(!/npm install/.test(box), "★解法不在红框里重复第二遍★ 红色等宽字看着像又一条报错，而它其实是解法", box);
  }
  {
    // 反向对照：不是闸门查出来的错，红框里照旧是原始报错——那才是贴 issue 时要的物证
    const { show, seen } = mkPage();
    show(new Error("listen EADDRINUSE: address already in use"));
    const page = decodeURIComponent(seen.url.replace(/^data:text\/html;charset=utf-8,/, ""));
    ok(/EADDRINUSE/.test((page.match(/<pre>([\s\S]*?)<\/pre>/) || [])[1] || ""),
       "反向对照：真崩了的时候，红框里还是原始报错（贴 issue 要的就是它）");
  }
  {
    // 显卡那条建议要他去改一个文件，那就得把文件在哪说清楚
    const { show, seen } = mkPage();
    show(new Error("boom"));
    const page = decodeURIComponent(seen.url.replace(/^data:text\/html;charset=utf-8,/, ""));
    ok(/\/家\/OpenWorkBuddy\/config\.json/.test(page),
       "★显卡那条建议给的是 config.json 的真实路径★ 写「用户目录的 …」等于让卡在门外的人自己猜用户目录在哪");
  }
  {
    // 算不出路径也不能崩在这一页上——它是最后一块告示牌了
    const { show, seen } = mkPage({ dataPath: () => { throw new Error("数据目录都没建起来"); } });
    show(new Error("boom"));
    const page = decodeURIComponent(seen.url.replace(/^data:text\/html;charset=utf-8,/, ""));
    ok(/OpenWorkBuddy\/config\.json/.test(page) && !/undefined/.test(page),
       "  └ 反向对照：连数据目录都没建起来时退回一句话，不是 undefined、更不是连这页都炸掉");
  }

  // 启动失败页得是能用的一页，不只是好看的一页。
  //
  // 右键菜单和「外链交给系统浏览器」这两根线，原来挂在 require("./server.js") 后面。
  // 可启动失败时那一句 require 就是抛出点——它一抛，后面一行都不会执行，于是恰恰在
  // 最需要复制粘贴的那一页上，右键按下去什么都没有：页面写着「把这行贴到 issue 里」
  // 「贴 issue 时带上启动日志」，而那串路径只能手抄。「提 issue」那个链接也一样，
  // 没挂 openHandler 的话它在应用里另开一个没有地址栏、没有登录态的 Electron 窗口。
  // 这是这个文件里第三次栽在同一件事上（前两次是 3 秒兜底亮窗和 20 秒看门狗），所以钉住顺序。
  const wiredBeforeRequire = (src) => {
    const menu = src.indexOf("attachContextMenu(win.webContents)");
    const open = src.indexOf("win.webContents.setWindowOpenHandler(openHandler)");
    const req = src.indexOf('require(path.join(__dirname, "server.js"))');
    return menu > -1 && open > -1 && req > -1 && menu < req && open < req;
  };
  ok(wiredBeforeRequire(mainSrc),
     "★右键菜单和外链跳转都挂在 require 服务端之前★ 挂在后面的话，启动失败页上右键弹不出「复制」");
  ok(!wiredBeforeRequire('require(path.join(__dirname, "server.js"));\nwin.webContents.setWindowOpenHandler(openHandler);\nattachContextMenu(win.webContents);'),
     "  └ 反向对照：把顺序倒过来，这条断言得挂（证明它真在看先后，不是在看有没有）");

  // 挂上了还得真弹得出东西——只证明「调用排在前面」不等于那一页上右键有用
  const mkMenu = () => {
    const popped = [];
    const env = {
      Menu: { buildFromTemplate: (items) => ({ popup: () => popped.push(items) }) },
      BrowserWindow: { fromWebContents: () => ({}) },
      clipboard: { writeText: () => {} },
      shell: { openExternal: () => {} },
      // 菜单上的字出自哪本字典是 e2e testShellI18n 的事；这儿钉的是「右键到底弹不弹得出东西」
      T: () => zhText,
      uiLang: async () => "zh",
      contextMenuItems: new Function("clipboard", "shell",
        slice("electron-main.js", "contextMenuItems") + "\nreturn contextMenuItems;")({ writeText: () => {} }, { openExternal: () => {} }),
    };
    const keys = Object.keys(env);
    const attach = new Function(...keys,
      slice("electron-main.js", "attachContextMenu") + "\nreturn attachContextMenu;")(...keys.map((k) => env[k]));
    let fire = null;
    attach({ on: (ev, fn) => { if (ev === "context-menu") fire = fn; }, copyImageAt: () => {}, isDestroyed: () => false });
    // 弹之前要先问一句界面语言，这一问是异步的——同步读 popped 永远是空的
    return async (params) => { popped.length = 0; await fire(null, params); return popped[0] || null; };
  };
  {
    const fire = mkMenu();
    const picked = (await fire({ selectionText: "依赖还没装（找不到 express）。" })) || [];
    ok(picked.some((it) => it.role === "copy"),
       "★选中启动失败页上的字，右键弹得出「复制」★ 让一个刚被挡在门外的人手抄报错，等于没给出路",
       JSON.stringify(picked));
    const link = (await fire({ selectionText: "", linkURL: "https://github.com/CatCatUncle/openworkbuddy/issues" })) || [];
    ok(link.some((it) => /在浏览器里打开/.test(it.label || "")),
       "  └ 那一页上的「提 issue」右键能直接丢给系统浏览器（不是在应用里另开一个没地址栏的窗）",
       JSON.stringify(link));
    eq(await fire({ selectionText: "" }), null,
       "  └ 反向对照：什么都没选中时不弹一个空菜单（证明上面两条是真判出来的）");
  }

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
  // 以前这是两份实现（壳一份、服务端一份），靠这条测试盯着别漂。盯不住：两份里
  // 都藏着同一个 bug，而两份都错成一样，"两边一致"照样是绿的。现在合成 paths.js 一份，
  // 这里验的就从「两份算得一样吗」变成「两边用的是不是同一份」——那才是漂不了的写法。
  const { resolvePort } = require(path.join(ROOT, "paths.js"));
  eq(resolvePort({ PORT: "3810" }, { server: { port: 3900 } }), 3810,
     "PORT 环境变量说了算（壳以前只读 config，设了 PORT 必然连错端口）");
  eq(resolvePort({}, { server: { port: 3900 } }), 3900, "没设环境变量就听 config.json 的");
  eq(resolvePort({}, null), 3800, "config 读不出来也得有个默认值，不能是 NaN");
  eq(resolvePort({ PORT: "" }, { server: { port: 3900 } }), 3900, "PORT 是空串等于没设，别把 config 顶掉");
  eq(resolvePort({ PORT: "不是数字" }, null), 3800, "PORT 填了句人话也不能算出 NaN（NaN 端口连不上任何东西）");
  // PORT=0 是操作系统的老规矩：「你替我挑一个空的」。老写法是 `+env.PORT || cfg…`，
  // 而 +"0" 是 0、是假值，于是显式设的 0 被当成没设，悄悄回落到 3800 —— 本机正跑着一台的时候
  // 就直接撞上用户自己那台了（端到端测试里五处真起 server 全栽在这儿）。判据是「设没设」，不是「真不真」。
  eq(resolvePort({ PORT: "0" }, { server: { port: 3900 } }), 0, "PORT=0 是「让内核挑一个空的」，不是「没设」");
  eq(resolvePort({ PORT: "65535" }, null), 65535, "端口上界 65535 收");
  eq(resolvePort({ PORT: "65536" }, { server: { port: 3900 } }), 3900, "越界的端口号当没设，不往下传一个连不上的数");
  eq(resolvePort({ PORT: "-1" }, null), 3800, "负数同理");
  // ★反向对照★：真正要防的不是「算得不一样」，是「又各写各的」。
  ok(/require\("\.\/paths"\)/.test(mainSrc) && /\bresolvePort\b/.test(mainSrc) && !/function resolvePort/.test(mainSrc),
     "  └ 壳用的是 paths.js 那一份，自己没再写一个");
  ok(/require\("\.\/paths"\)/.test(serverSrc) && /const port = resolvePort\(process\.env, config\)/.test(serverSrc)
     && !/function resolvePort/.test(serverSrc),
     "  └ 服务端也是那一份，自己没再写一个（这是两边不会漂的唯一理由）");

  console.log("\n【11b】界面卡死 / 进程没了：问他一句，不替他挑，也不连累后台");
  // 以前 Electron 默认什么都不做：进程没了窗口一片白，卡死了一直转圈，只能强退整个应用——
  // 服务端和后台任务都在主进程里，强退连它们一起带走。这里验 attachCrashGuard 切出来真跑。
  const CRASH_KEYS = ["hungTitle", "hungDetail", "goneTitle", "goneDetail", "reasonLabel", "reloadBtn", "waitBtn", "laterBtn"];
  for (const k of CRASH_KEYS) {
    const zh = SHELL_TEXT.zh[k], en = SHELL_TEXT.en && SHELL_TEXT.en[k];
    ok(typeof zh === "string" && zh.trim() && typeof en === "string" && en.trim(),
       `SHELL_TEXT.${k} 中英两本都有（缺一本，那个语言的用户看到的是 undefined）`, { zh, en });
    ok(typeof en === "string" && !/[㐀-鿿]/.test(en) && en !== zh, `  └ ${k} 的英文那本真是英文，不是把中文抄过去`, en);
  }
  eq(SHELL_TEXT.zh.reloadBtn, "重新加载", "按钮就叫「重新加载」");
  eq(SHELL_TEXT.zh.waitBtn, "再等等", "  └ 另一颗叫「再等等」");

  const mkGuard = (over) => {
    const boxes = [], logs = [], timers = [];
    const handlers = {};
    const wc = {
      reloads: 0, kills: 0,
      on: (ev, fn) => { handlers[ev] = fn; },
      reload: () => { wc.reloads++; },
      forcefullyCrashRenderer: () => { wc.kills++; },
    };
    const w = { webContents: wc, isDestroyed: () => false };
    const env = {
      // 假的系统弹框：谁按了哪颗由测试说了算；收框（signal）照 Electron 的规矩当成按了 cancelId
      dialog: { showMessageBox: (parent, opts) => new Promise((resolve) => {
        const box = { parent, opts, aborted: false, answer: (response) => resolve({ response }) };
        if (opts.signal) opts.signal.addEventListener("abort", () => { box.aborted = true; resolve({ response: opts.cancelId }); });
        boxes.push(box);
      }) },
      T: (l) => SHELL_TEXT[l === "en" ? "en" : "zh"], osLang: () => "zh", LAST_UI_LANG: "",
      bootLog: (s) => logs.push(String(s)),
      uiLang: async () => "zh",
      setTimeout: (fn, ms) => { const t = { fn, ms, unref: () => {} }; timers.push(t); return t; },
      clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
      ...(over || {}),
    };
    const keys = Object.keys(env);
    new Function(...keys, slice("electron-main.js", "attachCrashGuard") + "\nreturn attachCrashGuard;")(...keys.map((k) => env[k]))(w);
    const fire = (ev, details) => handlers[ev] && handlers[ev]({}, details);
    const tick = () => new Promise((r) => setImmediate(r));
    return { w, wc, boxes, logs, timers, fire, tick, handlers };
  };
  {
    const g = mkGuard();
    ok(["unresponsive", "responsive", "render-process-gone"].every((ev) => typeof g.handlers[ev] === "function"),
       "卡死、缓过来、进程没了三个事件都接上了", Object.keys(g.handlers));
    g.fire("unresponsive");
    g.fire("unresponsive");
    eq(g.boxes.length, 1, "卡死弹一个框；连着报两次卡死也只挂一个框");
    const b = g.boxes[0];
    eq(b.parent, g.w, "  └ 框挂在主窗口上（macOS 上没有父窗口，收框那一下不起作用）");
    eq(b.opts.message, SHELL_TEXT.zh.hungTitle, "  └ 标题说的是「没响应了」");
    eq(JSON.stringify(b.opts.buttons), JSON.stringify(["重新加载", "再等等"]), "  └ 两颗按钮：重新加载 / 再等等（两条都给，不替他挑）");
    eq(b.opts.buttons[b.opts.defaultId], "再等等", "  └ 回车默认是「再等等」：不丢东西的那条");
    b.answer(1);
    await g.tick();
    eq(g.wc.reloads + g.wc.kills, 0, "选了再等等：什么都不动");
    eq(g.timers.length, 1, "  └ 但记着 30 秒后再看一眼");
    eq(g.timers[0] && g.timers[0].ms, 30000, "  └ 间隔是 30 秒");
    g.timers.shift().fn();
    eq(g.boxes.length, 2, "30 秒后还卡着，再问一次");
    g.fire("responsive");
    await g.tick();
    ok(g.boxes[1].aborted, "缓过来了就把还挂着的框收掉（别让他对着一个已经没事的窗口做选择）");
    eq(g.wc.reloads, 0, "  └ 收掉的框按的「默认键」不算数，没有因此重载");
    eq(g.timers.length, 0, "  └ 复查也撤了");
  }
  {
    const g = mkGuard();
    g.fire("unresponsive");
    g.boxes[0].answer(0);
    await g.tick();
    eq(g.wc.kills, 1, "卡死时选重新加载：先掐掉卡住的界面进程（不然重载排在它后面永远轮不到）");
    // 真 Electron 43 实测：掐完紧跟着 reload 不起新进程，窗口停在一片白、之后再没有任何事件
    eq(g.wc.reloads, 0, "  └ 掐完不马上重载（紧跟着 reload 在 Electron 43 上是空操作，窗口白着）");
    g.fire("render-process-gone", { reason: "killed", exitCode: 9 });
    await g.tick();
    eq(g.wc.reloads, 1, "  └ 等「没了」报上来才重载");
    eq(g.boxes.length, 1, "  └ 自己掐的那一下不当事故，不再弹「界面停止运行了」");
    eq(g.timers.length, 0, "  └ 等「没了」的 5 秒兜底撤了");
    g.fire("render-process-gone", { reason: "crashed", exitCode: 11 });
    await g.tick();
    eq(g.boxes.length, 2, "  └ 反向对照：之后真崩了照样弹（那个豁免只管一次）");
    eq(g.wc.reloads, 1, "  └ 真崩了不自动重载，等他选");
  }
  {
    const g = mkGuard();
    g.fire("unresponsive");
    g.boxes[0].answer(0);
    await g.tick();
    const fallback = g.timers.find((t) => t.ms === 5000);
    ok(!!fallback, "掐完记着 5 秒兜底", g.timers.map((t) => t.ms));
    fallback.fn();
    eq(g.wc.reloads, 1, "「没了」一直没报上来：5 秒后照样重载，不让窗口干白着");
    g.fire("render-process-gone", { reason: "crashed", exitCode: 11 });
    await g.tick();
    eq(g.boxes.length, 2, "  └ 兜底过后再报的「没了」算真事故，照样弹");
  }
  {
    const g = mkGuard();
    g.wc.forcefullyCrashRenderer = () => { throw new Error("掐不动"); };
    g.fire("unresponsive");
    g.boxes[0].answer(0);
    await g.tick();
    eq(g.wc.reloads, 1, "掐进程自己抛了：直接重载，不干等");
    eq(g.timers.length, 0, "  └ 也不留一个空等的兜底计时");
  }
  {
    const g = mkGuard();
    g.fire("render-process-gone", { reason: "crashed", exitCode: 11 });
    eq(g.boxes.length, 1, "界面进程崩了弹框");
    const b = g.boxes[0];
    eq(b.opts.message, SHELL_TEXT.zh.goneTitle, "  └ 标题说的是「停止运行了」");
    ok(/crashed/.test(b.opts.detail), "  └ 原因代码原样给出来（不替他猜是什么引起的）", b.opts.detail);
    eq(JSON.stringify(b.opts.buttons), JSON.stringify(["重新加载", "先不管"]),
       "  └ 进程已经没了，第二颗是「先不管」——「再等等」等不来任何东西");
    eq(g.wc.reloads, 0, "  └ 不自动重载（一加载就崩的页面会重载成死循环）");
    b.answer(0);
    await g.tick();
    eq(g.wc.reloads, 1, "选重新加载就重载");
    eq(g.wc.kills, 0, "  └ 进程已经没了，不用再掐一次");
    g.fire("render-process-gone", { reason: "oom" });
    g.boxes[1].answer(1);
    await g.tick();
    eq(g.wc.reloads + g.timers.length, 1, "选先不管：不重载，也不排复查");
  }
  {
    const g = mkGuard();
    g.fire("render-process-gone", { reason: "clean-exit", exitCode: 0 });
    eq(g.boxes.length, 0, "关窗、退应用时的正常退出不弹框");
  }
  {
    const g = mkGuard();
    g.fire("unresponsive");
    g.fire("render-process-gone", { reason: "crashed" });
    await g.tick();
    ok(g.boxes[0].aborted, "卡死的框还挂着、进程却没了：卡死那个框收掉");
    eq(g.boxes[1] && g.boxes[1].opts.message, SHELL_TEXT.zh.goneTitle, "  └ 换成「停止运行了」那个");
    eq(g.wc.reloads, 0, "  └ 收掉的那个框不会顺手触发重载");
  }
  {
    const g = mkGuard({ LAST_UI_LANG: "en" });
    g.fire("unresponsive");
    eq(JSON.stringify(g.boxes[0].opts.buttons), JSON.stringify([SHELL_TEXT.en.reloadBtn, SHELL_TEXT.en.waitBtn]),
       "界面是英文的，框就是英文的（用的是上一次问到的界面语言，卡住的界面答不了话）");
  }
  {
    const g = mkGuard({ dialog: { showMessageBox: () => Promise.reject(new Error("框弹不出来")) } });
    g.fire("unresponsive");
    await g.tick();
    ok(g.logs.some((l) => /框弹不出来/.test(l)), "弹框自己失败了记进启动日志，不往外抛（兜底不能成为新的错因）", g.logs);
  }
  const iGuard = mainSrc.indexOf("attachCrashGuard(win)");
  ok(iGuard > 0 && iGuard < mainSrc.indexOf('require(path.join(__dirname, "server.js"))'),
     "界面兜底挂在 require 服务端之前（启动失败页那一页也可能卡住）");

  // 「关于」面板那行：许可证从 package.json 读。以前写死 MIT，对外等于许了一个不存在的授权
  const aboutCopyright = new Function(slice("electron-main.js", "aboutCopyright") + "\nreturn aboutCopyright;")();
  const pkg = require(path.join(ROOT, "package.json"));
  const about = aboutCopyright(pkg);
  ok(about.includes(pkg.license) && !/\bMIT\b/.test(about), "「关于」面板写的是 package.json 里真实的许可证", about);
  ok(/copyright: aboutCopyright\(require\("\.\/package\.json"\)\)/.test(mainSrc) && !/copyright: "MIT/.test(mainSrc),
     "  └ setAboutPanelOptions 真用的是它，不是写死的字");
  eq(aboutCopyright({ license: "X-1.0" }), "X-1.0", "  └ 没填主页也不多出一个孤零零的分隔点");
}

// ===================================================================
// 【11c】桌面壳：退出先问、收尾一遍、托盘、窗口记忆（electron-main.js 切片跑）
// ===================================================================
/**
 * 关窗、⌘Q、托盘「退出」以前都是直接 app.quit()：跑到一半的任务没人收，MCP 服务、模型起的
 * 开发服务器留在后台占着端口。现在全都先到 requestQuit：有任务在跑先问一句，确认了走 shutdown 收尾。
 * 这一节钉的是一破就静默的那几条：
 *   · 字典两本都齐（缺一本，那个语言的用户看到的确认框写着 undefined）；
 *   · window-state.json 坏了、上次那块屏拔了，都照样开得出窗口，而且开在看得见、抓得住的地方；
 *   · 收尾只走一遍、before-quit 只挂一个（挂两个就是各拦各的，一个放行另一个还拦，退出成了死循环）；
 *   · 源码里再没有绕过 requestQuit 直接 app.quit() 的地方。
 */
async function runShellLifecycle() {
  const mainSrc = fs.readFileSync(path.join(ROOT, "electron-main.js"), "utf8");
  const SHELL_TEXT = new Function(mainSrc.slice(
    mainSrc.indexOf("const SHELL_TEXT = {"), mainSrc.indexOf("\nfunction osLang(")
  ).replace("const SHELL_TEXT =", "return") + ";")();
  const T = (l) => SHELL_TEXT[l === "en" ? "en" : "zh"];
  // 切出来的函数，外部变量按名字注入。slice 从 function 切起，async 的那几个得把前面的 async 补上
  const load = (name, env) => {
    const keys = Object.keys(env || {});
    const i = mainSrc.indexOf(`function ${name}(`);
    const src = (mainSrc.slice(Math.max(0, i - 6), i) === "async " ? "async " : "") + slice("electron-main.js", name);
    return new Function(...keys, src + `\nreturn ${name};`)(...keys.map((k) => env[k]));
  };
  const tick = async (n = 3) => { for (let k = 0; k < n; k++) await new Promise((r) => setImmediate(r)); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 等一个 Promise，最多 2 秒。光写 await 的话，它要是永远不 resolve，事件循环一空 node 就静静地以 0 退出，
  // 最后那行「全部通过」都没打，跑测试的人却看到一个绿的退出码
  const HUNG = Symbol("hung");
  const within = async (p, what) => {
    let timer;
    const r = await Promise.race([p, new Promise((res) => { timer = setTimeout(() => res(HUNG), 2000); })]);
    clearTimeout(timer);
    ok(r !== HUNG, `  └ ${what}：2 秒内回来了，没卡住`);
    return r;
  };
  const count = (re) => (mainSrc.match(re) || []).length;

  console.log("\n【11c】桌面壳：退出先问、收尾只走一遍、托盘三条、窗口记得住也找得回");

  // ---- 字典 ----
  for (const k of ["trayTip", "trayShow", "trayNewTask", "trayQuit", "quitBusy", "quitBtn", "stayBtn"]) {
    const zh = SHELL_TEXT.zh[k], en = SHELL_TEXT.en && SHELL_TEXT.en[k];
    const zs = typeof zh === "function" ? zh(3) : zh, es = typeof en === "function" ? en(3) : en;
    ok(typeof zs === "string" && zs.trim() && typeof es === "string" && es.trim(),
       `SHELL_TEXT.${k} 中英两本都有`, { zs, es });
    ok(typeof es === "string" && !/[㐀-鿿]/.test(es) && es !== zs, `  └ ${k} 的英文那本真是英文`, es);
  }
  eq(SHELL_TEXT.zh.quitBusy(2), "还有 2 个任务在跑，退出会中断它们", "确认框就一句：几个任务在跑、退了会怎样");
  eq(SHELL_TEXT.en.quitBusy(1), "1 task is still running. Quitting will stop it.", "  └ 英文单数");
  ok(/^2 tasks .* them\.$/.test(SHELL_TEXT.en.quitBusy(2)), "  └ 英文复数（1 task / 2 tasks 分开写）", SHELL_TEXT.en.quitBusy(2));

  // ---- 窗口记忆：读写都兜住 ----
  const readWindowState = load("readWindowState", { fs });
  const writeWindowState = load("writeWindowState", { fs, path });
  const WD = fs.mkdtempSync(path.join(os.tmpdir(), "owb-winstate-"));
  try {
    const f = path.join(WD, "window-state.json");
    eq(readWindowState(f), null, "还没存过 → null（头一回开，照默认）");
    const bad = {
      "半截 JSON（写到一半断电）": '{"x": 120, "y":', "空文件": "", "数组": "[1,2,3]", "null": "null",
      "一个数": "42", "一串字": '"hello"', "乱码": "\u0000ÿ�",
    };
    for (const [what, body] of Object.entries(bad)) {
      fs.writeFileSync(f, body);
      let got, threw = null;
      try { got = readWindowState(f); } catch (e) { threw = e; }
      ok(!threw && got === null, `坏文件（${what}）→ 当没存过，不抛`, threw ? String(threw) : got);
    }
    eq(readWindowState(WD), null, "路径指着个目录 → null");
    eq(readWindowState(undefined), null, "userData 都问不到（winStateFile 回 null）→ null");
    const st = { x: 100, y: 80, width: 1300, height: 820, maximized: false };
    eq(writeWindowState(f, st), true, "写得进去回 true");
    eq(JSON.stringify(readWindowState(f)), JSON.stringify(st), "  └ 读回来原样");
    ok(!fs.existsSync(f + ".tmp"), "  └ 旁边那份临时文件改名走了，不留垃圾");
    const deep = path.join(WD, "a", "b", "window-state.json");
    ok(writeWindowState(deep, st) === true && readWindowState(deep) !== null, "userData 目录还不存在也写得进去（先建目录）");
    const blocker = path.join(WD, "blocker");
    fs.writeFileSync(blocker, "x");
    let r2, threw2 = null;
    try { r2 = writeWindowState(path.join(blocker, "window-state.json"), st); } catch (e) { threw2 = e; }
    ok(!threw2 && r2 === false, "写不进去（上一级是个文件）→ false，不抛", threw2 ? String(threw2) : r2);
    let r3, threw3 = null;
    try { r3 = writeWindowState(null, st); } catch (e) { threw3 = e; }
    ok(!threw3 && r3 === false, "文件名是 null（userData 问不到）→ false，不抛", threw3 ? String(threw3) : r3);
    const loop = { x: 1 };
    loop.self = loop;
    eq(writeWindowState(f, loop), false, "存的东西序列化不了 → false");
    eq(JSON.stringify(readWindowState(f)), JSON.stringify(st), "  └ 盘上还是上一份完整的，没被写成半截");
  } finally {
    fs.rmSync(WD, { recursive: true, force: true });
  }

  // ---- 窗口记忆：位置还能不能原样用 ----
  const WIN_SIZE = new Function("return " + ((mainSrc.match(/\nconst WIN_SIZE = (\{[^}]*\});/) || [])[1] || "null"))();
  ok(WIN_SIZE && WIN_SIZE.width > 0 && WIN_SIZE.minWidth > 0 && WIN_SIZE.minHeight > 0, "默认尺寸表抠得出来", WIN_SIZE);
  const sane = load("saneWindowBounds", {});
  const DEF = JSON.stringify({ width: WIN_SIZE.width, height: WIN_SIZE.height });
  const MAIN = { x: 0, y: 25, width: 1440, height: 875 };     // 笔记本自带屏（顶上 25 像素是 macOS 菜单栏）
  const EXT = { x: 1440, y: 0, width: 2560, height: 1415 };   // 右边接的外接屏
  const onExt = { x: 2000, y: 100, width: 1600, height: 1000, maximized: false };
  const both = sane(onExt, [MAIN, EXT], WIN_SIZE);
  eq(JSON.stringify(both), JSON.stringify({ width: 1600, height: 1000, x: 2000, y: 100 }), "两块屏都在：上次开在外接屏上，这次还开在那儿");
  const unplugged = sane(onExt, [MAIN], WIN_SIZE);
  ok(unplugged.x === undefined && unplugged.y === undefined, "外接屏拔了：不给坐标，Electron 自己居中（不开到一片不存在的地方）", unplugged);
  ok(unplugged.width <= MAIN.width && unplugged.height <= MAIN.height, "  └ 尺寸也压回剩下那块屏以内", unplugged);
  for (const [what, s] of [["远在左边", { x: -5000, y: 100 }], ["远在下面", { x: 100, y: 9000 }], ["标题栏在屏幕上沿外面", { x: 100, y: -200 }]]) {
    const o = sane({ ...s, width: 1200, height: 800 }, [MAIN, EXT], WIN_SIZE);
    ok(o.x === undefined && o.y === undefined, `坐标越界（${what}）→ 居中`, o);
  }
  // 边界：标题栏至少露出 80 像素才算抓得住
  eq(sane({ x: 1340, y: 100, width: 1200, height: 800 }, [MAIN], WIN_SIZE).x, 1340, "大半截伸出右边、标题栏还露 100 像素 → 照用（是他自己摆的）");
  eq(sane({ x: 1380, y: 100, width: 1200, height: 800 }, [MAIN], WIN_SIZE).x, undefined, "  └ 只露 60 像素 → 抓不住标题栏，居中");
  eq(sane({ x: -1100, y: 100, width: 1200, height: 800 }, [MAIN], WIN_SIZE).x, -1100, "  └ 伸出左边同理：露 100 像素照用");
  eq(sane({ x: -1150, y: 100, width: 1200, height: 800 }, [MAIN], WIN_SIZE).x, undefined, "  └ 露 50 像素 → 居中");
  eq(sane({ x: 100, y: 15, width: 1200, height: 800 }, [MAIN], WIN_SIZE).y, 15, "  └ 顶上容 10 像素（Windows 窗口四周那圈看不见的缩放边）");
  eq(sane({ x: 100, y: 10, width: 1200, height: 800 }, [MAIN], WIN_SIZE).y, undefined, "  └ 再往上就钻到菜单栏底下了 → 居中");
  eq(sane({ x: 100, y: 860, width: 1200, height: 800 }, [MAIN], WIN_SIZE).y, 860, "  └ 往下拖到只剩标题栏还在屏里 → 照用");
  eq(sane({ x: 100, y: 870, width: 1200, height: 800 }, [MAIN], WIN_SIZE).y, undefined, "  └ 标题栏都掉出屏底 → 居中");
  const junk = sane({ x: "100", y: 100, width: "abc", height: NaN }, [MAIN, EXT], WIN_SIZE);
  eq(JSON.stringify(junk), DEF, "数不像话（字符串、NaN）→ 那一项用默认，坐标不用");
  eq(JSON.stringify(sane({ width: Infinity, height: -300 }, [MAIN, EXT], WIN_SIZE)), DEF, "  └ 无穷大、负的宽高同理");
  const tiny = sane({ x: 100, y: 100, width: 100, height: 50 }, [MAIN], WIN_SIZE);
  ok(tiny.width === WIN_SIZE.minWidth && tiny.height === WIN_SIZE.minHeight, "太小的抬到最小尺寸", tiny);
  const frac = sane({ x: 100.6, y: 99.4, width: 1000.5, height: 700.2 }, [MAIN], WIN_SIZE);
  ok([frac.x, frac.y, frac.width, frac.height].every(Number.isInteger), "带小数的取整", frac);
  eq(sane({ maximized: true }, [MAIN], WIN_SIZE).maximized, true, "上次是最大化关的，记着");
  eq(sane({ maximized: "true" }, [MAIN], WIN_SIZE).maximized, undefined, "  └ 只认真的 true");
  for (const [what, s] of [["null", null], ["数组", [1, 2]], ["undefined", undefined], ["一串字", "x"]]) {
    eq(JSON.stringify(sane(s, [MAIN, EXT], WIN_SIZE)), DEF, `存的整个不是对象（${what}）→ 全用默认`);
  }
  const noScr = sane(onExt, [], WIN_SIZE);
  ok(noScr.x === undefined && noScr.width === 1600, "一块屏都问不到 → 不给坐标（不知道哪儿看得见）", noScr);
  eq(sane(onExt, null, WIN_SIZE).x, undefined, "  └ 屏幕列表是 null 也不抛");
  eq(sane(onExt, [null, { x: NaN, y: 0, width: 100, height: 100 }, EXT], WIN_SIZE).x, 2000, "屏幕列表里混了坏数据 → 跳过那几块，好的照用");

  const iRead = mainSrc.indexOf("readWindowState(winStateFile())");
  ok(iRead > 0 && iRead < mainSrc.indexOf("win = new BrowserWindow("), "建窗口之前先读上次的位置");
  ok(/screen\.getAllDisplays\(\)\.map\(\(d\) => d\.workArea\)/.test(mainSrc), "  └ 跟每块屏的工作区比，不是只看主屏");
  ok(/writeWindowState\(winStateFile\(\), \{ \.\.\.win\.getNormalBounds\(\), maximized: win\.isMaximized\(\) \}\)/.test(mainSrc),
     "存的是「正常状态」那份外框 + 是否最大化（最大化时的外框不是他摆的位置）");
  ok(/win\.on\("close", saveWinState\)/.test(mainSrc), "  └ 关窗那一下立刻存，不等防抖");

  // ---- 快捷键：设置页的写法 → Electron 的写法（1.3 同步项）----
  const accel = load("electronAccel", {});
  const cases = [
    ["Mod+Comma", true, "CommandOrControl+,"], ["Mod+Comma", false, "CommandOrControl+,"],
    ["Meta+Shift+K", true, "Command+Shift+K"], ["Meta+Shift+K", false, "Super+Shift+K"],
    ["Ctrl+Shift+ArrowUp", false, "Control+Shift+Up"],
    ["Ctrl+Meta+F|F11", true, "Control+Command+F"], ["Ctrl+Meta+F|F11", false, "F11"],
    ["Alt+Numpad1", false, "Alt+num1"], ["Shift+Mod+BracketLeft", true, "Shift+CommandOrControl+["],
    ["Shift+Alt+W", true, "Shift+Alt+W"], ["Ctrl+Control+K", false, "Control+K"],
    ["", true, ""], [null, false, ""],
  ];
  for (const [a, mac, want] of cases) eq(accel(a, mac), want, `快捷键 ${a} → ${want || "（空）"}（${mac ? "macOS" : "Windows / Linux"}）`);
  // Electron 认得的键名（docs/api/accelerator.md），落出来的每一段都得在这张表里，不然 register 直接抛
  const ELECTRON_TOKEN = /^(CommandOrControl|Command|Control|Alt|Shift|Super|[A-Z0-9]|F([1-9]|1\d|2[0-4])|[,./\\;'`[\]\-=]|Up|Down|Left|Right|Enter|Escape|Space|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|num[0-9]|numadd|numsub|nummult|numdiv|numdec)$/;
  const app02 = fs.readFileSync(path.join(ROOT, "public", "js", "app-02.js"), "utf8");
  const defsSrc = (app02.match(/const SHORTCUT_DEFS = \[([\s\S]*?)\n\];/) || [])[1] || "";
  const defs = [...defsSrc.matchAll(/\["[^"]+", "[^"]+", "([^"]+)"/g)].map((m) => m[1]);
  ok(defs.length >= 10, "设置页的默认键抠得出来", defs.length);
  const badTok = [];
  for (const d of defs) for (const mac of [true, false]) for (const tok of accel(d, mac).split("+")) {
    if (!ELECTRON_TOKEN.test(tok)) badTok.push(`${d}(${mac ? "mac" : "win"})→${tok}`);
  }
  ok(badTok.length === 0, "设置页每个默认键落到两个平台，都是 Electron 认得的键名（改绑成哪条都注册得上）", badTok);
  // 反向对照：以前那版只换 Meta→Command、Ctrl→Control
  const oldAccel = (a) => String(a).replace(/\bMeta\b/g, "Command").replace(/\bCtrl\b/g, "Control");
  ok(defs.some((d) => oldAccel(d).split("+").some((t) => !ELECTRON_TOKEN.test(t))), "  └ 反向对照：老那版过不了这把尺子（Mod、Comma 原样漏过去）");
  {
    const regs = [], logs = [];
    let result = true;
    const registerShortcuts = load("registerShortcuts", {
      globalShortcut: { unregisterAll: () => {}, register: (a) => { regs.push(a); if (result === "throw") throw new Error("bad accel"); return result; } },
      electronAccel: accel, process: { platform: "win32" }, win: null, bootLog: (s) => logs.push(String(s)),
      console: { warn: (...a) => logs.push(a.join(" ")) },
    });
    registerShortcuts({ "toggle-window": "Mod+Shift+K" });
    eq(regs[0], "CommandOrControl+Shift+K", "改绑成 Mod+Shift+K：注册的是 Electron 那种写法");
    registerShortcuts(null);
    eq(regs[1], "Shift+Alt+W", "  └ 没改绑用默认的 Shift+Alt+W");
    result = false;
    registerShortcuts({ "toggle-window": "Mod+Shift+K" });
    ok(logs.some((l) => /没注册上/.test(l)), "  └ 系统不给这个组合键（register 回 false）→ 记进日志，不然看不出按了没反应是为什么", logs);
    result = "throw";
    let threw = null;
    try { registerShortcuts({ "toggle-window": "Mod+Shift+K" }); } catch (e) { threw = e; }
    ok(!threw, "  └ register 抛了也不往外抛（设置页存盘那条路不能因为它挂掉）");
  }

  // ---- 问服务端：以用户本人的身份，问不到就回 null ----
  const mkApi = (over) => {
    const calls = [];
    const env = {
      SERVER_OWN: true, PORT: 3811, AbortSignal,
      session: { defaultSession: { cookies: { get: async (q) => {
        calls.push(["cookies", q]);
        return [{ name: "openworkbuddy_token", value: "tok" }, { name: "x", value: "1" }];
      } } } },
      fetch: async (url, init) => { calls.push(["fetch", url, init]); return { ok: true, json: async () => ["s1"] }; },
      ...(over || {}),
    };
    return { apiCall: load("apiCall", env), calls };
  };
  {
    const a = mkApi({ SERVER_OWN: false });
    eq(await a.apiCall("GET", "/api/chat/running"), null, "端口上是另一台 OpenWorkBuddy（连过去的）：不问，回 null");
    eq(a.calls.length, 0, "  └ 连请求都不发（不去叫停人家的任务）");
  }
  {
    const a = mkApi();
    eq(JSON.stringify(await a.apiCall("GET", "/api/chat/running")), '["s1"]', "问得到就把结果交回来");
    const fc = a.calls.find((c) => c[0] === "fetch") || [];
    eq(fc[1], "http://127.0.0.1:3811/api/chat/running", "  └ 问的是本机这个端口");
    eq(fc[2] && fc[2].headers.cookie, "openworkbuddy_token=tok; x=1", "  └ 带着界面那个 session 的 cookie（登录令牌是 HttpOnly 的，只能从 cookie 罐里取）");
    ok(fc[2] && fc[2].signal && !fc[2].headers["content-type"] && fc[2].body === undefined, "  └ 带超时；GET 不带请求体");
    eq((a.calls.find((c) => c[0] === "cookies") || [])[1].url, "http://127.0.0.1:3811", "  └ cookie 按这个地址取");
    await a.apiCall("POST", "/api/chat/stop", { sessionId: "s1" });
    const post = a.calls.filter((c) => c[0] === "fetch")[1][2];
    ok(post.method === "POST" && post.headers["content-type"] === "application/json" && post.body === '{"sessionId":"s1"}', "  └ POST 带 JSON 请求体", post);
  }
  for (const [what, over] of [
    ["服务端回 401 / 500", { fetch: async () => ({ ok: false, json: async () => ({}) }) }],
    ["请求抛了（超时、连不上）", { fetch: async () => { throw new Error("ECONNREFUSED"); } }],
    ["cookie 罐取不出来", { session: { defaultSession: { cookies: { get: async () => { throw new Error("no session"); } } } } }],
    ["回的不是 JSON", { fetch: async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }) }],
  ]) {
    const a = mkApi(over);
    let got, threw = null;
    try { got = await a.apiCall("GET", "/api/chat/running"); } catch (e) { threw = e; }
    ok(!threw && got === null, `${what} → null，不抛（退出不许因为这一问卡住）`, threw ? String(threw) : got);
  }
  for (const [what, v, want] of [["null", null, "[]"], ["报错对象", { error: "x" }, "[]"], ["id 列表", ["a", "b"], '["a","b"]']]) {
    const runningTasks = load("runningTasks", { apiCall: async () => v });
    eq(JSON.stringify(await runningTasks()), want, `在跑的任务：服务端回${what} → ${want}`);
  }

  // ---- 子进程：认得出谁是自己的 ----
  const childTree = load("childTree", {});
  const APP = "/Applications/OpenWorkBuddy.app/Contents";
  const PS = [
    "    1     0     1 /sbin/launchd",
    `  100     1   100 ${APP}/MacOS/OpenWorkBuddy`,                                                   // 壳自己（root）
    `  101   100   100 ${APP}/Frameworks/OpenWorkBuddy Helper (Renderer).app/Contents/MacOS/OpenWorkBuddy Helper (Renderer) --type=renderer --lang=zh-CN`, // keep 里有
    "  102   101   100 whatever",                                                                        //   └ 它底下的也不碰
    `  104   100   100 ${APP}/Frameworks/OpenWorkBuddy Helper (GPU).app/Contents/MacOS/OpenWorkBuddy Helper (GPU) --type=gpu-process --gpu-preferences=UAAAAAAAAAAgAAAIAAAAAAAAAAAAAAAAAABgAAAAAAAwAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, // 还没进 metrics 表，靠 --type= 认
    `  103   100   100 ${APP}/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --monitor-self`, // 崩溃上报
    "  110   100   110 node /x/mcp-server.js --stdio",                                                // 自立门户的 MCP 服务（detached）
    "  111   110   110 npm run dev",
    "  112   111   110 node /x/node_modules/.bin/vite",
    "  120   100   100 /bin/bash -c sleep 99",
    "  121   120   100 sleep 99",
    `  130   100   100 ${APP}/MacOS/OpenWorkBuddy /x/eval/run.js`,                                     // ELECTRON_RUN_AS_NODE 跑的脚本：同一个二进制，但要收
    "  200     1   200 /System/Applications/Finder.app/Contents/MacOS/Finder",                         // 别人家的
    "  201   200   200 child",
    "garbage line",
  ].join("\n");
  const tree = childTree(PS, 100, [101]);
  eq(JSON.stringify(tree.pids.sort((a, b) => a - b)), "[110,111,112,120,121,130]",
     "子孙都认得出来，连孙子、曾孙；自己、Electron 自己的（keep 里的、带 --type= 的）、崩溃上报、别人家的都不算");
  ok(tree.pids.includes(130), "  └ 拿 Electron 二进制跑的脚本（ELECTRON_RUN_AS_NODE）照收：不能按「跟主进程同一个可执行文件」放过");
  ok(!tree.pids.includes(104), "  └ GPU 进程还没进 metrics 表，也靠 --type= 认出来不碰（真 Electron 43 刚启动那阵就是这样）");
  eq(JSON.stringify(tree.groups), "[110]", "  └ 自立门户的进程组组长单独挑出来（按组杀才能带走已经过继给 init 的孙子）");
  eq(JSON.stringify(childTree("", 100, [])), '{"pids":[],"groups":[]}', "  └ ps 没输出 → 什么都不杀");
  eq(JSON.stringify(childTree(undefined, 100, null)), '{"pids":[],"groups":[]}', "  └ ps 没跑起来（undefined）也不抛");
  const winTree = childTree([
    '4321 1000 0 node.exe "C:\\Program Files\\nodejs\\node.exe" mcp.js',
    "4400 1000 0 cmd.exe C:\\Windows\\system32\\cmd.exe /d /s /c npm run dev",
    '4500 1000 0 OpenWorkBuddy.exe "C:\\x\\OpenWorkBuddy.exe" --type=gpu-process --field-trial-handle=1',
    "4600 1000 0 conhost.exe ",
  ].join("\r\n") + "\r\n", 1000, []);
  eq(JSON.stringify(winTree), '{"pids":[4321,4400,4600],"groups":[]}',
     "Windows 那份（PowerShell 拼的「pid 父pid 0 名字 命令行」，\\r\\n 换行）也解析得了；--type= 的不碰；没有进程组");
  if (process.platform !== "win32") {
    const cp = require("child_process");
    const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
    const sh = cp.spawn("sh", ["-c", "sleep 31 & sleep 32 & sleep 33 & wait"], { stdio: "ignore" });
    const exited = new Promise((r) => sh.on("exit", () => r("exited")));
    let kids = { pids: [] };
    try {
      await sleep(300);
      kids = childTree(cp.spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,args="], { encoding: "utf8" }).stdout, sh.pid, []);
      eq(kids.pids.length, 3, "真跑一遍：ps 列出来，sh 底下三个 sleep 都认得出来", kids);
      const keepPid = kids.pids[0];
      // 根换成这个 sh：真杀，但只杀得到它底下，碰不到跑测试的这个进程的其他孩子
      const killChildren = load("killChildren", {
        require, bootLog: () => {}, childTree,
        app: { getAppMetrics: () => [{ pid: keepPid }] }, // 假装这个是 Electron 自己的 GPU 进程
        process: { platform: process.platform, pid: sh.pid, kill: (p, s) => process.kill(p, s) },
      });
      eq(killChildren("SIGTERM"), 2, "  └ 送走两个，Electron 自己那个（keep）不碰");
      await sleep(300);
      ok(alive(keepPid), "  └ keep 那个还活着");
      ok(kids.pids.filter((p) => p !== keepPid).every((p) => !alive(p)), "  └ 另外两个真没了");
      process.kill(keepPid, "SIGTERM");
      eq(await Promise.race([exited, sleep(3000).then(() => "timeout")]), "exited", "  └ 孩子都走了，sh 的 wait 返回、自己也退了");
    } finally {
      for (const p of kids.pids) { try { process.kill(p, "SIGKILL"); } catch {} }
      try { sh.kill("SIGKILL"); } catch {}
    }
  }

  // ---- shutdown：只走一遍，最多等 3 秒 ----
  ok(/^const SHUTDOWN_WAIT_MS = 3000;/m.test(mainSrc), "叫停之后最多等 3 秒");
  const mkShutdown = (st) => {
    const stops = [], kills = [], logs = [];
    st.polls = 0;
    const shutdown = load("shutdown", {
      SHUTDOWN: null, SHUTDOWN_WAIT_MS: 80,
      runningTasks: async () => { st.polls++; return st.running.slice(); },
      apiCall: async (method, p, body) => {
        stops.push([method, p, body && body.sessionId]);
        if (st.stopWorks) st.running = st.running.filter((x) => x !== body.sessionId);
        return { ok: true };
      },
      killChildren: (sig) => { kills.push(sig); if (st.killThrows) throw new Error("ps 没了"); return sig === "SIGTERM" ? (st.termed || 0) : 0; },
      bootLog: (s) => logs.push(String(s)),
    });
    return { shutdown, stops, kills, logs };
  };
  {
    const st = { running: ["a", "b"], stopWorks: true };
    const s = mkShutdown(st);
    const p1 = s.shutdown(), p2 = s.shutdown();
    ok(p1 === p2, "收尾只走一遍：同时来要的两个拿到的是同一个 Promise");
    await within(p1, "收尾");
    eq(JSON.stringify(s.stops), '[["POST","/api/chat/stop","a"],["POST","/api/chat/stop","b"]]', "  └ 在跑的每个任务叫停一次（跟用户点「让我停下」同一条路）");
    eq(s.kills.join(","), "SIGTERM", "  └ 然后清子进程；没有要清的就不补 SIGKILL");
    await s.shutdown();
    ok(s.stops.length === 2 && s.kills.length === 1, "  └ 收完了再要一次：还是那一趟，不再叫停、不再杀", { stops: s.stops.length, kills: s.kills.length });
  }
  {
    const st = { running: ["a"], stopWorks: false, termed: 2 };
    const s = mkShutdown(st);
    const t0 = Date.now();
    await s.shutdown();
    const took = Date.now() - t0;
    ok(took >= 80 + 450, "任务叫了不停：等满时限就不等了，送完 SIGTERM 半秒后补 SIGKILL", took);
    ok(s.logs.some((l) => /不等了/.test(l)), "  └ 没等完这件事记进日志", s.logs);
    eq(s.kills.join(","), "SIGTERM,SIGKILL", "  └ 先礼后兵");
    const polls = st.polls;
    await sleep(400);
    eq(st.polls, polls, "  └ 放弃之后不再轮询（不留一个转个不停的循环）");
  }
  {
    const st = { running: [] };
    const s = mkShutdown(st);
    const t0 = Date.now();
    await s.shutdown();
    ok(s.stops.length === 0 && s.kills.join(",") === "SIGTERM" && Date.now() - t0 < 80, "没有在跑的任务：不叫停、不白等，直接清子进程", { stops: s.stops, took: Date.now() - t0 });
  }
  {
    const st = { running: [], killThrows: true };
    const s = mkShutdown(st);
    let threw = null;
    try { await s.shutdown(); } catch (e) { threw = e; }
    ok(!threw && s.logs.some((l) => /ps 没了/.test(l)), "收尾自己出错：记日志，不往外抛（退出照样得退）", threw ? String(threw) : s.logs);
  }

  // ---- requestQuit：有任务在跑先问，不替他挑 ----
  const mkQuit = (over) => {
    const boxes = [], logs = [];
    const calls = { shutdown: 0, quit: 0, restore: 0, show: 0 };
    const st = { running: [] };
    const w = { isDestroyed: () => false, isMinimized: () => true, restore: () => calls.restore++, show: () => calls.show++ };
    const env = {
      QUIT_STATE: "", win: w, T, LAST_UI_LANG: "", osLang: () => "zh",
      dialog: { showMessageBox: (...a) => new Promise((resolve) => {
        boxes.push({ parent: a.length > 1 ? a[0] : null, opts: a[a.length - 1], answer: (response) => resolve({ response }) });
      }) },
      runningTasks: async () => st.running.slice(),
      shutdown: async () => { calls.shutdown++; },
      app: { quit: () => { calls.quit++; } },
      bootLog: (s) => logs.push(String(s)),
      ...(over || {}),
    };
    return { requestQuit: load("requestQuit", env), boxes, logs, calls, st, w };
  };
  {
    const q = mkQuit();
    await q.requestQuit();
    ok(q.boxes.length === 0 && q.calls.shutdown === 1 && q.calls.quit === 1, "没有任务在跑：不打扰，收尾完直接退", q.calls);
    await q.requestQuit();
    ok(q.boxes.length === 0 && q.calls.shutdown === 1 && q.calls.quit === 2, "  └ 放行过之后再来要（closed、window-all-closed）：直接退，不再问、不再收尾", q.calls);
  }
  {
    const q = mkQuit();
    q.st.running = ["a", "b"];
    const p = q.requestQuit();
    await tick();
    eq(q.boxes.length, 1, "2 个任务在跑：先问一句");
    const b = q.boxes[0] || { opts: { buttons: [] } };
    eq(b.opts.message, "还有 2 个任务在跑，退出会中断它们", "  └ 问的就是这句");
    eq(JSON.stringify(b.opts.buttons), JSON.stringify([SHELL_TEXT.zh.quitBtn, SHELL_TEXT.zh.stayBtn]), "  └ 两颗按钮：退 / 不退（两条都给，不替他挑）");
    eq(b.opts.buttons[b.opts.defaultId], SHELL_TEXT.zh.stayBtn, "  └ 回车默认是「先不退」：不丢东西的那条");
    eq(b.opts.buttons[b.opts.cancelId], SHELL_TEXT.zh.stayBtn, "  └ Esc / 关掉框也算不退");
    ok(b.parent === q.w && q.calls.restore === 1 && q.calls.show === 1, "  └ 框挂在主窗口上，窗口收着的话先叫出来（不然框也跟着看不见）", q.calls);
    q.requestQuit();
    await tick();
    eq(q.boxes.length, 1, "框挂着的时候再点关闭 / 再按 ⌘Q：不叠第二个框");
    b.answer(1);
    await within(p, "选了先不退");
    ok(q.calls.shutdown === 0 && q.calls.quit === 0, "选了先不退：什么都不动，任务接着跑", q.calls);
    ok(q.logs.some((l) => /先不退/.test(l)), "  └ 记一笔（回头查「怎么没退」看得到）", q.logs);
    const p2 = q.requestQuit();
    await tick();
    eq(q.boxes.length, 2, "  └ 之后再关还会问（不是问过一次就永远不问了）");
    (q.boxes[1] || { answer: () => {} }).answer(0);
    await within(p2, "选了中断并退出");
    ok(q.calls.shutdown === 1 && q.calls.quit === 1, "选了中断并退出：收尾一遍，然后退", q.calls);
  }
  {
    const q = mkQuit({ LAST_UI_LANG: "en" });
    q.st.running = ["a"];
    q.requestQuit();
    await tick();
    eq(q.boxes[0] && q.boxes[0].opts.message, SHELL_TEXT.en.quitBusy(1), "界面是英文的，框就是英文的");
  }
  {
    const q = mkQuit({ win: null });
    q.st.running = ["a"];
    q.requestQuit();
    await tick();
    ok(q.boxes.length === 1 && q.boxes[0].parent === null, "主窗口已经没了（从托盘退）：框照样弹，不挂在死窗口上");
  }
  {
    const q = mkQuit({ dialog: { showMessageBox: () => Promise.reject(new Error("框弹不出来")) } });
    q.st.running = ["a"];
    await within(q.requestQuit(), "弹框失败");
    ok(q.calls.quit === 1 && q.logs.some((l) => /框弹不出来/.test(l)), "弹框自己失败了：记日志，照样退（不能让人关不掉应用）", { calls: q.calls, logs: q.logs });
  }

  // ---- 所有「要退出」的入口都到 requestQuit ----
  const gate = (src, state) => {
    const c = { prevent: 0, ask: 0 };
    new Function("QUIT_STATE", "requestQuit", "return " + src)(state, () => c.ask++)({ preventDefault: () => c.prevent++ });
    return c;
  };
  const bq = mainSrc.match(/\napp\.on\("before-quit", (\(e\) => \{[\s\S]*?\n\})\);/);
  const cg = mainSrc.match(/\n {2}win\.on\("close", (\(e\) => \{[\s\S]*?\n {2}\})\);/);
  ok(bq && cg, "before-quit 和主窗口 close 的闸都抠得出来");
  for (const [what, m] of [["⌘Q / Dock 右键退出（before-quit）", bq], ["关主窗口（close）", cg]]) {
    if (!m) continue;
    let c = gate(m[1], "");
    ok(c.prevent === 1 && c.ask === 1, `${what}：先拦下来交给 requestQuit`, c);
    c = gate(m[1], "asking");
    ok(c.prevent === 1 && c.ask === 1, "  └ 确认框挂着时再来：照样拦（叠不叠框归 requestQuit 管）", c);
    c = gate(m[1], "done");
    ok(c.prevent === 0 && c.ask === 0, "  └ 放行过了：不拦", c);
  }
  eq(count(/app\.on\("before-quit"/g), 1, "before-quit 只挂一个（两个各拦各的，一个放行另一个还拦，退出就成了死循环）");
  eq(count(/^app\.on\("before-quit"/gm), 1, "  └ 挂在顶层，不在 whenReady / 建窗口里（那些地方跑两遍就挂两个）");
  eq(count(/app\.on\("will-quit"/g), 1, "will-quit 也只挂一个");
  eq(count(/\nfunction shutdown\(/g), 1, "shutdown 只有一份");
  ok(/win\.on\("closed", \(\) => \{[\s\S]{0,300}?requestQuit\(\);/.test(mainSrc), "主窗口 closed 走 requestQuit");
  ok(/^app\.on\("window-all-closed", \(\) => requestQuit\(\)\);/m.test(mainSrc), "window-all-closed 也走 requestQuit");
  const strayQuits = (src) => {
    const i0 = src.indexOf("async function requestQuit("), i1 = src.indexOf("\n}\n", i0);
    const bad = [];
    for (let i = src.indexOf("app.quit("); i >= 0; i = src.indexOf("app.quit(", i + 1)) {
      const line = src.slice(src.lastIndexOf("\n", i) + 1, i);
      if (/^\s*\*/.test(line) || line.includes("//")) continue; // 注释里提到的不算
      if (i > i0 && i < i1) continue;
      bad.push((line + src.slice(i, src.indexOf("\n", i))).trim());
    }
    return bad;
  };
  eq(JSON.stringify(strayQuits(mainSrc)), "[]", "除了 requestQuit 自己，源码里没有别处直接 app.quit()（都得先问、先收尾）");
  const reverted = mainSrc.replace('app.on("window-all-closed", () => requestQuit());', 'app.on("window-all-closed", () => app.quit());');
  ok(reverted !== mainSrc && strayQuits(reverted).length === 1, "  └ 反向对照：把兜底那行改回 app.quit() 就抓得到");
  ok(/const letSystemQuit = \(\) => \{\s*QUIT_STATE = "done";/.test(mainSrc) &&
     /win\.on\("query-session-end", letSystemQuit\)/.test(mainSrc) && /powerMonitor\.on\("shutdown", letSystemQuit\)/.test(mainSrc),
     "系统关机 / 注销：不拦、不问（拦了用户看到的是「OpenWorkBuddy 阻止了关机」）");
  {
    const sq = mainSrc.match(/\n {2}let sysQuitTimer = null;\n {2}const letSystemQuit = (\(\) => \{[\s\S]*?\n {2}\});/);
    ok(sq, "  └ letSystemQuit 抠得出来");
    const mkSys = (SHUTDOWN) => new Function("bootLog", "SHUTDOWN", "SYS_QUIT_REARM_MS",
      `let QUIT_STATE = ""; let sysQuitTimer = null; const f = ${sq ? sq[1] : "() => {}"};
       return { f, get state() { return QUIT_STATE; }, set state(v) { QUIT_STATE = v; } };`)(() => {}, SHUTDOWN, 40);
    let s = mkSys(null);
    s.f();
    eq(s.state, "done", "  └ 系统说要关机：立刻放行");
    await sleep(100);
    eq(s.state, "", "  └ 关机被取消（别的应用拦下了）、过一阵还活着：闸装回去，之后关窗照样先问、先收尾");
    s = mkSys(Promise.resolve());
    s.f();
    await sleep(100);
    eq(s.state, "done", "  └ 已经在收尾了：不去把它改回来");
    s = mkSys(null);
    s.f();
    s.state = "asking";
    await sleep(100);
    eq(s.state, "asking", "  └ 这中间他自己又点了关窗、框正挂着：不去动");
  }
  ok(/app\.on\("will-quit", \(\) => \{[\s\S]{0,300}?if \(!SHUTDOWN\) killChildren\("SIGTERM"\);/.test(mainSrc),
     "  └ 没走收尾的那条路，will-quit 里至少给子进程发一声 SIGTERM");
  ok(/SERVER_OWN = !got\.reused;/.test(mainSrc), "服务端是不是自己这个进程起的，就绪时记下（连过去的那种不去动人家的任务）");

  // ---- 托盘 ----
  const trayMenuItems = load("trayMenuItems", {});
  const act = { show: () => {}, newTask: () => {}, quit: () => {} };
  const items = trayMenuItems(SHELL_TEXT.zh, act);
  eq(items.filter((x) => x.label).map((x) => x.label).join("/"), "显示窗口/新建任务/退出", "托盘菜单三条：显示窗口 / 新建任务 / 退出");
  ok(items[items.length - 1].click === act.quit && items[items.length - 2].type === "separator", "  └ 退出隔开放最后（别跟新建任务挨着误点）");
  eq(trayMenuItems(SHELL_TEXT.en, act).filter((x) => x.label).map((x) => x.label).join("/"), "Show window/New task/Quit", "  └ 英文界面就是英文菜单");
  const mkTray = (over) => {
    const calls = { tip: [], menus: [], js: [], quit: 0, shown: 0 };
    const env = {
      tray: { isDestroyed: () => false, setToolTip: (s) => calls.tip.push(s), setContextMenu: (m) => calls.menus.push(m) },
      T, LAST_UI_LANG: "", osLang: () => "zh", trayMenuItems, trayLang: "",
      Menu: { buildFromTemplate: (t) => t },
      showMainWindow: () => { calls.shown++; return true; },
      win: { webContents: { executeJavaScript: (code) => { calls.js.push(code); return Promise.resolve(); } } },
      requestQuit: () => { calls.quit++; },
      ...(over || {}),
    };
    return { refreshTray: load("refreshTray", env), calls };
  };
  {
    const t = mkTray();
    t.refreshTray();
    eq(t.calls.tip[0], SHELL_TEXT.zh.trayTip, "托盘悬停提示从字典来");
    const menu = t.calls.menus[0] || [];
    (menu.find((x) => x.label === "新建任务") || { click: () => {} }).click();
    ok(t.calls.shown === 1 && /getElementById\("new-task"\)/.test(t.calls.js[0] || "") && /\.click\(\)/.test(t.calls.js[0] || ""),
       "「新建任务」：先把窗口叫出来，再按页面上那颗新建任务按钮（新建要清什么由页面说了算）", t.calls);
    (menu.find((x) => x.label === "退出") || { click: () => {} }).click();
    eq(t.calls.quit, 1, "「退出」走 requestQuit，不是直接 app.quit");
    t.refreshTray("en");
    ok(t.calls.tip[1] === SHELL_TEXT.en.trayTip && ((t.calls.menus[1] || [])[0] || {}).label === SHELL_TEXT.en.trayShow, "界面切成英文，托盘跟着换");
    t.refreshTray("en");
    t.refreshTray("en");
    eq(t.calls.menus.length, 2, "  └ 语言没变就不重建（失焦、划过托盘都会来问；Windows 上右键托盘那一下主窗口正好失焦，开着的菜单不能被换掉）");
    t.refreshTray("zh");
    ok(t.calls.menus.length === 3 && ((t.calls.menus[2] || [])[0] || {}).label === SHELL_TEXT.zh.trayShow, "  └ 切回中文：又换回来", t.calls.menus.length);
  }
  {
    let n = 0;
    const t = mkTray({ Menu: { buildFromTemplate: (x) => { if (n++ === 0) throw new Error("菜单建不起来"); return x; } } });
    try { t.refreshTray("zh"); } catch {}
    t.refreshTray("zh");
    eq(t.calls.menus.length, 1, "  └ 上一回中途抛了：下回还会再建（没换成的不算换过）");
  }
  {
    const t = mkTray({ showMainWindow: () => false });
    t.refreshTray();
    (t.calls.menus[0].find((x) => x.label === "新建任务") || { click: () => {} }).click();
    eq(t.calls.js.length, 0, "  └ 主窗口已经没了：不往死窗口上跑脚本");
  }
  {
    const t = mkTray({ tray: { isDestroyed: () => true, setToolTip: () => { throw new Error("destroyed"); }, setContextMenu: () => {} } });
    let threw = null;
    try { t.refreshTray(); } catch (e) { threw = e; }
    ok(!threw, "托盘已经销毁：什么都不做，不抛");
  }
  ok(/id="new-task"/.test(fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8")),
     "  └ 页面上真有 #new-task 那颗按钮（它改名了，托盘这条就成了空按）");
  ok(/global\.__wbWin = win;[\s\S]{0,400}?\n {2}createTray\(\);/.test(mainSrc), "托盘在主窗口挂到 global 之后才建（点它要唤起主窗口）");
  ok(/if \(tray\) tray\.destroy\(\);/.test(mainSrc), "  └ 退出时收掉（Windows 上不收，托盘里会留个鼠标划过才消失的空图标）");
}

// ===================================================================
// 【12】存盘不许盖掉外面手改的（config-merge）
// ===================================================================
function runConfigGates() {
  const cfgMerge = require(path.join(ROOT, "config-merge"));
  const cfgLint = require(path.join(ROOT, "config-lint"));
  const serverSrc = srcLib.src("server");
  const cliSrc = fs.readFileSync(path.join(ROOT, "cli.js"), "utf8");

  console.log("\n【12】存盘不许盖掉外面手改的——用户在编辑器里粘的 Key 一个字不能少");

  // 现场还原那条抱怨：启动时读到的是 base，用户在界面上把端口改成 3810（cur），
  // 与此同时他在编辑器里往 models[0] 粘了真 Key、又加了一条 mcp_servers（disk）。
  const base = { server: { port: 3800 }, models: [{ name: "m1", api_key: "" }], agent: { engine: "builtin" } };
  const cur = { server: { port: 3810 }, models: [{ name: "m1", api_key: "" }], agent: { engine: "builtin" } };
  const disk = {
    server: { port: 3800 },
    models: [{ name: "m1", api_key: "sk-用户刚粘进去的" }],
    agent: { engine: "builtin" },
    mcp_servers: { fs: { command: "npx" } },
  };
  const { merged, changed } = cfgMerge.mergeOnto(disk, base, cur);
  eq(merged.models[0].api_key, "sk-用户刚粘进去的", "手粘的 API Key 活下来了（老写法这里是空串，用户以为「填了不生效」）");
  ok(merged.mcp_servers && merged.mcp_servers.fs, "手加的整块（mcp_servers）也还在");
  eq(merged.server.port, 3810, "界面上那次改动确实落下去了（只保命不落盘等于保存按钮坏了）");
  eq(changed.length, 1, "而且只盖了一处——这是「不整份覆盖」的全部意义", changed);

  // ★反向对照★：没改过任何东西时，合并必须是个空操作。
  // 少了这条，上面那些断言在「mergeOnto 什么都不做」的实现下照样全绿。
  const untouched = { server: { port: 3800 }, models: [{ name: "m1", api_key: "sk-别人的" }] };
  const before = JSON.stringify(untouched);
  const r0 = cfgMerge.mergeOnto(untouched, base, cfgMerge.snapshot(base));
  eq(r0.changed.length, 0, "反向对照：这个进程什么都没改时，算出来的改动是 0 处");
  eq(JSON.stringify(untouched), before, "  └ 磁盘那份一个字节都没动");

  // 删除也是改动。只合并「新增和修改」的话，界面上删掉的渠道存一次就自己回来了
  const delChanged = cfgMerge.changedPaths({ im: { feishu: { app_id: "x" }, qq: { on: true } } }, { im: { feishu: { app_id: "x" } } });
  eq(delChanged.length, 1, "删掉一整块算一处改动");
  eq(delChanged[0] && delChanged[0].remove, true, "  └ 而且标成 remove（不然合并时它会原样留在磁盘那份上）");
  const delDisk = { im: { feishu: { app_id: "x" }, qq: { on: true } }, keep: 1 };
  cfgMerge.applyAt(delDisk, ["im", "qq"], undefined, true);
  ok(!("qq" in delDisk.im), "  └ applyAt 真把它删掉了");
  eq(delDisk.keep, 1, "  └ 旁边的没受牵连");

  // 数组整条算一个叶子：用户是整条换 models 的，逐项合并只会合出一张谁也没要过的混合表
  const arr = cfgMerge.changedPaths({ models: [{ n: 1 }, { n: 2 }] }, { models: [{ n: 1 }] });
  eq(arr.length, 1, "数组变了算一处");
  eq(JSON.stringify(arr[0].path), JSON.stringify(["models"]), "  └ 路径停在 models 这一层，不往数组里钻", arr[0].path);
  eq(arr[0].value.length, 1, "  └ 盖的是整条新数组（删掉的那条不许被合回来）");

  // 路上缺层要补出来：磁盘那份可能被用户整块删了 agent，这时候按 agent.engine 盖不能炸
  const thin = {};
  cfgMerge.applyAt(thin, ["agent", "engine_options", "claude-code", "model"], "opus");
  eq(thin.agent.engine_options["claude-code"].model, "opus", "路上缺的层会补成对象（磁盘那份缺了整块也盖得进去）");
  // 挡在半路的标量不能让它把整条路吞掉
  const blocked = { agent: "字符串" };
  cfgMerge.applyAt(blocked, ["agent", "engine"], "codex");
  eq(blocked.agent.engine, "codex", "半路被一个标量挡住时也补成对象，不是静默失败");

  eq(cfgMerge.mtimeOf(path.join(TMP, "根本没有这个文件.json")), 0, "文件不在时 mtime 返回 0（调用方据此跳过合并，不是拿 NaN 去比）");
  eq(JSON.stringify(cfgMerge.snapshot({ a: { b: 1 } })), JSON.stringify({ a: { b: 1 } }), "snapshot 是深拷");
  const deep = { a: { b: 1 } };
  const snap = cfgMerge.snapshot(deep);
  deep.a.b = 2;
  eq(snap.a.b, 1, "  └ 深到能挡住就地改（浅拷的话基线会跟着内存一起变，差集永远是空的）");

  // 接线钉在源码上：这几行改回去，上面的单元测试照样全绿
  ok(/function saveConfig\(\)/.test(serverSrc) && /if \(now && CONFIG_MTIME && now !== CONFIG_MTIME\) mergeDiskEdits\(\);/.test(serverSrc),
     "server.js 存盘前先比一眼文件改动时间，不一样就先合并");
  const directWrites = (serverSrc.match(/store\.writeJsonAtomic\(CONFIG_PATH/g) || []).length;
  eq(directWrites, 1, "全 server.js 只有 saveConfig 一处直接写 config.json（多一处就是一个绕过合并的后门）", directWrites);
  ok(/for \(const k of Object\.keys\(config\)\) delete config\[k\];\s*\n\s*Object\.assign\(config, disk\);/.test(serverSrc),
     "合并后换内容不换对象（llm / security / tools 启动时就攥着 config 的引用，换对象=界面显示新值、干活用老值）");
  ok(/mergeDiskEdits\(\)[\s\S]{0,900}?fillDefaults\(disk, CONFIG_DEFAULTS\);/.test(serverSrc),
     "  └ 合完重新补一遍默认值（用户可能把 server 整块删了，少了兜底下一行就崩）");
  ok(/mergeDiskEdits\(\)[\s\S]{0,1100}?security\.getSecurity\(config\);/.test(serverSrc),
     "  └ 安全策略也跟着新内容重算");
  // 同一个病在命令行那边也有一份：openworkbuddy engine 探测引擎要跑好几秒，这期间桌面端很可能刚存过
  ok(/const latest = store\.readJson\(CONFIG_PATH, config\) \|\| config;[\s\S]{0,200}?store\.writeJsonAtomic\(CONFIG_PATH, latest/.test(cliSrc),
     "openworkbuddy engine 存盘前重新读一遍磁盘，不拿几秒前的整份内存盖回去");

  // ===================================================================
  console.log("\n【13】配置写错了当场说——但不许喊狼");

  const template = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  const broken = cfgLint.lint({
    provider: "opeani",                 // 取值不在册
    server: { port: "3800" },           // 该数字给了文本
    agent: { max_step: 30, engine: "claude" }, // 键名少个 s；引擎名不在册
  }, template);
  const paths = broken.map((f) => f.path).sort();
  eq(JSON.stringify(paths), JSON.stringify(["agent.engine", "agent.max_step", "provider", "server.port"]),
     "四处都查出来了：取值不在册 / 类型写错 / 键名拼错 / 引擎名不在册", paths);
  eq(broken.find((f) => f.path === "server.port").level, "bad", "端口写成文本是硬错（服务根本起不到那个口上）");
  eq(broken.find((f) => f.path === "agent.engine").level, "bad", "引擎名不在册也是硬错（启动当场抛一句用户看不懂的话）");
  eq(broken.find((f) => f.path === "agent.max_step").level, "warn", "键名疑似拼错只是提醒（说不定是给以后留的）");
  ok(/max_steps/.test(broken.find((f) => f.path === "agent.max_step").hint), "  └ 而且直接说出「你是不是想写 max_steps」");
  ok(cfgLint.lines(broken).every((l) => /^[×▲] /.test(l)), "排出来的每行都带档位记号（启动日志和 openworkbuddy doctor 共用这一份措辞）");

  // ★反向对照★ 一：自带模板必须一条都查不出来。查得出来说明尺子本身是歪的。
  eq(cfgLint.lint(template, template).length, 0, "反向对照：自带的 config.example.json 一条都不报");

  // 模板里写的默认值，必须跟代码里 `|| 数字` 那个兜底是同一个数。
  // 真出过：config.example.json 写 max_runtime_ms=600000（10 分钟），agent.js 四处兜底
  // 全是 1800000（30 分钟），server.js 回给前端的也是 1800000，设置页文案却写「默认 10」。
  // 四处没一个对得上，谁看都觉得自己那份是对的。这种漂移编译器一辈子抓不到，
  // 只能钉在这儿：改了一边没改另一边，这条就红。
  const agentSrc = fs.readFileSync(path.join(__dirname, "..", "agent.js"), "utf8");
  for (const key of ["max_runtime_ms", "max_steps"]) {
    const nums = [...agentSrc.matchAll(new RegExp("config\\.agent\\." + key + "\\s*\\|\\|\\s*(\\d+)", "g"))].map((m) => +m[1]);
    ok(nums.length > 0, `agent.js 里找不到 ${key} 的兜底值了（这条尺子失效了，别让它绿着）`);
    ok(new Set(nums).size === 1, `agent.js 内部 ${key} 的兜底值就有好几个：${nums.join(" / ")}`);
    eq(template.agent[key], nums[0], `模板里的 ${key} 跟 agent.js 的兜底值对不上`, `模板 ${template.agent[key]} vs 代码 ${nums[0]}`);
  }

  // 设置页那颗「保存」真往 agent 里写的每一个键，config-lint 都必须认识。
  // 真出过：auto_continue_rounds 只活在 KNOWN_EXTRA 那份补充名册里，模板里没有——
  // 于是它在设置页存得进去，在 config.example.json 里查不到，谁想知道默认值是多少
  // 都只能翻源码。反过来更糟：哪天在设置页加个新字段却忘了登记，用户一存盘，
  // 下次开机体检就冲他喊一句「agent.xxx 不认识，是不是拼错了」——而他什么都没拼错。
  // 断言钉在 lint 的结论上，不钉在「我以为它在哪份名册里」：两份名册哪一份收了它都行。
  const app05 = fs.readFileSync(path.join(ROOT, "public", "js", "app-05.js"), "utf8");
  // 往 agent 里写的地方不止一处：智能体设置页存的是一大把，而「主模型挂了换谁」那颗下拉
  // 已经挪到模型页的对话卡里，自己单独存一个 failover_model。只咬第一处的话，非贪婪的正则
  // 会停在那个只有一个字段的小块上，后面整串断言就全成了假绿（这条真踩过）。所以全都收上来取并集。
  const agBlocks = [...app05.matchAll(/saveSettings\(\{\s*agent:\s*\{([\s\S]*?)\}\s*\}/g)];
  ok(agBlocks.length >= 1, "在 app-05.js 里找不到设置页保存 agent 的那段了（这条尺子失效了，别让它绿着）");
  const savedKeys = [...new Set(agBlocks.flatMap((b) => [...b[1].matchAll(/^\s*([a-z_][a-z0-9_]*)\s*:/gim)].map((m) => m[1])))];
  ok(savedKeys.length >= 8, `  └ 解析出 ${savedKeys.length} 个字段（太少说明正则没咬住，下面那一串就都是假绿）`, savedKeys);
  for (const k of savedKeys) {
    // ① 登记过没。两处名册任选一处：写进模板就等于顺带公布了默认值，
    // 进 KNOWN_EXTRA 则是「程序自己会加、不必让用户看见」。两处都没有 = 谁也不认识它，
    // 而这种漏登记是纯静默的——存得进去、查不出来、下次想知道默认值只能翻源码。
    ok(template.agent[k] !== undefined || (cfgLint.KNOWN_EXTRA.agent || []).includes(k),
      `  └ 设置页存的 agent.${k} 登记在册（模板里有默认值，或在 KNOWN_EXTRA 名册里）`, k);
    // ② 顺带确认体检不会冲它喊「是不是拼错了」——新加的字段跟已有的长得像时会踩这条
    const probe = { agent: { [k]: template.agent[k] !== undefined ? template.agent[k] : "" } };
    const found = cfgLint.lint(probe, template);
    eq(found.length, 0, `  └ 存进去之后开机体检不报它`, found.map((f) => f.text));
  }

  // ★反向对照★ 二：一份跑着的真配置也必须安静。程序自己就会往里加 projects / security /
  // providers 这些模板里没有的键，见一个生键喊一句的话，喊到第三次用户就再也不看这些提示了。
  const live = {
    server: { port: 3800, host: "127.0.0.1" },
    provider: "openai",
    agent: { engine: "builtin", max_steps: 30, engine_options: { "claude-code": { bin: "" } }, failover_model: "" },
    providers: { openrouter: { base_url: "https://x", api_key: "" } },
    models: [{ name: "m1", model: "gpt-x", api_key: "" }],
    media_models: [], projects: [], security: { mode: "ask" }, shortcuts: { toggle: "Alt+Space" },
    pet: { enabled: true }, assistant: { name: "小秘", avatar: "@cat" }, onboarding: { done: true },
    workspace_dir: "", last_picked_model: "", assist_model: "", model_follow_last: false,
    im: { feishu: { app_id: "" }, permission_mode: "ask" },
  };
  const liveFound = cfgLint.lint(live, template);
  eq(liveFound.length, 0, "反向对照：一份跑着的真配置一条都不报", liveFound.map((f) => f.text));
  // providers 是这条尺子上最险的一格：它跟模板里的 provider 只差一个字母，
  // 光看「像不像」必然被判成错别字，可它是每份真配置里都有的正经设置项。
  eq(cfgLint.nearest("providers", ["provider"]), "provider", "  └ 光比字形的话，providers 确实像 provider 的错别字……");
  ok(cfgLint.KNOWN_EXTRA[""].includes("providers"), "  └ ……所以它得在「程序自己会加的键」名册里");
  eq(cfgLint.lint({ providers: { openrouter: {} } }, template).length, 0, "  └ 结果是一声不吭（这一格判错，用户天天被喊一次狼）");

  // 尺子自己的刻度：太短的键容错要更严，不然 im → ai 这种会互相误报
  eq(cfgLint.nearest("max_step", ["max_steps", "host"]), "max_steps", "长键差一个字母，算拼错");
  eq(cfgLint.nearest("ai", ["im", "host"]), "", "  └ 但两个字母差一个就是另一个词了，不猜");
  eq(cfgLint.nearest("完全不像的东西", ["port", "host"]), "", "  └ 不像的一概闭嘴（生键天天有，喊三次狼就没人看了）");
  eq(cfgLint.lint({ _说明: "这是给人看的注释" }, template).length, 0, "模板里那几条 _说明 / _mcp_示例 是注释，不当配置查");
  eq(cfgLint.lint({ mcp_servers: {} }, template).length, 0, "模板里留空的字段（mcp_servers: []）不拿来判类型，那本来就是「等你填」的占位");
  eq(cfgLint.lint({ mcp_servers: "npx" }, template).length, 0, "  └ 留空的字段填成什么都不报——尺子量不准的地方就别量");
  eq(cfgLint.lint({ agent: { max_steps: "25" } }, template).length, 1, "  └ 反向对照：模板里有真值的字段（agent.max_steps: 25）写成文本照样报");
  eq(cfgLint.lint(null, template).length, 0, "配置读不出来时体检自己不许炸");

  // 接线：查出来得有人说。只写个模块不接，等于没写
  ok(/cfgLint\.lines\(cfgLint\.lint\(config, CONFIG_DEFAULTS\)\)/.test(serverSrc), "启动时真的跑一遍体检并打出来");
  const doctorSrc = fs.readFileSync(path.join(ROOT, "doctor.js"), "utf8");
  ok(/verdictConfigLint\(/.test(doctorSrc) && /require\("\.\/config-lint"\)/.test(doctorSrc),
     "openworkbuddy doctor 里也有这一行（用户不看启动日志，但出事时会跑 doctor）");
  const doctor = require(path.join(ROOT, "doctor"));
  eq(doctor.verdictConfigLint([]).level, "ok", "doctor：没查出问题时这行是绿的");
  eq(doctor.verdictConfigLint([{ level: "warn", text: "t", hint: "h" }]).level, "warn", "  └ 只有提醒时是黄的");
  eq(doctor.verdictConfigLint([{ level: "warn", text: "t", hint: "h" }, { level: "bad", text: "t2", hint: "h2" }]).level, "bad",
     "  └ 里面有一条硬错，整行就是红的（一红一黄取红，不然硬错会被旁边的黄条盖过去）");

  // ===================================================================
  console.log("\n【14】项目规范（AGENTS.md / CLAUDE.md）：带不全得说，别让模型以为自己看的是全本");

  const memoMod = require(path.join(ROOT, "project-memo"));
  const MEMO_MAX = memoMod.MEMO_MAX;
  ok(MEMO_MAX > 0, "project-memo.js 里能取到项目规范的长度上限", MEMO_MAX);

  const warns = [];
  const mkWarnOnce = () => {
    const seen = new Set();
    return (key, msg) => { if (seen.has(key)) return; seen.add(key); warns.push(msg); };
  };
  const mkClamp = (warnOnce) => (txt, fname, fp) => memoMod.clampMemo(txt, fname, fp, MEMO_MAX, warnOnce);

  // 超长：老写法是 .slice(0, 6000)，模型收到的是一份**看起来完整**的规范——
  // 后半截的规矩它压根不知道存在，于是照着前半截干，用户以为规范写了就生效了。
  const long = "规矩一。\n\n" + "凑".repeat(MEMO_MAX * 2) + "\n\n最后这条规矩在末尾。";
  let clamped = mkClamp(mkWarnOnce())(long, "AGENTS.md", "/p/AGENTS.md");
  ok(clamped.length < long.length, "超长的规范会被截断（再长就开始挤掉提示词里别的东西）");
  ok(/只放了前面一部分/.test(clamped), "  └ 截断这件事写在交给模型的那段文字里（模型知道自己看的不是全本）");
  ok(/read_file/.test(clamped), "  └ 并且告诉它拿不准就自己去把整份读一遍");
  ok(!clamped.includes("最后这条规矩在末尾"), "  └ 后半截确实没带上（这正是必须说明的理由）");
  eq(warns.length, 1, "  └ 控制台也喊一句，不然用户永远不知道自己的规范被砍了一半");
  ok(/AGENTS\.md/.test(warns[0]) && /上限/.test(warns[0]), "  └ 喊的这句里有文件名和上限", warns[0]);

  // ★反向对照★：没超长的一个字都不许动，也不许喊
  warns.length = 0;
  const short = "只有三条规矩。";
  eq(mkClamp(mkWarnOnce())(short, "AGENTS.md", "/p/AGENTS.md"), short, "反向对照：没超长的原样交出去，一个字不改");
  eq(warns.length, 0, "  └ 也不喊（没事找事的提醒喊三次就没人看了）");

  // 断在段落边界上，别切在半句话中间
  warns.length = 0;
  const para = "第一段。\n\n" + "甲".repeat(MEMO_MAX - 20) + "\n\n" + "乙".repeat(500);
  clamped = mkClamp(mkWarnOnce())(para, "CLAUDE.md", "/p/CLAUDE.md");
  ok(clamped.startsWith("第一段。"), "从段落边界断开，不是从半句话中间切");
  ok(!clamped.includes("乙"), "  └ 边界之后的没带上");

  // 同一件事只喊一次：这段在每趟任务开头都会走一遍，喊三次就再没人看了
  warns.length = 0;
  const w1 = mkWarnOnce();
  const clamp1 = mkClamp(w1);
  clamp1(long, "AGENTS.md", "/p/AGENTS.md");
  clamp1(long, "AGENTS.md", "/p/AGENTS.md");
  clamp1(long, "AGENTS.md", "/p/AGENTS.md");
  eq(warns.length, 1, "同一份文件喊过一次就不再喊（每趟任务都走一遍这条路）");

  // projectContextOf：空的 AGENTS.md 不许把旁边的 CLAUDE.md 挡在门外
  const PDIR = path.join(TMP, "memo-proj");
  fs.mkdirSync(PDIR, { recursive: true });
  const mkCtx = (warnOnce) => new Function(
    "experts", "skillsMgr", "config", "projectMemo",
    slice("server.js", "projectContextOf") + "\nreturn projectContextOf;"
  )([], { loadSkills: () => [] }, {}, { memoContext: (dir) => memoMod.memoContext(dir, { warn: warnOnce }) });

  fs.writeFileSync(path.join(PDIR, "AGENTS.md"), "   \n\n  ");
  fs.writeFileSync(path.join(PDIR, "CLAUDE.md"), "这里写满了项目规矩：提交前先跑测试。");
  warns.length = 0;
  let ctx = mkCtx(mkWarnOnce())({ dir: PDIR });
  ok(/提交前先跑测试/.test(ctx),
     "空的 AGENTS.md 不再把写满规矩的 CLAUDE.md 挡在门外（老写法在空文件那儿就 break 了，规矩一条都带不上）");

  // ★反向对照★：AGENTS.md 有内容时仍旧只带它一份，没变成两份都塞进去
  fs.writeFileSync(path.join(PDIR, "AGENTS.md"), "AGENTS 里的规矩。");
  ctx = mkCtx(mkWarnOnce())({ dir: PDIR });
  ok(/AGENTS 里的规矩/.test(ctx), "反向对照：AGENTS.md 有内容时带的是它");
  ok(!/提交前先跑测试/.test(ctx), "  └ 而且只带一份，没顺手把 CLAUDE.md 也塞进提示词");

  // 读不出来（这儿把它做成一个目录）：以前是个 catch {}，规范没带上、模型照跑、用户毫不知情
  fs.rmSync(path.join(PDIR, "AGENTS.md"));
  fs.mkdirSync(path.join(PDIR, "AGENTS.md"));
  warns.length = 0;
  ctx = mkCtx(mkWarnOnce())({ dir: PDIR });
  eq(warns.length, 1, "规范读不出来时喊一句（以前这儿是个 catch {}，出事了一点声都没有）");
  ok(/没带上/.test(warns[0]), "  └ 说的是「这一趟没带上它」，不是一句看不懂的报错", warns[0]);
  ok(/提交前先跑测试/.test(ctx), "  └ 而且继续往下找 CLAUDE.md，不是整段规范都不要了");
  ok(/txt = fs\.readFileSync\(fp, "utf8"\)\.trim\(\);\s*\n\s*\} catch \(e\) \{/.test(fs.readFileSync(path.join(ROOT, "project-memo.js"), "utf8")),
     "  └ 源码里这次读接的是带错误对象的 catch，不是那个吞掉一切的空 catch");
  fs.rmSync(PDIR, { recursive: true, force: true });

  // 往上找到 git 仓库根：子目录里开工，根上那份通用规矩也得带上（Codex / Claude Code 都这么干）
  const REPO = path.join(TMP, "memo-repo");
  fs.mkdirSync(path.join(REPO, ".git"), { recursive: true });
  fs.mkdirSync(path.join(REPO, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(REPO, "AGENTS.md"), "根规矩R");
  fs.writeFileSync(path.join(REPO, "a", "b", "CLAUDE.md"), "深处规矩B");
  const quiet = { warn: () => {} };
  let files = memoMod.memoFiles(path.join(REPO, "a", "b"), quiet);
  eq(files.map((f) => f.rel).join("|"), "../../AGENTS.md|CLAUDE.md", "从子目录往上走到 git 根：两份都找到，根在前，路径写成相对工作目录的（模型要 read_file 就照着读）");
  ctx = memoMod.memoContext(path.join(REPO, "a", "b"), quiet);
  ok(ctx.indexOf("根规矩R") < ctx.indexOf("深处规矩B") && /以靠后的为准/.test(ctx), "  └ 拼进提示词时根在前、越靠后越具体，并且说了冲突听谁的");
  ok(!/以靠后的为准/.test(memoMod.memoContext(REPO, quiet)), "  └ 反向对照：只有一份时不多嘴那句「冲突听谁的」");
  // .git 是文件（worktree / submodule）也算仓库根
  const WT = path.join(REPO, "a", "wt");
  fs.mkdirSync(WT, { recursive: true });
  fs.writeFileSync(path.join(WT, ".git"), "gitdir: /elsewhere");
  eq(memoMod.chainToGitRoot(WT).join("|"), WT, "worktree 里 .git 是个文件，也在那儿停，不再往上带外层仓库的规矩");

  // 不在 git 仓库里：只看工作目录本身，不许一路爬到 ~/AGENTS.md
  const LOOSE = path.join(TMP, "memo-loose");
  fs.mkdirSync(path.join(LOOSE, "sub"), { recursive: true });
  fs.writeFileSync(path.join(LOOSE, "AGENTS.md"), "外面的规矩X");
  eq(memoMod.memoFiles(path.join(LOOSE, "sub"), quiet).length, 0, "不在仓库里：子目录没放就是没有，不往上捡别人的规矩");
  eq(memoMod.memoFiles(LOOSE, quiet).map((f) => f.rel).join("|"), "AGENTS.md", "  └ 反向对照：工作目录自己放了就带上");

  // 字数上限几份共用，离工作目录近的先分：子目录的最具体，挤不下时该让的是根上那份
  fs.writeFileSync(path.join(REPO, "a", "b", "CLAUDE.md"), "深".repeat(MEMO_MAX - 100));
  warns.length = 0;
  files = memoMod.memoFiles(path.join(REPO, "a", "b"), { warn: mkWarnOnce() });
  eq(files[1].chars, MEMO_MAX - 100, "几份共用上限：离工作目录最近的那份整份带上");
  ok(files[0].body === null, "  └ 根上那份分不到字数就不带（不是两份各砍一半，砍成两份都不完整的）");
  ok(warns.some((w) => /没带上/.test(w) && /AGENTS\.md/.test(w)), "  └ 控制台说一声是哪份没带上", warns);
  ctx = memoMod.memoContext(path.join(REPO, "a", "b"), quiet);
  ok(/\.\.\/\.\.\/AGENTS\.md 也是项目规范/.test(ctx) && /read_file/.test(ctx), "  └ 提示词里也留一句：还有这份没给你，涉及了自己去读");
  const all = files.reduce((n, f) => n + f.chars, 0);
  ok(all <= MEMO_MAX, "  └ 加起来没超上限", all);
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.rmSync(LOOSE, { recursive: true, force: true });
}
