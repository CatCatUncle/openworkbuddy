"use strict";
/**
 * 企业管理后台（/admin.html + public/js/admin.js）的真浏览器测试。
 *
 * 跑法：npx electron test/admin-ui.js（由 test/e2e.js 拉起；没装 electron 就整体跳过）
 *
 * 为什么非得开真 Chromium：这一页是 19 个面板 + 哈希路由 + 弹窗表单，六成的坏法是
 * 「某一页 render 里读了个 undefined，整块白屏」——这种错在 node 里一个字节都测不出来，
 * 只有真的把每一页点一遍、盯着 console 有没有报错才看得见。
 *
 * 后端不是打桩的：这里起的是 account.createRouter + admin.createAdminRouter 的真路由，
 * 中间件顺序照抄 server.js。所以「前端以为后端返回 X、后端其实返回 Y」这类错也跑得出来。
 */


// ---- 加载期出错要当场红，不许弹框卡死 ----
// 2026-09-13 的教训：这个文件顶层抛了一个「缺文件」的错（skills/brand-guidelines 在
// .gitignore 里，本机有、新克隆没有），Electron 的默认处理是弹一个原生错误框
// ——CI 机器上没人点确定，进程就一直挂着。本机复现过：不装兜底 25 秒后被 timeout 砍掉，
// 装了兜底立刻退出并打出真正的错。
// Electron 的 uncaughtException 处理里有一句「用户自己装了处理器就不弹框」
// （判据是 listenerCount > 1），所以这一段必须在任何 require 之前。
process.on("uncaughtException", (e) => {
  console.error("\u274c 企业后台测试 加载期就炸了（不是断言失败，是这个文件自己起不来）：");
  console.error((e && e.stack) || String(e));
  process.exit(1);
});
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-adminui-"));
process.env.OPENWORKBUDDY_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });

// 这个文件得用 electron 跑，不是 node：`npx electron test/admin-ui.js`。
// 用 node 跑的话下面 require("electron") 拿到的是个字符串（electron 包的 npm 入口导出的是
// 二进制路径），一路往下走到最后才炸一个 "Cannot read properties of undefined"，
// 看到的人根本猜不到是跑法不对。在这儿就说清楚。
if (typeof require("electron") === "string") {
  console.error("❌ 这个测试要用 electron 跑：npx electron test/admin-ui.js");
  process.exit(1);
}
const { app: electronApp, BrowserWindow } = require("electron");

// 看门狗，理由同 test/frontend.js：CI 的无头机器上 electron 可能连 whenReady 都不回，
// 父进程强杀只拿得到一具尸体。这里自己记「ready 没有 / 最后跑完哪一步」，超时先说清楚再退。
const WATCH_MS = Number(process.env.OPENWORKBUDDY_TEST_WATCHDOG_MS || 180000);
let READY = false;
let LAST_LINE = "（一步都还没跑完）";
const _log = console.log.bind(console);
console.log = (...a) => { LAST_LINE = a.map(String).join(" ").trim(); _log(...a); };
const WATCHDOG = setTimeout(() => {
  console.error(
    `❌ 企业后台测试卡死：${Math.round(WATCH_MS / 1000)} 秒没跑完。` +
    `app.whenReady ${READY ? "已经回来了" : "从来没回来——这台机器上 electron 根本起不来"}；` +
    `最后跑完的一步：${LAST_LINE}`
  );
  process.exit(1);
}, WATCH_MS);

const express = require("express");
const ROOT = path.join(__dirname, "..");
const account = require(path.join(ROOT, "account"));
const org = require(path.join(ROOT, "org"));
const admin = require(path.join(ROOT, "admin"));
const tools = require(path.join(ROOT, "tools"));
const chatModels = require(path.join(ROOT, "chat-models"));
const mediaModels = require(path.join(ROOT, "media-models"));

const BASE_WS = path.join(TMP, "workspace");
fs.mkdirSync(BASE_WS, { recursive: true });
tools.setWorkspaceDir(BASE_WS);

let pass = 0;
const names = [];
const ok = (msg, cond, extra) => {
  if (cond) { pass++; names.push(msg); console.log("  ✓ " + msg); }
  else throw new Error(msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : ""));
};

// ---------- 中间件顺序照抄 server.js：静态文件在登录闸**之前**（/admin.html 本身是公开的 HTML，
// 它背后的每一条数据才要身份）----------
const srv = express();
srv.use(express.json());
srv.use(express.static(path.join(ROOT, "public")));
srv.use(account.createRouter({}));
srv.use(account.authGuard);
srv.use(admin.tenantScope({ withWorkspace: tools.withWorkspace, withPolicy: tools.withPolicy, getWorkspaceDir: tools.getWorkspaceDir }));
srv.use(admin.platformGuard);
srv.use(admin.redactGuard);

