"use strict";
/**
 * 企业管理后台（/admin.html + public/js/admin.js）的真浏览器测试。
 *
 * 跑法：npx electron test/admin-ui.js（由 test/e2e.js 拉起；没装 electron 就整体跳过）
 *
 * 为什么非得开真 Chromium：这一页是 16 个面板 + 哈希路由 + 弹窗表单，六成的坏法是
 * 「某一页 render 里读了个 undefined，整块白屏」——这种错在 node 里一个字节都测不出来，
 * 只有真的把每一页点一遍、盯着 console 有没有报错才看得见。
 *
 * 后端不是打桩的：这里起的是 account.createRouter + admin.createAdminRouter 的真路由，
 * 中间件顺序照抄 server.js。所以「前端以为后端返回 X、后端其实返回 Y」这类错也跑得出来。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wb-adminui-"));
process.env.WB_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.WB_DATA_DIR, { recursive: true });

// 这个文件得用 electron 跑，不是 node：`npx electron test/admin-ui.js`。
// 用 node 跑的话下面 require("electron") 拿到的是个字符串（electron 包的 npm 入口导出的是
// 二进制路径），一路往下走到最后才炸一个 "Cannot read properties of undefined"，
// 看到的人根本猜不到是跑法不对。在这儿就说清楚。
if (typeof require("electron") === "string") {
  console.error("❌ 这个测试要用 electron 跑：npx electron test/admin-ui.js");
  process.exit(1);
}
const { app: electronApp, BrowserWindow } = require("electron");
const express = require("express");
const ROOT = path.join(__dirname, "..");
const account = require(path.join(ROOT, "account"));
const org = require(path.join(ROOT, "org"));
const admin = require(path.join(ROOT, "admin"));
const tools = require(path.join(ROOT, "tools"));

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

  // ================= 1. 管理员：16 个面板一个一个点过去 =================
  console.log("\n【1】平台管理员：每一页都真渲染出东西，且 console 干净");
  const A = await openAdmin(boss, "boss");
  ok("首屏就有内容，不是白屏", (await A.js(`document.getElementById("ad-body").textContent.trim().length > 40`)));
  ok("标题写的是这个组织的名字", /企业管理后台/.test(await A.js(`document.title`)), await A.js(`document.title`));

  const IDS = ["security", "sub", "usage-member", "usage-org", "usage-app", "usage-detail", "stats",
               "members", "pending", "roles", "basic", "net", "meter", "orgs", "audit", "integration"];
  const seen = [];
  for (const id of IDS) {
    const res = await A.js(GOTO(id));
    if (res.gate) throw new Error(`【${id}】渲染成了错误挡板：` + res.html);
    if (res.len < 30) throw new Error(`【${id}】几乎是空的（${res.len} 字）：` + res.html);
    seen.push(`${id}=${res.len}`);
  }
  ok("16 个面板全部渲染出正文（没有一页白屏 / 没有一页掉进错误挡板）", seen.length === 16, seen.join(" "));
  ok("点完 16 页，console 一条 error 都没有", A.errs.length === 0, A.errs);

  // 侧边导航：平台管理员看得到「组织管理」（这是 platform: true 的那一项）
  ok("侧栏分组齐了（订阅与用量 / 数据统计 / 成员授权 / 企业设置 / 开放与集成）",
     (await A.js(`[...document.querySelectorAll(".ad-grp")].map(x=>x.textContent).join("|")`)) === "订阅与用量|数据统计|成员授权|企业设置|开放与集成");
  ok("平台管理员的侧栏里有「组织管理」", await A.js(`!!document.querySelector('.ad-nav-i[href="#/orgs"]')`));

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

  // ================= 2. 审计员：能查账，改不动 =================
  console.log("\n【2】审计员：进得来、看得见，但写操作的控件全禁掉");
  const B = await openAdmin(auditor, "auditor");
  ok("审计员进得来（不是 403 挡板）", !(await B.js(`!!document.querySelector(".ad-gate")`)));
  ok("右上角挂着「只读（审计员）」的牌子", /只读/.test(await B.js(`document.getElementById("ad-top-r").textContent`)));
  ok("审计员的侧栏里没有「组织管理」（那是平台管理员的）", !(await B.js(`!!document.querySelector('.ad-nav-i[href="#/orgs"]')`)));
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

  server.close();
  console.log(`\n✅ 企业管理后台：16 面板真渲染 · 审计员只读 · 设置改了真落库 ${pass} 项通过`);
  fs.rmSync(TMP, { recursive: true, force: true });
  electronApp.exit(0);
})().catch((e) => {
  console.error("❌ 企业后台测试失败: " + ((e && (e.stack || e.message)) || String(e)) + "\n   已过 " + pass + " 项");
  try { server.close(); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
  electronApp.exit(1);
});
