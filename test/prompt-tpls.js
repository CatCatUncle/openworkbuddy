// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 参考模板库自己加的那几层（src/server/routes/prompt-tpls.js）：谁看得见、谁改得了。
 *
 *   ① 我的：只有本人看得见；同组织的人看不见、删不着
 *   ② 字段校验：标题、提示词不能空，超长拒，图标名不合规退回默认，分类空了记「其他」
 *   ③ 公司：成员写不进（403，盘上不落文件、审计不记）；管理员加 / 改 / 删都进组织审计
 *   ④ 组织之间互相看不见对方的公司模板
 *   ⑤ 藏内置模板：成员藏的只对自己；管理员藏的对全组织；成员放不回管理员藏的；
 *      重复藏不写第二遍审计；只认内置模板的 id
 *   ⑥ 照着内置模板改一份：副本和「藏起原件」是同一次写盘
 *   ⑦ 个人桌面版没有「公司」这一层：GET 给 null，管理员也写不进
 *   ⑧ 一层最多 200 条；盘上文件坏了照样能打开页面；怪用户名拼不出目录外的路径
 *   ⑨ 接线：server.js 挂在 authGuard 后面、公司层按 admin.write 判；前端内置模板的 id 唯一且合规
 *
 * 为什么较这个真：公司模板全组织都看得见，成员要是写得进去，就等于谁都能往同事的输入框里塞话；
 * 而这个接口不在 platformGuard 的写表里，前面没有别的闸替它挡。
 *
 * 不起 server.js：路由单独挂到一个 express 上，登录那层换成请求头里直接给的用户。
 *   node test/prompt-tpls.js
 */
const { mod } = require("./lib/mod");
const { entry } = require("./lib/entry");
const HOME = require("./lib/own-home")("prompt-tpls");

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const ROOT = path.join(__dirname, "..");
const rbac = require(mod("rbac"));
const { dataPath } = require(mod("paths"));
const tpls = require(mod("routes/prompt-tpls"));