// ---------- /api/settings 的替身 ----------
// 「模型与 Key」那一页读的是 /api/settings，而这份 express 只挂了账号和后台两个路由——
// 真的那条在 server.js 里是内联写的，搬不过来。所以这儿照它的口径回一份。
// 替身最怕的是「悄悄跟真的走散」：这边一直绿，线上那页却读到 undefined。
// 所以 test/e2e.js 里有一条契约断言，拿**真的** GET /api/settings 逐个字段核对
// （providers[].has_key、models[].channel、platform_owner、agent.failover_model…），
// 少一个字段那边就红。两边合起来才算把这一页保住了。
const FAKE = {
  providers: [
    { id: "ark", name: "火山方舟", kind: "ark", base_url: "https://ark.example/api/v3", api_key: "sk-ark-demo" },
    { id: "openrouter", name: "OpenRouter", kind: "openrouter", base_url: "https://openrouter.example/api/v1", api_key: "" },
    { id: "local", name: "本机 Ollama", kind: "ollama", base_url: "http://127.0.0.1:11434/v1", api_key: "" },
    // 同一个地址两条渠道、名字还一模一样——这是用户真实配置里的样子（两个账号各一把 Key）。
    // 合并它们等于在不知情的情况下花别人的额度，所以界面只能标出来，不能并。
    { id: "gw1", name: "内网网关", kind: "custom", base_url: "https://gw.example/v1", api_key: "sk-gw-a" },
    { id: "gw2", name: "内网网关", kind: "custom", base_url: "https://gw.example/v1", api_key: "sk-gw-b" },
  ],
  models: [
    { name: "方舟-主力", model: "doubao-pro", channel: "ark" },
    { name: "OR-备用", model: "anthropic/claude", channel: "openrouter" },
  ],
  media_models: [{ id: "m1", name: "方舟出图", provider: "ark", model: "seedream", caps: ["image"] }],
  active_model: "方舟-主力",
  agent: { failover_model: "" },
};
chatModels.normalize(FAKE); // 让 api_key 照真实路径从渠道压平到模型上，别在替身里手抄一遍
srv.get("/api/settings", (req, res) => {
  const owner = admin.isSoloDesktop() || admin.ownsGlobalWorkspace(req.user);
  const mask = (k) => (owner ? k || "" : k ? "********" : "");
  res.json({
    ...FAKE,
    platform_owner: owner,
    providers: FAKE.providers.map((p) => ({ ...p, api_key: mask(p.api_key), has_key: !!p.api_key })),
    models: FAKE.models.map((m) => ({ ...m, api_key: mask(m.api_key), has_key: !!m.api_key })),
  });
});
srv.get("/api/model-catalog", (req, res) => res.json({ kinds: mediaModels.PROVIDER_KINDS }));
const savedSettings = [];
srv.post("/api/settings", (req, res) => { savedSettings.push(req.body || {}); res.json({ ok: true }); });

srv.use(admin.createAdminRouter({ orgUsage: () => ({ files: tools.outputFiles().length, bytes: 0 }) }));
const server = srv.listen(0, "127.0.0.1");
const listening = new Promise((r) => server.once("listening", r));

function call(method, url, { body, cookie } = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = require("http").request(
      { host: "127.0.0.1", port: server.address().port, method, path: url,
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

/** 开一个窗口，把登录 cookie 塞进它的会话，加载 /admin.html，等 boot() 跑完 */
async function openAdmin(cookieStr, tag) {
  const { session } = require("electron");
  const ses = session.fromPartition("persist:" + tag);
  const base = `http://127.0.0.1:${server.address().port}`;
  await ses.clearStorageData();
  const [name, value] = String(cookieStr).split(/=(.*)/s);
  await ses.cookies.set({ url: base, name, value, httpOnly: true, path: "/" });
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: ses } });
  const errs = [];
  win.webContents.on("console-message", (...a) => {
    // 新老两套签名都认（Electron 改过一次，老的是位置参数，新的是一个事件对象）
    const e = a[0] && typeof a[0] === "object" && "level" in a[0] ? a[0] : { level: a[1], message: a[2] };
    const lvl = String(e.level);
    if (lvl === "error" || lvl === "3") errs.push(String(e.message).slice(0, 300));
  });
  win.webContents.on("render-process-gone", (_e, d) => errs.push("渲染进程没了：" + JSON.stringify(d)));
  await win.loadURL(base + "/admin.html");
  await win.webContents.executeJavaScript(`new Promise((r) => {
    const t0 = Date.now();
    (function w() {
      const b = document.getElementById("ad-body");
      if (b && !b.querySelector(".ui-skeleton") && b.textContent.trim()) return r(1);
      if (Date.now() - t0 > 8000) return r(0);
      setTimeout(w, 30);
    })();
  })`);
  return { win, errs, js: (code) => win.webContents.executeJavaScript(code) };
}

/** 切到某一页并等它渲染完（骨架屏消失 = 数据回来了） */
const GOTO = (id) => `(async () => {
  location.hash = "#/${id}";
  await new Promise((r) => setTimeout(r, 40));
  const t0 = Date.now(), b = document.getElementById("ad-body");
  while (b.querySelector(".ui-skeleton") && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 30));
  await new Promise((r) => setTimeout(r, 60));
  return { title: document.getElementById("ad-title").textContent,
           len: b.textContent.replace(/\\s+/g, "").length,
           gate: !!b.querySelector(".ad-gate"),
           html: b.innerHTML.slice(0, 400) };
})()`;

(async () => {
  await listening;
  await electronApp.whenReady();
  READY = true;

  // ---------- 造一份「有内容」的数据：空数据库那一版全是空状态，测不出 render 里的坑 ----------
  let r = await call("POST", "/api/auth/register", { body: { username: "laoban", password: "pw-laoban-123" } });
  const boss = r.cookie;
  r = await call("POST", "/api/admin/orgs", { cookie: boss, body: { name: "华东分公司", plan: "team", seats: 5 } });
  const org2 = r.json.id;
  await call("POST", "/api/admin/depts", { cookie: boss, body: { name: "市场部" } });
  await call("POST", "/api/admin/members", { cookie: boss, body: { username: "xiaoyuan", role: "member" } });
  await call("POST", "/api/admin/members", { cookie: boss, body: { username: "kuaiji", role: "auditor" } });
  await call("POST", "/api/admin/invites", { cookie: boss, body: { role: "member", max_uses: 5 } });
  await call("POST", "/api/admin/topup", { cookie: boss, body: { username: "xiaoyuan", amount: 500 } });
  // 一条真流水：用量四页全靠它，没有就永远只在测空状态
  account.chargeRun({ username: "xiaoyuan" }, { prompt: 1200, cached: 400, completion: 800, calls: 3, model: "gpt-x", provider: "openai", source: "web", elapsed_ms: 4200 });
  account.chargeRun({ username: "laoban" }, { prompt: 300, cached: 0, completion: 150, calls: 1, model: "claude-x", provider: "anthropic", source: "feishu", elapsed_ms: 900 });
  fs.writeFileSync(path.join(BASE_WS, "总部的活.md"), "hq");
  // 审计员的登录 cookie：他那一版界面得是「能查账改不动」
  r = await call("POST", "/api/admin/members/kuaiji/reset-password", { cookie: boss });
  const auditorPw = r.json.password;
  r = await call("POST", "/api/auth/login", { body: { username: "kuaiji", password: auditorPw } });
  const auditor = r.cookie;

  // ================= 1. 管理员：19 个面板一个一个点过去 =================
  console.log("\n【1】平台管理员：每一页都真渲染出东西，且 console 干净");
  const A = await openAdmin(boss, "boss");
  ok("首屏就有内容，不是白屏", (await A.js(`document.getElementById("ad-body").textContent.trim().length > 40`)));
  ok("标题写的是这个组织的名字", /企业管理后台/.test(await A.js(`document.title`)), await A.js(`document.title`));

  const IDS = ["home", "security", "sub", "usage-member", "usage-org", "usage-app", "usage-detail", "relay", "stats",
               "members", "pending", "roles", "basic", "net", "meter", "models", "orgs", "audit", "integration"];
  const seen = [];
  for (const id of IDS) {
    const res = await A.js(GOTO(id));
    if (res.gate) throw new Error(`【${id}】渲染成了错误挡板：` + res.html);
    if (res.len < 30) throw new Error(`【${id}】几乎是空的（${res.len} 字）：` + res.html);
    seen.push(`${id}=${res.len}`);
  }
  ok("19 个面板全部渲染出正文（没有一页白屏 / 没有一页掉进错误挡板）", seen.length === 19, seen.join(" "));
  ok("点完 19 页，console 一条 error 都没有", A.errs.length === 0, A.errs);

  // 侧边导航：平台管理员看得到「组织管理」（这是 platform: true 的那一项）
  ok("侧栏分组齐了（订阅与用量 / 数据统计 / 成员授权 / 企业设置 / 开放与集成）",
     (await A.js(`[...document.querySelectorAll(".ad-grp")].map(x=>x.textContent).join("|")`)) === "订阅与用量|数据统计|成员授权|企业设置|开放与集成");
  ok("平台管理员的侧栏里有「组织管理」", await A.js(`!!document.querySelector('.ad-nav-i[href="#/orgs"]')`));
  ok("平台管理员的侧栏里有「模型与 Key」（用户要的「后台能设置 apikey」就在这儿）",
     await A.js(`!!document.querySelector('.ad-nav-i[href="#/models"]')`));

  // 数字得是真从后端来的，不是写死的占位
  await A.js(GOTO("usage-org"));
  ok("组织用量页把真流水算出来了（2450 tokens）", await A.js(`/2,450|2450/.test(document.getElementById("ad-body").textContent)`),
     (await A.js(`document.getElementById("ad-body").textContent.replace(/\\s+/g," ").slice(0,200)`)));
  await A.js(GOTO("usage-member"));
  ok("成员用量页列出了真人（小圆 / 会计 / 老板都在）",
     await A.js(`["xiaoyuan","kuaiji","laoban"].every(n => document.getElementById("ad-body").textContent.includes(n))`));
  await A.js(GOTO("usage-app"));
  const appTxt = await A.js(`document.getElementById("ad-body").textContent`);
  ok("应用用量按模型和入口拆开了（gpt-x / claude-x / 飞书）", /gpt-x/.test(appTxt) && /claude-x/.test(appTxt) && /飞书/.test(appTxt));
  ok("全量聚合的表标的是「累计」不是「本月」（数字不许无声撒谎）", /累计/.test(appTxt) && !/本月消耗排行/.test(appTxt), appTxt.replace(/\s+/g, " ").slice(0, 160));

  // ================= 1.5 账本：时间范围 / 搜索 / 翻页 =================
  // 这三样以前一样都没有，界面上写的是「最近 25 条，再往前的看不了」。
  // 它们是「这个后台能不能当账本用」的分界线，所以要真点一遍，不能只测接口。
  console.log("\n【1.5】用量明细 + 操作审计：查得到、搜得着、翻得动");
  const wait = (ms) => `new Promise(r=>setTimeout(r,${ms}))`;
  const kpi0 = `[...document.querySelectorAll(".ui-stat")].map(e=>e.textContent.replace(/\\s+/g,""))[0]`;
  const rowN = `document.querySelectorAll("#ad-body tbody tr").length`;

  await A.js(GOTO("usage-detail"));
  ok("用量明细有筛选条（六个快捷区间 + 两个日期框 + 搜索框）",
     await A.js(`document.querySelectorAll("[data-preset]").length === 6 && !!document.querySelector("[data-from]") && !!document.querySelector("[data-q]")`));
  ok("默认停在「全部」上（不是默默只给你看今天，那种默认最坑人）",
     (await A.js(`document.querySelector(".ad-chip.is-on").textContent.trim()`)) === "全部");
  const allN = await A.js(rowN);
  ok("「全部」下看得到流水", allN > 0, allN);

  await A.js(`document.querySelector('[data-preset="last-month"]').click(); ` + wait(500));
  ok("切到「上月」一条都不剩（这批流水都是今天造的，剩下才说明筛选没生效）",
     (await A.js(rowN)) === 0 && /命中条数0/.test(await A.js(kpi0)), await A.js(kpi0));

  await A.js(`document.querySelector('[data-preset="today"]').click(); ` + wait(500));
  ok("切回「今天」又回来了（反向对照：上一条不是因为整页都空了）", (await A.js(rowN)) === allN);

  // 每条 executeJavaScript 都在**同一个**页面全局作用域里跑：`const q` 声明第二次直接抛
  // 「Identifier 'q' has already been declared」。所以这里一律不留声明。
  const typeQ = (v) => A.js(`(()=>{const e=document.querySelector("[data-q]"); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event("input"));})(); ` + wait(700));
  await typeQ("claude");
  const claudeAll = await A.js(`[...document.querySelectorAll("#ad-body tbody tr")].every(t=>/claude/.test(t.textContent))`);
  ok("搜「claude」之后每一行都真的含 claude，且比全量少", claudeAll && (await A.js(rowN)) < allN, await A.js(rowN));

  await typeQ("");
  await A.js(`(()=>{const e=document.querySelector("[data-user]"); e.value="xiaoyuan"; e.dispatchEvent(new Event("change"));})(); ` + wait(700));
  ok("按成员筛之后只剩这个人的账", await A.js(`[...document.querySelectorAll("#ad-body tbody tr")].every(t=>/xiaoyuan/.test(t.textContent))`));
  ok("翻页条报的是条数不是页码（对账的人记的是条数）", /共 \d+ 条|第 \d+-\d+ 条/.test(await A.js(`(document.querySelector(".ad-pager-n")||{}).textContent||""`)),
     await A.js(`(document.querySelector(".ad-pager-n")||{}).textContent||""`));

  await A.js(GOTO("audit"));
  ok("审计页也有同一套筛选条 + 操作人/动作两个下拉",
     await A.js(`document.querySelectorAll("[data-preset]").length === 6 && !!document.querySelector("[data-actor]") && !!document.querySelector("[data-action]")`));
  ok("审计页能导出（合规的人第一件事就是要一份带走）", await A.js(`!!document.querySelector("[data-csv]")`));
  const auditAll = await A.js(rowN);
  await A.js(`(()=>{const e=document.querySelector("[data-action]"); e.value="添加成员"; e.dispatchEvent(new Event("change"));})(); ` + wait(600));
  ok("按动作筛「添加成员」，剩下的行全是这个动作", auditAll > 0
     && (await A.js(rowN)) > 0 && (await A.js(rowN)) < auditAll
     && (await A.js(`[...document.querySelectorAll("#ad-body tbody tr")].every(t=>/添加成员/.test(t.textContent))`)),
     `全部 ${auditAll} 条 → 筛后 ${await A.js(rowN)} 条`);
  await A.js(`document.querySelector('[data-preset="last-month"]').click(); ` + wait(600));
  ok("审计按「上月」筛也是空的（动作下拉的选项没被筛没：还列得出全部动作）",
     (await A.js(rowN)) === 0 && (await A.js(`document.querySelector("[data-action]").options.length > 1`)));

  // 总览页：它是落地页，坏了等于整个后台打不开
  // 先跑去别的页再把 hash 清空，才测得到「没有 hash 时落在哪」——
  // 本来就停在 #/home 的话，清 hash 不触发 hashchange，这条会假绿
  await A.js(GOTO("basic"));
  ok("总览是落地页（不带 hash 打开后台，落在总览而不是订阅管理）",
     (await A.js(`(async()=>{location.hash="#/"; await ${wait(500)}; return document.getElementById("ad-title").textContent})()`)) === "总览");
  await A.js(GOTO("home"));
  const homeTxt = await A.js(`document.getElementById("ad-body").textContent`);
  ok("总览把今天和本月的数都摆出来了", /今日运行/.test(homeTxt) && /本月 tokens/.test(homeTxt));
  ok("总览有「要你处理的」，且席位满了这条真的报出来（席位 3/3）",
     /要你处理的/.test(homeTxt) && /席位满了/.test(homeTxt), homeTxt.replace(/\s+/g, " ").slice(0, 240));

  // ================= 1.7 部门权限模板：后端早就有了，界面上得够得着 =================
  // lifecycle.js 的部门模板是「同一个部门进来的第三个人和第一个人权限一模一样」的全部指望。
  // 但它当初只接到了接口上，成员页那个「添加成员」还在打 /api/admin/members——那条路
  // 一个字都不看模板。于是模板存了等于没存，谁也不会发现。这一节就守这条线。
  console.log("\n【1.7】部门权限模板：存得下、看得见、加人时真按它开号");
  // 上一节刚验过「席位 3/3 满了」，这一节要真加两个人——先把席位放开，
  // 不然下面每一条都会红在「席位已用满」上，而那跟模板一点关系都没有
  await call("POST", "/api/admin/org", { cookie: boss, body: { seats: 8 } });
  await call("POST", "/api/admin/dept-templates", {
    cookie: boss, body: { dept: "市场部", template: { role: "auditor", monthly_quota: 3000 } },
  });
  await A.js(GOTO("members"));
  const deptTxt = await A.js(`document.getElementById("ad-body").textContent`);
  ok("部门那块把模板摆在明处（市场部 · 审计员 · 3,000），不是藏在接口里",
     /市场部/.test(deptTxt) && /新人默认角色/.test(deptTxt) && /审计员/.test(deptTxt) && /3,000|3000/.test(deptTxt),
     deptTxt.replace(/\s+/g, " ").slice(0, 240));
  ok("每个部门都有「权限模板」按钮；存了模板的那个还多一颗「清空模板」",
     (await A.js(`document.querySelectorAll("[data-tpl]").length >= 1 && document.querySelectorAll("[data-tplx]").length === 1`)));

  // 真走一遍「添加成员」：部门选市场部、角色留空 = 跟模板走
  await A.js(`document.querySelector("[data-add]").click(); ` + wait(300));
  await A.js(`(()=>{document.getElementById("mf-username").value="xiaohong";
                    document.getElementById("mf-dept").value="市场部";
                    document.getElementById("mf-role").value="";})()`);
  await A.js(`document.querySelector(".ui-dialog [data-ok]").click(); ` + wait(900));
  const made = (await call("GET", "/api/admin/members", { cookie: boss })).json.members.find((u) => u.username === "xiaohong");
  ok("界面上加的人真按市场部的模板开了号（审计员 · 月额度 3000），说明这颗按钮接的是 onboard 不是裸建号",
     !!made && made.role === "auditor" && made.monthly_quota === 3000, made);
  ok("密码框顺带说清了套的是哪个部门的模板（不说的话，管理员根本不知道角色是从哪来的）",
     /市场部/.test(await A.js(`(document.querySelector(".ui-dialog")||{}).textContent||""`)),
     await A.js(`(document.querySelector(".ui-dialog")||{}).textContent||""`));
  await A.js(`[...document.querySelectorAll(".ui-overlay")].forEach(x=>x.remove()); ` + wait(200));

  // 反向对照：显式填了角色就以填的为准，模板是默认值不是强制
  await call("POST", "/api/admin/onboard", { cookie: boss, body: { username: "xiaolan", dept: "市场部", role: "member" } });
  const forced = (await call("GET", "/api/admin/members", { cookie: boss })).json.members.find((u) => u.username === "xiaolan");
  ok("反向对照：明写了角色就听明写的（模板是默认值，不是强制）", forced && forced.role === "member", forced);

  // ================= 2. 审计员：能查账，改不动 =================
  console.log("\n【2】审计员：进得来、看得见，但写操作的控件全禁掉");
  const B = await openAdmin(auditor, "auditor");
  ok("审计员进得来（不是 403 挡板）", !(await B.js(`!!document.querySelector(".ad-gate")`)));
  ok("右上角挂着「只读（审计员）」的牌子", /只读/.test(await B.js(`document.getElementById("ad-top-r").textContent`)));
  ok("审计员的侧栏里没有「组织管理」（那是平台管理员的）", !(await B.js(`!!document.querySelector('.ad-nav-i[href="#/orgs"]')`)));
  ok("审计员的侧栏里也没有「模型与 Key」（Key 是整台服务器的账单凭证）",
     !(await B.js(`!!document.querySelector('.ad-nav-i[href="#/models"]')`)));
  for (const id of ["security", "basic", "net", "meter", "members"]) {
    const res = await B.js(GOTO(id));
    if (res.gate) throw new Error(`审计员打开【${id}】被挡了：` + res.html);
  }
  ok("审计员该看得见的页一样看得见", true);
  const rw = await B.js(`(async () => {
    location.hash = "#/net"; await new Promise(r=>setTimeout(r,300));
    const b = document.getElementById("ad-body");
    const inputs = [...b.querySelectorAll("input,textarea,select")];
    const btns = [...b.querySelectorAll("button")].filter(x => !x.disabled);
    return { total: inputs.length, off: inputs.filter(x => x.disabled).length, liveBtns: btns.map(x=>x.textContent.trim()) };
  })()`);
  ok("网络设置页上的输入框对审计员全是禁用的（" + rw.off + "/" + rw.total + "）", rw.total > 0 && rw.off === rw.total, rw);
  ok("也没留下能点的写按钮", rw.liveBtns.length === 0, rw.liveBtns);
  // 反向对照：同一页给管理员看，控件必须是能改的——不然上面那条只是「这页压根没控件」
  const rwA = await A.js(`(async () => {
    location.hash = "#/net"; await new Promise(r=>setTimeout(r,300));
    const b = document.getElementById("ad-body");
    const inputs = [...b.querySelectorAll("input,textarea,select")];
    return { total: inputs.length, off: inputs.filter(x => x.disabled).length };
  })()`);
  ok("反向对照：管理员在同一页上控件是能改的（" + (rwA.total - rwA.off) + "/" + rwA.total + " 可用）", rwA.total > 0 && rwA.off === 0, rwA);
  ok("审计员这一路 console 也是干净的", B.errs.length === 0, B.errs);

  // ================= 3. 改一个设置：真存进去了 =================
  console.log("\n【3】改设置：保存条亮起 → 存盘 → 后端真收到");
  const saved = await A.js(`(async () => {
    location.hash = "#/security"; await new Promise(r=>setTimeout(r,400));
    const b = document.getElementById("ad-body");
    const sw = b.querySelector('input[data-k="allow_shell"]');
    const btn = b.querySelector("[data-save]");
    const tip = b.querySelector("[data-dirty]");
    if (!sw || !btn || !tip) return { err: "开关或保存按钮不在：" + [!!sw, !!btn, !!tip].join(",") };
    const before = { off: btn.disabled, tip: getComputedStyle(tip).display };
    sw.checked = false; sw.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise(r=>setTimeout(r,80));
    const after = { off: btn.disabled, tip: getComputedStyle(tip).display };
    btn.click();
    await new Promise(r=>setTimeout(r,600));
    return { before, after };
  })()`);
  ok("没改的时候「保存」是灰的、也不提示（省得每次都要猜自己改没改）",
     saved.err === undefined && saved.before.off === true && saved.before.tip === "none", saved);
  ok("动了开关，「保存」才亮 + 冒出「有改动还没保存」", saved.after.off === false && saved.after.tip !== "none", saved);
  r = await call("GET", "/api/admin/org", { cookie: boss });
  ok("后端真的存下了 allow_shell=false（不是只在前端亮了一下）", r.json.org.settings.allow_shell === false, r.json.org.settings.allow_shell);

  // ================= 4. 「模型与 Key」：填一把 Key，整张渠道表原样送回去 =================
  console.log("\n【4】模型与 Key：Key 填得进去，而且没把别的渠道顺手抹掉");
  const mk = await A.js(`(async () => {
    location.hash = "#/models"; await new Promise(r=>setTimeout(r,500));
    const b = document.getElementById("ad-body");
    const keys = [...b.querySelectorAll("input.ad-key")].map(x => x.dataset.pk);
    const or = b.querySelector('input.ad-key[data-pk="openrouter"]');
    const btn = b.querySelector("[data-save]");
    if (!or || !btn) return { err: "Key 输入框或保存按钮不在：" + [!!or, !!btn].join(",") };
    const peekBefore = or.type;
    const peek = b.querySelector('[data-peek="openrouter"]');
    peek.click();
    const peekAfter = or.type;
    peek.click();
    const before = btn.disabled;
    or.value = "sk-or-\u65b0\u586b\u7684";
    or.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r=>setTimeout(r,80));
    const after = btn.disabled;
    const sels = [...b.querySelectorAll("[data-sel]")].map(x => x.dataset.sel);
    btn.click();
    await new Promise(r=>setTimeout(r,600));
    return { keys, peekBefore, peekAfter, before, after, sels,
             txt: b.textContent.replace(/\\s+/g, " ").slice(0, 300) };
  })()`);
  ok("每个渠道都给了能填 Key 的输入框（没填的那两个也在——不然又变成「没地方填」）",
     mk.err === undefined && mk.keys.length === FAKE.providers.length && mk.keys.includes("openrouter") && mk.keys.includes("local"), mk);
  ok("Key 默认是密文，点「显示」才看得见（后台常开着投屏讲）", mk.peekBefore === "password" && mk.peekAfter === "text", mk);
  ok("没动的时候「保存」是灰的，填了才亮", mk.before === true && mk.after === false, mk);
  ok("「默认走哪条」和「主渠道挂了换谁」两个下拉都在", (mk.sels || []).join() === "active_model,failover_model", mk.sels);
  const body = savedSettings[savedSettings.length - 1] || {};
  ok("保存真发到了 /api/settings", savedSettings.length === 1, savedSettings.length);
  ok("刚填的那把 Key 送过去了", (body.providers || []).find((p) => p.id === "openrouter")?.api_key === "sk-or-新填的",
     (body.providers || []).map((p) => p.id + "=" + (p.api_key ? "有" : "空")).join(" "));
  // 这条是这页最容易写错的地方：POST /api/settings 对 providers 是**整表覆盖**。
  // 只送改动的那一条，另外两个渠道当场消失，挂在它们底下的模型全断线。
  ok("没动过的渠道原样送回去了（整表覆盖，漏一个就等于删一个）",
     (body.providers || []).length === FAKE.providers.length && body.providers.find((p) => p.id === "ark")?.api_key === "sk-ark-demo",
     (body.providers || []).map((p) => p.id).join(","));
  ok("默认模型和备用模型也一起送了", body.active_model === "方舟-主力" && body.agent && body.agent.failover_model === "",
     JSON.stringify({ a: body.active_model, f: body.agent }));
  ok("这一页 console 也是干净的", A.errs.length === 0, A.errs);

  // ================= 5. 「模型与 Key」：渠道能自己加、能改地址、能删 =================
  // 预置目录只有十来家，
  // 自建网关 / 内网代理 / 换了域名的私有部署都不在里面，这页不给加就等于只做了一半。
  console.log("\n【5】渠道自定义：加一条、改地址、删一条（删是连坐的）");
  const n0 = savedSettings.length;
  const bad = await A.js(`(async () => {
    const wait = (ms) => new Promise(r=>setTimeout(r,ms));
    const $ = (id) => document.querySelector("#mf-" + id);
    const ok = () => document.querySelector(".ui-overlay [data-ok]");
    location.hash = "#/models"; await wait(500);
    const b = document.getElementById("ad-body");
    const R = {};
    // 同地址的两条渠道要标出来（各自一把 Key，合并了等于花别人的钱），别的行不许标
    R.dupCells = [...b.querySelectorAll("td")].filter((td) => /同地址还有/.test(td.textContent)).length;
    const rowOf = (pk) => { const i = b.querySelector('input.ad-key[data-pk="' + pk + '"]'); return i ? i.closest("tr").textContent : ""; };
    R.arkDup = /同地址还有/.test(rowOf("ark"));
    const pnew = b.querySelector("[data-pnew]");
    if (!pnew) return { err: "「新渠道」按钮不在" };
    pnew.click(); await wait(80);
    R.fields = ["kind", "name", "base_url", "api_key"].map((k) => !!$(k));
    // 选了类型就把官方地址填上；再切到「自定义」不该把已经填好的地址清掉
    $("kind").value = "zhipu"; $("kind").dispatchEvent(new Event("change", { bubbles: true })); await wait(40);
    R.autoBase = $("base_url").value; R.autoName = $("name").value;
    $("kind").value = "custom"; $("kind").dispatchEvent(new Event("change", { bubbles: true })); await wait(40);
    R.keepBase = $("base_url").value;
    // 反向对照：名字留空、地址不是 http，都必须当场拦下，一个字节都不许往服务端发
    $("name").value = ""; ok().click(); await wait(150);
    R.emptyNameErr = (document.querySelector("#mf-err") || {}).textContent || "";
    // 拦不住的话弹窗当场就关了，下面每一行都会在 null 上炸——炸出来的是
    // 「Cannot set properties of null」，看的人根本不知道是校验没了。所以先自己说清楚。
    if (!document.querySelector(".ui-overlay")) return { err: "名字留空居然存进去了：弹窗关了，校验没拦住" };
    $("name").value = "公司内网网关"; $("base_url").value = "gw.example";
    ok().click(); await wait(150);
    R.badUrlErr = (document.querySelector("#mf-err") || {}).textContent || "";
    R.stillOpen = !!document.querySelector(".ui-overlay");
    return R;
  })()`);
  ok("表单这一趟没走岔（走岔了下面每条都在 null 上炸，看不出真因）", bad.err === undefined, bad.err);
  ok("渠道表单四样都在：类型 / 名字 / 接口地址 / Key",
     (bad.fields || []).join() === "true,true,true,true", bad);
  ok("同地址的两条渠道标了出来，其余的行不标（反向对照）", bad.dupCells === 2 && bad.arkDup === false, bad);
  ok("选了类型自动把官方地址填上（十来家地址没人背得下来）", bad.autoBase === "https://open.bigmodel.cn/api/paas/v4" && !!bad.autoName, bad);
  ok("切到「自定义」不清掉已经填好的地址（那一栏本来就得用户自己填）", bad.keepBase === "https://open.bigmodel.cn/api/paas/v4", bad);
  ok("名字留空当场拦下", /名字/.test(bad.emptyNameErr), bad.emptyNameErr);
  ok("地址不是 http(s) 当场拦下", /http/.test(bad.badUrlErr), bad.badUrlErr);
  ok("拦下的这两次一个字节都没发出去（反向对照：拦了却照发，等于白拦）",
     savedSettings.length === n0 && bad.stillOpen === true, { n0, now: savedSettings.length, open: bad.stillOpen });

  const add = await A.js(`(async () => {
    const wait = (ms) => new Promise(r=>setTimeout(r,ms));
    const $ = (id) => document.querySelector("#mf-" + id);
    $("base_url").value = "https://gw3.example/v1"; $("api_key").value = "sk-inner";
    document.querySelector(".ui-overlay [data-ok]").click(); await wait(800);
    return { closed: !document.querySelector(".ui-overlay") };
  })()`);
  ok("填对了弹窗才关", add.closed === true, add);
  let sent = savedSettings[savedSettings.length - 1] || {};
  const fresh = (sent.providers || []).find((p) => p.base_url === "https://gw3.example/v1");
  ok("新渠道发到了服务端，id 留空交给服务端生成（前端自己编会跟别人撞）",
     !!fresh && fresh.id === "" && fresh.name === "公司内网网关" && fresh.api_key === "sk-inner" && fresh.kind === "custom", fresh);
  ok("原来那几条渠道一条没少、Key 也没被抹（整表覆盖，漏一个就等于删一个）",
     (sent.providers || []).length === FAKE.providers.length + 1 &&
     (sent.providers || []).find((p) => p.id === "ark")?.api_key === "sk-ark-demo",
     (sent.providers || []).map((p) => (p.id || "新") + "=" + (p.api_key ? "有" : "空")).join(" "));

  const edit = await A.js(`(async () => {
    const wait = (ms) => new Promise(r=>setTimeout(r,ms));
    const $ = (id) => document.querySelector("#mf-" + id);
    const b = document.getElementById("ad-body");
    const e = b.querySelector('[data-pedit="local"]');
    if (!e) return { err: "「改」按钮不在" };
    e.click(); await wait(80);
    const was = { name: $("name").value, base: $("base_url").value };
    $("base_url").value = "http://127.0.0.1:11500/v1";
    document.querySelector(".ui-overlay [data-ok]").click(); await wait(800);
    return { was };
  })()`);
  ok("「改」带着这条渠道现有的名字和地址开表单", edit.err === undefined && edit.was.name === "本机 Ollama", edit);
  sent = savedSettings[savedSettings.length - 1] || {};
  ok("改地址是就地改，不是新建一条（id 保住了，挂在它底下的模型才不会断线）",
     (sent.providers || []).find((p) => p.id === "local")?.base_url === "http://127.0.0.1:11500/v1" &&
     (sent.providers || []).length === FAKE.providers.length,
     (sent.providers || []).map((p) => p.id + "→" + p.base_url).join(" "));

  const del = await A.js(`(async () => {
    const wait = (ms) => new Promise(r=>setTimeout(r,ms));
    const b = document.getElementById("ad-body");
    const x = b.querySelector('[data-pdel="ark"]');
    if (!x) return { err: "「删」按钮不在" };
    x.click(); await wait(80);
    const txt = (document.querySelector(".ui-overlay .bd") || {}).textContent || "";
    document.querySelector(".ui-overlay [data-ok]").click(); await wait(800);
    return { txt };
  })()`);
  ok("删之前把连坐的数报清楚：底下挂了几个对话模型、几个媒体模型",
     del.err === undefined && /1 个对话模型/.test(del.txt) && /1 个媒体模型/.test(del.txt), del.txt);
  ok("默认模型正好在里面时，也说清楚删完会换", /默认模型就在里面/.test(del.txt || ""), del.txt);
  sent = savedSettings[savedSettings.length - 1] || {};
  ok("删渠道是连坐的：挂在它底下的对话模型和媒体模型一起删掉",
     !(sent.providers || []).some((p) => p.id === "ark") &&
     !(sent.models || []).some((m) => m.channel === "ark") &&
     !(sent.media_models || []).some((m) => m.provider === "ark"),
     JSON.stringify({ p: (sent.providers || []).map((p) => p.id), m: (sent.models || []).map((m) => m.channel) }));
  ok("默认模型被删掉时自动换成还活着的那条（不换的话服务端会整次拒收，一条都删不掉）",
     sent.active_model === "OR-备用", sent.active_model);
  ok("这一页 console 还是干净的", A.errs.length === 0, A.errs);

  // ================= 6. 审计的保留上限：到顶了要说出来，导出要能带走全部 =================
  // 这一页以前有两句假话：副标题写「这个组织建起来到现在的全部管理动作」，
  // 而审计是有保留上限的，存满之后最老的会被挤掉；导出按钮写「导出本页」，
  // 合规的人筛完一个月、页脚写着 3000 条，只能一页一页导 60 次。
  // 假话出现在审计页尤其贵：看这张表的人正是拿它当证据的人。
  console.log("\n【6】审计保留上限：存满了说出来，导出带得走全部");
  const auditOrg = require("../org");
  // 前面的用例把筛选停在「上月 + 添加成员」上（面板状态是留着的），先清回全部
  const RESET_AUDIT = `(async () => {
    const nap = (ms) => new Promise(r=>setTimeout(r,ms));
    location.hash = "#/audit"; await nap(80);
    document.querySelector('[data-preset="all"]').click(); await nap(600);
    const k = document.querySelector("[data-action]");
    if (k && k.value) { k.value = ""; k.dispatchEvent(new Event("change")); await nap(600); }
    const b = document.getElementById("ad-body");
    return {
      sub: (b.querySelector(".ad-sec-d") || {}).textContent || "",
      btn: (b.querySelector("[data-csv]") || {}).textContent || "",
      warn: (b.querySelector(".ui-alert--warn") || {}).textContent || "",
      rows: b.querySelectorAll("tbody tr").length,
    };
  })()`;

  // 反向对照先跑：没存满的时候不许摆「已被挤掉」那条提醒，副标题也该说「全部」
  const before = await A.js(RESET_AUDIT);
  ok("没存满时副标题说的是「全部 N 条」，不含「上限」二字",
     /全部 \d+ 条/.test(before.sub) && !/上限/.test(before.sub), before.sub);
  ok("反向对照：没存满就不摆「更早的已被挤掉」那条警告", before.warn === "", before.warn);
  ok("反向对照：没存满时导出按钮说的是「本页」", /导出本页/.test(before.btn), before.btn);

  // 造一本存满的。直接往 jsonl 里写，不走 org.audit()——那是 5000 次 appendFileSync，
  // 为了一条界面断言让整个套件多跑十几秒不值得；这里要验的是「后端说满了，界面认不认」
  // 本子要挑对：这台测试机上不止一个组织在动，往别人那本里写，这一页一个字都不会变。
  // 组织 id 从接口自己说的那条里取——顺手也验了每条流水身上带着 org
  const myOrg = await A.js(`(async () => {
    const j = await (await fetch("/api/admin/audit?limit=1")).json();
    return (j.audit && j.audit[0] && j.audit[0].org) || "";
  })()`);
  ok("流水身上带着组织 id（多租户下这是分本的依据）", !!myOrg, myOrg);
  const audFile = auditOrg._internals.auditFile(myOrg);
  ok("这本审计文件真的在（写错本子的话下面全是假绿）", fs.existsSync(audFile), audFile);
  const CAP = auditOrg._internals.AUDIT_CAP;
  const today = new Date().toISOString();
  fs.appendFileSync(audFile, Array.from({ length: CAP }, (_, i) =>
    JSON.stringify({ ts: today, org: myOrg, actor: "压测管理员", action: "放行命令", target: "任务" + i, detail: "" })
  ).join("\n") + "\n");

  const after = await A.js(RESET_AUDIT);
  ok("★存满了，副标题改口说「最近 N 条（已到保留上限，更早的已被挤掉）」★ 不再谎称「全部」",
     /已到保留上限/.test(after.sub) && !/全部 \d+ 条/.test(after.sub), after.sub);
  ok("★到顶了摆一条明确的警告，写清楚上限是多少、现存最早一条是哪天★",
     new RegExp(String(CAP)).test(after.warn) && /现存最早/.test(after.warn) && /\d{4}/.test(after.warn),
     after.warn.replace(/\s+/g, " ").slice(0, 160));
  ok("警告里得告诉人下一步干什么（导出存档），不是光说一句「满了」", /导出存档/.test(after.warn), after.warn.slice(0, 80));
  ok("★导出按钮改口说「导出全部 N 条」，N 是筛选命中的总数不是屏幕上这 50 条★",
     /导出全部 \d+ 条/.test(after.btn) && Number((after.btn.match(/(\d+)/) || [])[1]) > after.rows,
     { btn: after.btn, 屏幕上: after.rows });

  // 真点一次导出。以前这颗按钮只把屏幕上这 50 条写进 CSV——
  // 页脚写着 5000 条、导出来 50 条，而且不吭声，对账的人是照着这份文件下结论的
  const csv = await A.js(`(async () => {
    const nap = (ms) => new Promise(r=>setTimeout(r,ms));
    // a.click() 在 Electron 里会真的触发下载（还可能弹保存框），所以这两样都换掉，
    // 顺手把 Blob 截下来——要验的是「导出了多少条」，不是浏览器怎么存文件
    const origClick = HTMLAnchorElement.prototype.click;
    const origCreate = URL.createObjectURL, origRevoke = URL.revokeObjectURL;
    let blob = null;
    HTMLAnchorElement.prototype.click = function () {};
    URL.createObjectURL = (b) => { blob = b; return "blob:stub"; };
    URL.revokeObjectURL = () => {};
    try {
      const btn = document.querySelector("[data-csv]");
      btn.click();
      // 同步读，不能 await 一下再读：本机服务端几十毫秒就导完了，那时按钮已经恢复，
      // 读到 false 会被当成「没禁用」——这条断言就成了看机器快慢的掷骰子。
      // 点击是同步派发的，处理器里 btn.disabled = true 在第一个 await 之前，所以这里读得到
      const busy = btn.disabled; // 导出中按钮该是禁用的，不然连点几下就是几十个并发请求
      const t0 = Date.now();
      while (!blob && Date.now() - t0 < 30000) await nap(100);
      const text = blob ? await blob.text() : "";
      return { busy, restored: !btn.disabled, lines: text.split("\\n").filter((x) => x.trim()).length,
               head: text.split("\\n")[0] || "", label: btn.textContent };
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
      URL.createObjectURL = origCreate; URL.revokeObjectURL = origRevoke;
    }
  })()`);
  ok("★导出拿到的是全部命中，不是屏幕上这一页★ 每页 50 条，这里得有几千行",
     csv.lines > CAP, { CSV行数: csv.lines, 上限: CAP });
  ok("CSV 第一行是表头（时间/操作人/动作/对象/详情）",
     /时间/.test(csv.head) && /操作人/.test(csv.head) && /详情/.test(csv.head), csv.head);
  ok("导出中按钮是禁用的（分几趟拉，连点几下就是几十个并发请求）", csv.busy === true, csv);
  ok("导完按钮自己恢复，不是卡在「导出中」上", csv.restored === true && !/导出中/.test(csv.label), csv.label);
  ok("这一页 console 还是干净的", A.errs.length === 0, A.errs);
  server.close();
  console.log(`\n✅ 企业管理后台：18 面板真渲染 · 审计员只读 · 设置改了真落库 · 后台能填 Key 能自己加改删渠道且不误删别的 · 审计到顶说得出口、导得全 ${pass} 项通过`);
  fs.rmSync(TMP, { recursive: true, force: true });
  clearTimeout(WATCHDOG);
  electronApp.exit(0);
})().catch((e) => {
  console.error("❌ 企业后台测试失败: " + ((e && (e.stack || e.message)) || String(e)) + "\n   已过 " + pass + " 项");
  try { server.close(); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
  clearTimeout(WATCHDOG);
  electronApp.exit(1);
});