let pass = 0, fail = 0, finished = false;
process.on("exit", (code) => {
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`);
  process.exitCode = 1;
});
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra).slice(0, 400) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }
async function section(title, fn) {
  console.log("\n" + title);
  try { await fn(); } catch (e) { fail++; console.log(`  ✗ 这一段直接炸了：${(e && e.stack || e).toString().split("\n").slice(0, 4).join(" | ")}`); }
}

const BASE = path.join(process.env.OPENWORKBUDDY_DATA_DIR || dataPath("data"), "prompt-tpls");
const USERS = {
  alice: { username: "alice", role: "member" },
  bob: { username: "bob", role: "member" },
  carol: { username: "carol", role: "admin" },
  boss: { username: "boss", role: "owner" },
  dave: { username: "dave", role: "admin", org: "acme" },
  erin: { username: "erin", role: "member", org: "acme" },
  weird: { username: "../../etc/passwd", role: "member" },
};
const ORG_NAMES = { default: "总部", acme: "Acme 分公司" };
let solo = false;
const audits = [];

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, _res, next) => { req.user = USERS[req.headers["x-u"]]; next(); });
app.use(tpls.createPromptTplsRouter({
  isSolo: () => solo,
  canEditOrg: (u) => rbac.can(u, "admin.write"),
  orgIdOf: (u) => (u && u.org) || "default",
  orgName: (u) => ORG_NAMES[(u && u.org) || "default"],
  audit: (e) => audits.push(e),
}));

let port = 0;
function call(who, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port, method, path: url,
      headers: { "x-u": who, ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const get = (who) => call(who, "GET", "/api/prompt-tpls");
const post = (who, body) => call(who, "POST", "/api/prompt-tpls", body);
const del = (who, scope, id) => call(who, "DELETE", `/api/prompt-tpls/${scope}/${encodeURIComponent(id)}`);
const hide = (who, scope, id, hidden = true) => call(who, "POST", "/api/prompt-tpls/hidden", { scope, id, hidden });
const orgFile = (id) => path.join(BASE, "orgs", id + ".json");

async function main() {
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  port = srv.address().port;

  await section("【1】我的：只有本人看得见", async () => {
    const r0 = await get("alice");
    eq(r0.status, 200, "GET 通");
    ok(r0.body.mine.items.length === 0 && r0.body.mine.hidden.length === 0, "一开始什么都没有");
    eq(r0.body.org && r0.body.org.name, "总部", "公司这一层带着组织名");
    eq(r0.body.can_edit_org, false, "成员：can_edit_org=false，界面上不摆改公司模板的按钮");

    const r1 = await post("alice", { scope: "mine", t: "我的周报", c: "办公", d: "自己用", p: "写周报 __本周__", icon: "pencil" });
    eq(r1.status, 200, "新建一条");
    ok(/^u-[0-9a-f]{12}$/.test(r1.body.item.id), "id 是服务端发的 u-xxxx", r1.body.item.id);
    const id = r1.body.item.id;
    eq((await get("alice")).body.mine.items.length, 1, "本人读得回来");
    eq((await get("bob")).body.mine.items.length, 0, "同组织的 bob 看不见");
    eq((await del("bob", "mine", id)).status, 404, "bob 删不着 alice 的（在他那份里根本没这条）");
    eq((await get("alice")).body.mine.items.length, 1, "alice 那条还在");

    const r2 = await post("alice", { scope: "mine", id, t: "我的周报 v2", p: "新的提示词" });
    eq(r2.status, 200, "改");
    const items = (await get("alice")).body.mine.items;
    ok(items.length === 1 && items[0].id === id && items[0].t === "我的周报 v2" && items[0].p === "新的提示词", "改的是原来那条，没多出一条", items);
    eq((await post("alice", { scope: "mine", id: "u-000000000000", t: "x", p: "y" })).status, 404, "改一条不存在的 → 404");
    eq((await del("alice", "mine", id)).status, 200, "本人删得掉");
    eq((await get("alice")).body.mine.items.length, 0, "删完就没了");
    eq(audits.length, 0, "「我的」这一层不进组织审计");
  });

  await section("【2】字段校验", async () => {
    const bad = async (body, want, name) => {
      const r = await post("alice", { scope: "mine", t: "标题", p: "提示词", ...body });
      ok(r.status === 400 && String(r.body && r.body.error).includes(want), name, r);
    };
    await bad({ t: "  " }, "标题", "标题空着 → 400");
    await bad({ p: "" }, "提示词", "提示词空着 → 400");
    await bad({ t: "字".repeat(41) }, "40", "标题 41 个字 → 400");
    await bad({ c: "字".repeat(13) }, "12", "分类 13 个字 → 400");
    await bad({ d: "字".repeat(81) }, "80", "说明 81 个字 → 400");
    await bad({ p: "字".repeat(8001) }, "8000", "提示词 8001 个字 → 400");
    await bad({ scope: "everyone" }, "没有这一层", "没有的层 → 400");
    const r = await post("alice", { scope: "mine", t: "  有空格  ", p: "a\r\nb", icon: "../../x" });
    eq(r.body.item.icon, "file-text", "图标名不合规 → 退回 file-text");
    eq(r.body.item.c, "其他", "分类空着 → 其他");
    eq(r.body.item.t, "有空格", "标题去掉首尾空白");
    eq(r.body.item.p, "a\nb", "Windows 换行收成 \\n");
    await del("alice", "mine", r.body.item.id);
  });

  await section("【3】公司：成员写不进，管理员改动进审计", async () => {
    const r0 = await post("alice", { scope: "org", t: "偷塞一条", p: "x" });
    eq(r0.status, 403, "成员往公司层写 → 403");
    ok(!fs.existsSync(orgFile("default")), "盘上没落文件");
    eq(audits.length, 0, "审计里也没记");

    const c0 = await get("carol");
    eq(c0.body.can_edit_org, true, "管理员：can_edit_org=true");
    const r1 = await post("carol", { scope: "org", t: "报价单模板", c: "销售", p: "按 __客户__ 出报价单" });
    eq(r1.status, 200, "管理员加一条公司模板");
    ok(/^o-[0-9a-f]{12}$/.test(r1.body.item.id) && r1.body.item.by === "carol", "id 是 o-xxxx，记着是谁加的", r1.body.item);
    const id = r1.body.item.id;
    const last = () => audits[audits.length - 1] || {};
    ok(last().action === "加公司模板" && last().actor === "carol" && last().org === "default" && last().target === "报价单模板", "审计：加公司模板", last());

    const a = await get("alice");
    ok(a.body.org.items.some((x) => x.id === id), "同组织的成员看得见");
    eq((await del("alice", "org", id)).status, 403, "成员删不了公司模板");
    eq((await post("alice", { scope: "org", id, t: "改掉", p: "x" })).status, 403, "成员改不了公司模板");
    eq((await get("alice")).body.org.items[0].t, "报价单模板", "公司那条原样没动");

    eq((await post("boss", { scope: "org", id, t: "报价单模板 v2", p: "y" })).status, 200, "超管改得了");
    eq(last().action, "改公司模板", "审计：改公司模板");
    eq((await del("carol", "org", id)).status, 200, "管理员删得了");
    eq(last().action, "删公司模板", "审计：删公司模板");
    eq(audits.length, 3, "一共三条审计，没多没少");
  });

  await section("【4】组织之间互相看不见", async () => {
    const r = await post("dave", { scope: "org", t: "Acme 专用", p: "x" });
    eq(r.status, 200, "分公司管理员加一条");
    eq(audits[audits.length - 1].org, "acme", "审计记在分公司名下");
    ok((await get("erin")).body.org.items.some((x) => x.t === "Acme 专用"), "分公司的成员看得见");
    eq((await get("erin")).body.org.name, "Acme 分公司", "组织名是分公司自己的");
    ok(!(await get("alice")).body.org.items.some((x) => x.t === "Acme 专用"), "总部的人看不见");
    eq((await del("carol", "org", r.body.item.id)).status, 404, "总部管理员删不着分公司的（在总部那份里没这条）");
    ok(fs.existsSync(orgFile("acme")), "分公司单独一个文件");
  });

  await section("【5】藏内置模板", async () => {
    const n0 = audits.length;
    eq((await hide("alice", "mine", "b-web-dashboard")).status, 200, "成员藏一条（只对自己）");
    ok((await get("alice")).body.mine.hidden.includes("b-web-dashboard"), "alice 那份记着");
    eq((await get("bob")).body.mine.hidden.length, 0, "bob 不受影响");
    eq(audits.length, n0, "「我的」藏起不进审计");

    eq((await hide("alice", "org", "b-web-landing")).status, 403, "成员对全组织藏 → 403");
    eq((await hide("carol", "org", "b-web-landing")).status, 200, "管理员对全组织藏");
    ok((await get("bob")).body.org.hidden.includes("b-web-landing"), "同组织的 bob 那边也藏了");
    eq(audits[audits.length - 1].action, "对全组织藏起内置模板", "审计：对全组织藏起");
    const n1 = audits.length;
    eq((await hide("carol", "org", "b-web-landing")).status, 200, "再藏一遍也是 200");
    eq(audits.length, n1, "重复藏不再记一条审计");
    eq((await get("carol")).body.org.hidden.filter((x) => x === "b-web-landing").length, 1, "也没记成两份");
    eq((await hide("alice", "org", "b-web-landing", false)).status, 403, "成员放不回管理员藏的");
    eq((await hide("carol", "org", "b-web-landing", false)).status, 200, "管理员放得回");
    eq(audits[audits.length - 1].action, "放回内置模板", "审计：放回");
    ok(!(await get("bob")).body.org.hidden.includes("b-web-landing"), "全组织又看得见了");

    const r = await hide("alice", "mine", "u-abcdef012345");
    ok(r.status === 400 && /内置/.test(r.body.error), "自己加的不走「藏」，拿它的 id 来 → 400", r);
    eq((await hide("alice", "mine", "../x")).status, 400, "怪 id → 400");
    eq((await hide("alice", "mine", "b-web-dashboard", false)).status, 200, "成员放回自己藏的");
    eq((await get("alice")).body.mine.hidden.length, 0, "放回了");
  });

  await section("【6】照着内置模板改一份：副本和藏起原件同一次写盘", async () => {
    const r = await post("alice", { scope: "mine", hide: "b-data-chart", t: "我的图表", p: "画图 __数据__" });
    eq(r.status, 200, "存一份");
    const v = (await get("alice")).body.mine;
    ok(v.items.some((x) => x.t === "我的图表") && v.hidden.includes("b-data-chart"), "副本在、原件藏了", v);
    const r2 = await post("alice", { scope: "mine", hide: "not-builtin", t: "x", p: "y" });
    eq(r2.status, 200, "hide 给的不是内置 id：照样存");
    ok(!(await get("alice")).body.mine.hidden.includes("not-builtin"), "但不会藏一个认不出的 id");
    const n0 = audits.length;
    await post("carol", { scope: "org", hide: "b-office-ppt", t: "公司版 PPT", p: "按公司模板做 PPT" });
    ok((await get("bob")).body.org.hidden.includes("b-office-ppt"), "管理员照着改到公司层：全组织藏起原件");
    ok(audits.length === n0 + 1 && /藏起/.test(audits[audits.length - 1].detail), "审计里写明原件对全组织藏起", audits[audits.length - 1]);
  });

  await section("【7】个人桌面版没有「公司」这一层", async () => {
    solo = true;
    try {
      const r = await get("boss");
      eq(r.body.org, null, "GET：org=null");
      eq(r.body.can_edit_org, false, "超管也是 can_edit_org=false");
      const w = await post("boss", { scope: "org", t: "x", p: "y" });
      ok(w.status === 403 && /个人桌面版/.test(w.body.error), "超管往公司层写 → 403", w);
      eq((await post("boss", { scope: "mine", t: "x", p: "y" })).status, 200, "「我的」照常能写");
    } finally { solo = false; }
  });

  await section("【8】上限、坏文件、怪用户名", async () => {
    const r0 = await post("bob", { scope: "mine", t: "第一条", p: "x" });
    const f = fs.readdirSync(path.join(BASE, "users")).map((n) => path.join(BASE, "users", n))
      .find((p) => JSON.stringify(JSON.parse(fs.readFileSync(p, "utf8"))).includes(r0.body.item.id));
    ok(!!f, "找到 bob 的文件");
    const full = { items: Array.from({ length: tpls.MAX_ITEMS }, (_, i) => ({ id: "u-" + String(i).padStart(12, "0"), t: "t" + i, c: "其他", d: "", p: "p", icon: "file-text" })), hidden: [] };
    fs.writeFileSync(f, JSON.stringify(full));
    const r1 = await post("bob", { scope: "mine", t: "第 201 条", p: "x" });
    ok(r1.status === 400 && /200/.test(r1.body.error), "满 200 条再加 → 400", r1);
    eq((await post("bob", { scope: "mine", id: "u-000000000007", t: "改第 8 条", p: "x" })).status, 200, "满了照样能改已有的");

    fs.writeFileSync(f, "{ 这不是 JSON");
    const r2 = await get("bob");
    ok(r2.status === 200 && r2.body.mine.items.length === tpls.MAX_ITEMS, "文件坏了、有 .bak：GET 照样 200，退回上一版", r2.body && r2.body.mine.items.length);
    fs.writeFileSync(f, "{ 这不是 JSON");
    fs.rmSync(f + ".bak", { force: true });
    const r3 = await get("bob");
    ok(r3.status === 200 && r3.body.mine.items.length === 0, "文件坏了、连 .bak 都没有：GET 照样 200，按空的算", r3);
    eq((await post("bob", { scope: "mine", t: "坏了之后第一条", p: "x" })).status, 200, "坏了之后还能接着存");

    eq((await post("weird", { scope: "mine", t: "x", p: "y" })).status, 200, "用户名带 ../ 也能存");
    const users = path.join(BASE, "users");
    const all = fs.readdirSync(users).filter((n) => n.endsWith(".json"));
    ok(all.length >= 4 && all.every((n) => /^[a-z0-9_-]*-?[0-9a-f]{10}\.json$/.test(n)), "users/ 下的文件名全是「前缀-哈希」，没有 ../", all);
    ok(!fs.existsSync(path.join(BASE, "..", "..", "etc")), "没往目录外写");
  });

  await section("【9】接线", async () => {
    const server = fs.readFileSync(entry("server"), "utf8");
    const guard = server.indexOf("app.use(account.authGuard");
    const mount = server.indexOf("app.use(createPromptTplsRouter(");
    ok(guard > 0 && mount > guard, "server.js：挂在 authGuard 后面（req.user 一定有）", { guard, mount });
    const wiring = server.slice(mount, server.indexOf("}));", mount));
    ok(/can\(u, "admin\.write"\)/.test(wiring), "公司层按 admin.write 判（管理员、超管有，成员没有）");
    ok(/isSolo: admin\.isSoloDesktop/.test(wiring), "个人桌面版判定用的是 admin.isSoloDesktop");
    ok(/audit: org\.audit/.test(wiring), "审计落到组织审计里");
    ok(rbac.can({ role: "admin" }, "admin.write") && rbac.can({ role: "owner" }, "admin.write") && !rbac.can({ role: "member" }, "admin.write"),
      "rbac：admin/owner 有 admin.write，member 没有");

    const app05 = fs.readFileSync(path.join(ROOT, "public", "js", "app-05.js"), "utf8");
    const table = app05.slice(app05.indexOf("const PROMPT_TPLS = ["), app05.indexOf("];", app05.indexOf("const PROMPT_TPLS = [")));
    const ids = [...table.matchAll(/\{ id: "([^"]+)"/g)].map((m) => m[1]);
    const entries = (table.match(/\n  \{ /g) || []).length;
    ok(ids.length === entries && ids.length >= 14, "每条内置模板都有 id", { ids: ids.length, entries });
    eq(new Set(ids).size, ids.length, "id 不重复");
    ok(ids.every((x) => /^b-[a-z0-9-]{1,40}$/.test(x)), "id 都过得了服务端的校验（b-小写短横线）", ids);
    ok(app05.includes("// ================= 参考模板库（照着抄的提示词，点一下填进输入框） ================="),
      "分段标记原样还在（前端测试拿它切源码）");
  });

  srv.close();
  finished = true;
  console.log(`\n${fail ? "✗" : "✓"} 参考模板库：${pass} 过 / ${fail} 挂`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; finished = true; });
void HOME;
