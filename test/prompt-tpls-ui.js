// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 参考模板库那一页，真点一遍：
 *
 *   A 成员：新建、改、删自己的（删了能撤销）；带空的模板先出填空表，没填完的到输入框里按 Tab 跳；
 *     编辑框里选中字点「设为填空」、下面列出几个空、能试填；照着内置模板改一份（原件跟着藏起）；藏一条内置的、再放回；
 *     改过没存按 Esc 先问一句，「接着改」字还在
 *   B 管理员：新建时能挑「放在 公司」，提示跟着换；藏内置模板先问「只对我 / 对全组织」
 *   C 再换回成员：公司那条只能「存一份给自己」，没有改 / 删；管理员对全组织藏的，成员这边只有一句说明、没有「放回」
 *   D 个人桌面版：没有「公司」那一栏
 *   E 切英文：按钮、栏目、编辑框、藏起那一问，一个汉字都不剩（内置模板正文本来就是中文，不算）
 *
 * 后端是真的 src/server/routes/prompt-tpls.js，登录那层换成「现在是谁」一个变量；页面是真的 index.html。
 *
 * 跑法：npx electron test/prompt-tpls-ui.js
 */

const { mod } = require("./lib/mod");
if (!process.versions.electron) {
  const fs0 = require("fs");
  let bin = null;
  try { bin = require("electron"); } catch {}
  if (typeof bin !== "string" || !fs0.existsSync(bin)) {
    console.log("跳过：没装 electron（纯服务端部署没有界面这一层）");
    process.exit(0);
  }
  const r = require("child_process").spawnSync(bin, [__filename], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
    timeout: 300000, killSignal: "SIGKILL",
  });
  process.exit(r.status == null ? 1 : r.status);
}

// 赶在 require 生产模块之前：模板存盘的目录跟着它走，不碰用户真实的 data/
require("./lib/own-home")("prompt-tpls-ui");

const path = require("path");
const express = require("express");
const { app, BrowserWindow } = require("electron");

if (process.platform === "darwin" && app.dock && app.dock.hide) app.dock.hide();

const ROOT = path.join(__dirname, "..");
const rbac = require(mod("rbac"));
const tpls = require(mod("routes/prompt-tpls"));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail).slice(0, 600))); }
};

const USERS = {
  alice: { username: "alice", role: "member" },
  carol: { username: "carol", role: "admin" },
};
let who = "alice";
let solo = false;
const audits = [];

function serve() {
  const web = express();
  web.use(express.json({ limit: "1mb" }));
  web.use("/api", (req, _res, next) => { req.user = USERS[who]; next(); });
  web.use(tpls.createPromptTplsRouter({
    isSolo: () => solo,
    canEditOrg: (u) => rbac.can(u, "admin.write"),
    orgIdOf: () => "default",
    orgName: () => "总部",
    audit: (e) => audits.push(e),
  }));
  web.use(express.static(path.join(ROOT, "public")));
  web.use((_req, res) => res.status(404).json({ error: "nope" }));
  return new Promise((resolve) => { const s = web.listen(0, "127.0.0.1", () => resolve(s)); });
}

async function main() {
  const srv = await serve();
  const win = new BrowserWindow({
    show: false, width: 1280, height: 820, backgroundColor: "#ffffff",
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  await win.loadURL(`http://127.0.0.1:${srv.address().port}/index.html`);
  const run = (code) => win.webContents.executeJavaScript(code);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(expr, what, ms = 4000) {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = await run(expr); } catch {}
      if (v) return v;
      if (Date.now() - t0 > ms) { ok(false, "等不到：" + what); return null; }
      await sleep(40);
    }
  }
  await until(`typeof renderPromptPage === "function" && typeof I18N === "object"`, "页面脚本加载完");
  await run('I18N.setLang("zh")');

  // 这一页平时由侧栏的视图切换建出 #assist-page；这里直接给它一个，只测这一页自己
  const open = async () => {
    await run(`(() => {
      document.querySelectorAll(".ask-mask").forEach((n) => n.remove()); askConfirm._close = null;
      let p = document.getElementById("assist-page");
      if (!p) { p = document.createElement("div"); p.id = "assist-page"; document.body.appendChild(p); }
      p.style.cssText = "position:fixed;inset:0;z-index:100;overflow:auto;background:#fff;padding:20px";
      renderPromptPage._s = null; renderPromptPage(); return 1; })()`);
    await until(`!!renderPromptPage._s.data`, "模板列表从服务端取回来");
  };
  const chips = () => run(`[...document.querySelectorAll(".tpl-src .chip")].map((c) => c.textContent)`);
  const cards = () => run(`[...document.querySelectorAll("#tpl-grid .tpl-card")].map((c) => ({
    t: c.querySelector(".tt").textContent, src: (c.querySelector(".src") || {}).textContent || "",
    ops: [...c.querySelectorAll(".ops button, .ops .tpl-note")].map((b) => b.textContent.trim()) }))`);
  const clickChip = (label) => run(`[...document.querySelectorAll(".tpl-src .chip")].find((c) => c.textContent === ${JSON.stringify(label)}).click()`);
  const clickOp = (title, cls) => run(`(() => { const c = [...document.querySelectorAll("#tpl-grid .tpl-card")].find((x) => x.querySelector(".tt").textContent === ${JSON.stringify(title)});
    if (!c) return false; c.querySelector(${JSON.stringify(cls)}).click(); return true; })()`);
  const fill = (k, v) => run(`(() => { const el = document.querySelector('.tpl-ed [data-k="${k}"]'); el.value = ${JSON.stringify(v)};
    el.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  const editor = () => run(`(() => { const b = document.querySelector(".tpl-ed"); if (!b) return null;
    const v = (k) => b.querySelector('[data-k="' + k + '"]').value;
    return { title: b.querySelector(".ask-t").textContent, hint: b.querySelector(".tpl-ed-hint").textContent,
      t: v("t"), c: v("c"), d: v("d"), p: v("p"), okOff: b.querySelector(".ask-ok").disabled,
      scope: [...b.querySelectorAll(".tpl-scope button")].map((x) => x.textContent + (x.classList.contains("on") ? "*" : "")),
      err: b.querySelector(".ask-err").hidden ? "" : b.querySelector(".ask-err").textContent }; })()`);
  const key = (k, extra = "") => run(`document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true${extra} }))`);
  const api = async (u) => { const prev = who; who = u; try { return await run(`fetch("/api/prompt-tpls").then((r) => r.json())`); } finally { who = prev; } };

  // ═════════════ A. 成员 ═════════════
  console.log("\n【A】成员：自己的增删改、照着内置改一份、藏起再放回");
  who = "alice";
  await open();
  {
    const c = await chips();
    ok(c.join("|") === "全部|我的|公司|内置", "栏目：全部 / 我的 / 公司 / 内置（还没藏过，没有「已藏起」）", c);
    const all = await cards();
    ok(all.length === 14 && all.every((x) => x.ops.join("|") === "填进输入框|复制|改|藏起来"), "14 条内置模板，每条都是「填进输入框 复制 改 藏起来」，没有「删」", all.slice(0, 2));
  }
  await run(`document.querySelector(".hub-head .tpl-new").click()`);
  await until(`!!document.querySelector(".tpl-ed")`, "点「新建模板」出编辑框");
  {
    const e = await editor();
    ok(e.title === "新建模板" && e.okOff && e.scope.length === 0 && e.hint === "只有你看得见",
      "编辑框：标题「新建模板」，没填时「保存」按不下去；成员没有「放在」那一栏", e);
  }
  await fill("t", "客户回访话术");
  ok((await editor()).okOff, "只填标题、提示词空着：还是按不下去");
  await fill("p", "给 __客户__ 写一段回访话术");
  await fill("c", "销售");
  ok(!(await editor()).okOff, "标题和提示词都有了：按得下去");
  await run(`document.querySelector('.tpl-ed .tpl-ico[data-ic="mail"]').click()`);
  await run(`document.querySelector(".tpl-ed .ask-ok").click()`);
  await until(`!document.querySelector(".tpl-ed")`, "存完编辑框收起");
  await until(`[...document.querySelectorAll("#tpl-grid .tpl-card .tt")].some((x) => x.textContent === "客户回访话术")`, "新的那条出现在列表里");
  {
    const mine = (await cards()).find((x) => x.t === "客户回访话术");
    ok(mine && mine.src === "我的" && mine.ops.join("|") === "填进输入框|复制|改|删", "新的那条挂「我的」，按钮是「改 删」", mine);
    const d = await api("alice");
    ok(d.mine.items.length === 1 && d.mine.items[0].icon === "mail" && d.mine.items[0].c === "销售", "服务端存上了，图标、分类都对", d.mine.items);
    ok(await run(`[...document.querySelectorAll("#tpl-grid .tpl-card")].find((c) => c.querySelector(".tt").textContent === "客户回访话术").querySelector(".tt").getAttribute("translate") === "no"`),
      "自己写的标题挂着 translate=no：切英文时不会被词典撞上改掉");
  }

  // 改自己的
  await clickOp("客户回访话术", ".tpl-edit");
  await until(`!!document.querySelector(".tpl-ed")`, "点「改」出编辑框");
  {
    const e = await editor();
    ok(e.title === "改模板" && e.t === "客户回访话术" && e.p.includes("__客户__") && e.scope.length === 0, "改：原来的内容都填好了，不给换层", e);
  }
  await fill("t", "客户回访话术 v2");
  await run(`document.querySelector(".tpl-ed .ask-ok").click()`);
  await until(`[...document.querySelectorAll("#tpl-grid .tpl-card .tt")].some((x) => x.textContent === "客户回访话术 v2")`, "改完列表里是新标题");
  ok((await api("alice")).mine.items.length === 1, "改的是原来那条，没多出一条");

  // 改过没存：Esc 先问
  await clickOp("客户回访话术 v2", ".tpl-edit");
  await until(`!!document.querySelector(".tpl-ed")`, "再开一次编辑框");
  await fill("p", "改了一半的提示词");
  await key("Escape");
  await until(`[...document.querySelectorAll(".ask-box .ask-t")].some((x) => x.textContent === "改的还没存，丢掉吗？")`, "改过之后按 Esc：先问一句");
  await run(`[...document.querySelectorAll(".ask-box .ask-no")].pop().click()`);
  await sleep(60);
  ok((await editor()) && (await editor()).p === "改了一半的提示词", "点「接着改」：编辑框还在，改了一半的字还在");
  await run(`document.querySelector(".tpl-ed .ask-no").click()`);
  await until(`[...document.querySelectorAll(".ask-box .ask-t")].some((x) => x.textContent === "改的还没存，丢掉吗？")`, "点「取消」也先问");
  await run(`[...document.querySelectorAll(".ask-box .ask-ok")].pop().click()`);
  await until(`!document.querySelector(".tpl-ed")`, "点「丢掉」才关");
  ok((await api("alice")).mine.items[0].p.includes("__客户__"), "丢掉的那次没存进去");
  {
    // 没改过：Esc 直接关，不多问
    await clickOp("客户回访话术 v2", ".tpl-edit");
    await until(`!!document.querySelector(".tpl-ed")`, "开编辑框");
    await key("Escape");
    await sleep(60);
    ok(!(await run(`!!document.querySelector(".ask-mask")`)), "没改过：Esc 直接关，不多问");
  }

  // 照着内置模板改一份
  await clickOp("做一个工作台/仪表盘", ".tpl-edit");
  await until(`!!document.querySelector(".tpl-ed")`, "内置模板点「改」出编辑框");
  {
    const e = await editor();
    ok(e.title === "照着改一份" && e.t === "做一个工作台/仪表盘" && e.hint === "存成你自己的一份，原来那条会藏起来，随时能放回",
      "内置模板的「改」：标题「照着改一份」，说清楚原件会藏起", e);
  }
  await fill("t", "我的仪表盘");
  await run(`document.querySelector(".tpl-ed .ask-ok").click()`);
  await until(`[...document.querySelectorAll("#tpl-grid .tpl-card .tt")].some((x) => x.textContent === "我的仪表盘")`, "副本出现");
  {
    const all = await cards();
    ok(!all.some((x) => x.t === "做一个工作台/仪表盘"), "原来那条从列表里藏起了");
    ok((await chips()).includes("已藏起 1"), "栏目里多了「已藏起 1」", await chips());
    const d = await api("alice");
    ok(d.mine.hidden.includes("b-web-dashboard") && d.mine.items.length === 2, "服务端：副本存上、原件记进藏起名单", d.mine);
  }

  // 直接藏一条（成员不问范围）
  await clickOp("竞品横向对比", ".tpl-hide");
  await until(`(renderPromptPage._s.data.mine.hidden || []).includes("b-research-compare")`, "成员点「藏起来」：不问范围，直接只对自己藏");
  ok((await chips()).includes("已藏起 2"), "「已藏起 2」", await chips());
  await clickChip("已藏起 2");
  {
    const all = await cards();
    ok(all.length === 2 && all.every((x) => x.ops.includes("放回")), "「已藏起」里两条，都有「放回」", all);
  }
  await clickOp("竞品横向对比", ".tpl-restore");
  await until(`!(renderPromptPage._s.data.mine.hidden || []).includes("b-research-compare")`, "放回");
  ok((await chips()).includes("已藏起 1"), "放回一条，剩「已藏起 1」", await chips());

  // ── 用模板：先问几个空 ──
  const sheet = () => run(`(() => { const b = document.querySelector(".tpl-fill"); if (!b) return null;
    return { title: b.querySelector(".ask-t").firstChild.textContent,
      fields: [...b.querySelectorAll(".tpl-fill-f")].map((f) => ({ label: f.querySelector(".tpl-fill-lb").textContent,
        tag: f.querySelector(".tpl-fill-in").tagName, value: f.querySelector(".tpl-fill-in").value,
        picks: [...f.querySelectorAll(".tpl-fill-pk")].map((x) => x.textContent + (x.classList.contains("on") ? "*" : "")) })),
      filled: [...b.querySelectorAll(".tpl-fill-pv mark.on")].map((m) => m.textContent),
      tip: (b.querySelector(".tpl-fill-tip") || {}).textContent || "" }; })()`);
  const sheetSet = (i, v) => run(`(() => { const el = document.querySelectorAll(".tpl-fill .tpl-fill-in")[${i}]; el.value = ${JSON.stringify(v)};
    el.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await clickChip("全部");
  await clickOp("把结论做成图表", ".tpl-use");
  await until(`!!document.querySelector(".tpl-fill")`, "带空的模板点「填进输入框」：先出填空表");
  {
    const s0 = await sheet();
    ok(s0.fields.length === 2 && s0.fields[0].label === "粘贴数据" && s0.fields[0].tag === "TEXTAREA", "「粘贴数据」给多行框", s0.fields);
    ok(s0.fields[1].label === "图表" && s0.fields[1].picks.join("|") === "折线*|柱状|饼图|散点", "「图表」四个选项点着选，默认第一个", s0.fields[1]);
    ok(s0.filled.join("|") === "折线" && /还空着 1 个/.test(s0.tip), "预览里已经填上默认值；提示还空着 1 个", s0);
    ok(await run(`document.activeElement === document.querySelector(".tpl-fill .tpl-fill-in")`), "焦点落在第一个没填的格子上");
  }
  await sheetSet(0, "一月 3\n二月 5");
  await run(`[...document.querySelectorAll(".tpl-fill .tpl-fill-pk")].find((x) => x.textContent === "柱状").click()`);
  {
    const s1 = await sheet();
    ok(s1.fields[1].picks.join("|") === "折线|柱状*|饼图|散点" && s1.filled.includes("柱状") && s1.filled.includes("一月 3\n二月 5") && s1.tip === "",
      "选「柱状」、填上数据：预览跟着变，提示没了", s1);
  }
  await key("Enter", ", metaKey: true, ctrlKey: true");
  await until(`!document.querySelector(".tpl-fill")`, "⌘/Ctrl+回车：填进去");
  {
    const v = await run(`inputEl.value`);
    ok(v.includes("要求：柱状") && v.includes("一月 3\n二月 5") && !v.includes("__"), "输入框里是填好的全文，一条下划线都不剩", v.slice(0, 120));
  }
  await open();
  await clickOp("把结论做成图表", ".tpl-use");
  await until(`!!document.querySelector(".tpl-fill")`, "再开一次");
  {
    const s2 = await sheet();
    ok(s2.fields[0].value === "一月 3\n二月 5" && s2.fields[1].picks.includes("柱状*"), "上次填的值还在", s2.fields);
  }
  await run(`inputEl.value = "别动我"`);
  await key("Escape");
  await until(`!document.querySelector(".tpl-fill")`, "Esc 关表");
  ok((await run(`inputEl.value`)) === "别动我", "Esc：输入框一个字没动");

  // 只填一部分：剩下的留着，到输入框里按 Tab 接着填
  await open();
  await clickOp("材料整理成 PPT", ".tpl-use");
  await until(`!!document.querySelector(".tpl-fill")`, "PPT 模板出表");
  {
    const s3 = await sheet();
    ok(s3.fields.map((f) => f.label + "=" + f.value).join("|") === "要整理的内容=|页数=10", "页数预先填好 10，要整理的内容空着", s3.fields);
  }
  await run(`document.querySelector(".tpl-fill .ask-ok").click()`);
  await until(`!document.querySelector(".tpl-fill")`, "只填一部分也能填进去");
  {
    const r = await run(`({ v: inputEl.value, sel: inputEl.value.slice(inputEl.selectionStart, inputEl.selectionEnd), toast: document.getElementById("owb-toast").textContent })`);
    ok(r.v.includes("页数控制在 10 页") && r.sel.startsWith("__要整理的内容"), "页数填上了；没填的那个空被选中，接着打字就替换", r);
    ok(r.toast === "还有 1 个空，按 Tab 跳到下一个", "提示还有几个空、按 Tab", r.toast);
  }
  // 「空着填进去」：原文照旧进去；Tab / Shift+Tab 在空之间跳
  await open();
  await clickOp("材料整理成 PPT", ".tpl-use");
  await until(`!!document.querySelector(".tpl-fill")`, "再开");
  await run(`document.querySelector(".tpl-fill .tpl-fill-raw").click()`);
  await until(`!document.querySelector(".tpl-fill")`, "点「空着填进去」");
  {
    const tab = (shift) => run(`(() => { inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: ${shift}, bubbles: true, cancelable: true }));
      return inputEl.value.slice(inputEl.selectionStart, inputEl.selectionEnd); })()`);
    ok((await run(`inputEl.value.slice(inputEl.selectionStart, inputEl.selectionEnd)`)).startsWith("__要整理的内容"), "原文进去，选中第一个空");
    ok((await tab(false)) === "__页数=10__", "Tab：跳到下一个空");
    ok((await tab(false)).startsWith("__要整理的内容"), "再 Tab：绕回第一个");
    ok((await tab(true)) === "__页数=10__", "Shift+Tab：往回跳");
    await run(`inputEl.value = "没有空的一句话"; inputEl.setSelectionRange(0, 0)`);
    ok(!(await run(`!inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))`)), "没有空的时候 Tab 不拦，照常切焦点");
  }
  // ── 写模板：选中点「设为填空」 ──
  await open();
  await run(`document.querySelector(".hub-head .tpl-new").click()`);
  await until(`!!document.querySelector(".tpl-ed")`, "新建");
  const strip = () => run(`[...document.querySelectorAll(".tpl-ed .tpl-blanks > *")].map((x) => x.textContent)`);
  ok((await strip()).join("|") === "还没有空：选中要换的字，点「设为填空」", "空着时下面那一排说怎么挖空", await strip());
  await fill("p", "帮我写 产品名 的介绍，语气 正式/轻松");
  await run(`(() => { const ta = document.querySelector('.tpl-ed [data-k="p"]'); ta.setSelectionRange(4, 7); document.querySelector(".tpl-ed .tpl-mk").click(); })()`);
  {
    const r = await run(`(() => { const ta = document.querySelector('.tpl-ed [data-k="p"]'); return { v: ta.value, sel: ta.value.slice(ta.selectionStart, ta.selectionEnd) }; })()`);
    ok(r.v === "帮我写 __产品名__ 的介绍，语气 正式/轻松" && r.sel === "产品名", "选中「产品名」点「设为填空」：下划线自己加上，名字还选着", r);
    ok((await strip()).join("|") === "1 个空|产品名|试填一下", "下面列出这一个空", await strip());
  }
  await run(`(() => { const ta = document.querySelector('.tpl-ed [data-k="p"]'); const i = ta.value.indexOf("正式/轻松"); ta.setSelectionRange(i, i + 5);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "e", metaKey: true, ctrlKey: true, bubbles: true, cancelable: true })); })()`);
  {
    const v = (await editor()).p;
    ok(v.endsWith("语气 __正式/轻松__"), "⌘/Ctrl+E 也行", v);
    ok((await strip()).join("|") === "2 个空|产品名|选一个正式/轻松|试填一下", "选项那个空列成「选一个 正式/轻松」", await strip());
  }
  await run(`document.querySelector(".tpl-ed .tpl-blank").click()`);
  ok((await run(`(() => { const ta = document.querySelector('.tpl-ed [data-k="p"]'); return ta.value.slice(ta.selectionStart, ta.selectionEnd); })()`)) === "产品名", "点下面那枚「产品名」：正文里选中它");
  await run(`document.querySelector(".tpl-ed .tpl-try").click()`);
  await until(`!!document.querySelector(".tpl-fill")`, "「试填一下」");
  {
    const s4 = await sheet();
    ok(s4.title === "试填一下" && s4.fields.length === 2 && !(await run(`!!document.querySelector(".tpl-fill .tpl-fill-raw")`)), "试填：同一张表，只有「看完了」", s4);
  }
  await key("Escape");
  await until(`!document.querySelector(".tpl-fill")`, "Esc 关的是试填那张");
  ok(!!(await editor()) && !(await run(`[...document.querySelectorAll(".ask-box .ask-t")].some((x) => x.textContent === "改的还没存，丢掉吗？")`)), "编辑框还在，没被一起问「丢掉吗」");
  await run(`(() => { const ta = document.querySelector('.tpl-ed [data-k="p"]'); ta.setSelectionRange(6, 6); document.querySelector(".tpl-ed .tpl-mk").click(); })()`);
  ok((await editor()).p.startsWith("帮我写 产品名 的介绍"), "光标在空里再点一次：拆回普通字", (await editor()).p);
  await key("Escape");
  await until(`[...document.querySelectorAll(".ask-box .ask-t")].some((x) => x.textContent === "改的还没存，丢掉吗？")`, "关编辑框问丢不丢");
  await run(`[...document.querySelectorAll(".ask-box .ask-ok")].pop().click()`);
  await until(`!document.querySelector(".tpl-ed")`, "丢掉");
  await open();

  // 删自己的
  await clickChip("我的");
  ok((await cards()).length === 2, "「我的」栏里两条");
  await clickOp("客户回访话术 v2", ".tpl-del");
  await until(`![...document.querySelectorAll("#tpl-grid .tpl-card .tt")].some((x) => x.textContent === "客户回访话术 v2")`, "点「删」：不先问，直接没了");
  ok(!(await run(`!!document.querySelector(".ask-mask")`)), "没弹「确定吗」");
  await until(`(document.getElementById("owb-toast") || {}).textContent === "删掉了，点这里撤销"`, "给一条能点的撤销");
  await run(`document.getElementById("owb-toast").click()`);
  await until(`[...document.querySelectorAll("#tpl-grid .tpl-card .tt")].some((x) => x.textContent === "客户回访话术 v2")`, "点撤销：回来了");
  {
    const back = (await api("alice")).mine.items.find((x) => x.t === "客户回访话术 v2");
    ok(back && back.p.includes("__客户__") && back.icon === "mail" && back.c === "销售", "回来的那条正文、图标、分类都在", back);
  }
  await clickOp("客户回访话术 v2", ".tpl-del");
  await until(`![...document.querySelectorAll("#tpl-grid .tpl-card .tt")].some((x) => x.textContent === "客户回访话术 v2")`, "再删一次，这回不撤");
  ok((await api("alice")).mine.items.length === 1, "服务端也只剩一条");
  ok(audits.length === 0, "成员这一路一条组织审计都没记");

  // ═════════════ B. 管理员 ═════════════
  console.log("\n【B】管理员：能放到公司，藏内置模板先问范围");
  who = "carol";
  await open();
  await run(`document.querySelector(".hub-head .tpl-new").click()`);
  await until(`!!document.querySelector(".tpl-ed")`, "管理员点「新建模板」");
  {
    const e = await editor();
    ok(e.scope.join("|") === "我的*|公司" && e.hint === "只有你看得见", "管理员有「放在 我的 / 公司」，默认我的", e);
  }
  await run(`document.querySelector('.tpl-ed .tpl-scope [data-sc="org"]').click()`);
  ok((await editor()).hint === "全组织都看得见，改动记进操作审计", "点「公司」：提示跟着换成全组织看得见、进审计", await editor());
  await fill("t", "公司报价模板");
  await fill("p", "按公司统一格式给 __客户__ 出报价");
  await run(`document.querySelector(".tpl-ed .ask-ok").click()`);
  await until(`[...document.querySelectorAll("#tpl-grid .tpl-card .tt")].some((x) => x.textContent === "公司报价模板")`, "公司模板出现");
  {
    const c = (await cards()).find((x) => x.t === "公司报价模板");
    ok(c.src === "公司" && c.ops.join("|") === "填进输入框|复制|改|删", "挂「公司」，管理员有「改 删」", c);
    ok(audits.some((a) => a.action === "加公司模板" && a.actor === "carol"), "审计：加公司模板", audits);
  }
  await clickOp("深度研究一个课题", ".tpl-hide");
  await until(`[...document.querySelectorAll(".ask-box .ask-t")].some((x) => x.textContent === "藏起「深度研究一个课题」")`, "管理员点「藏起来」：先问范围");
  ok(await run(`document.activeElement === [...document.querySelectorAll(".ask-box .ask-no")].pop()`), "焦点在「算了」");
  await run(`document.querySelector('.ask-box [data-sc="org"]').click()`);
  await until(`(renderPromptPage._s.data.org.hidden || []).includes("b-research-deep")`, "选「对全组织」：记进公司那份");
  ok(audits.some((a) => a.action === "对全组织藏起内置模板" && a.target === "b-research-deep"), "审计：对全组织藏起", audits.map((a) => a.action));

  // ═════════════ C. 回到成员 ═════════════
  console.log("\n【C】成员看公司那层：只能用、能存一份，放不回管理员藏的");
  who = "alice";
  await open();
  {
    const c = (await cards()).find((x) => x.t === "公司报价模板");
    ok(c && c.ops.join("|") === "填进输入框|复制|存一份给自己", "公司模板在成员这边：没有改 / 删，只有「存一份给自己」", c);
    ok(!(await cards()).some((x) => x.t === "深度研究一个课题"), "管理员对全组织藏的，成员这边也看不到");
  }
  await clickOp("公司报价模板", ".tpl-fork");
  await until(`!!document.querySelector(".tpl-ed")`, "点「存一份给自己」");
  {
    const e = await editor();
    ok(e.title === "存一份给自己" && e.hint === "存成你自己的一份，公司那条不受影响" && e.t === "公司报价模板", "编辑框说清楚公司那条不受影响", e);
  }
  await run(`document.querySelector(".tpl-ed .ask-ok").click()`);
  await until(`(renderPromptPage._s.data.mine.items || []).some((x) => x.t === "公司报价模板")`, "存进了「我的」");
  ok((await api("alice")).org.items.length === 1, "公司那条还是一条，没被动");
  await clickChip("已藏起 2");
  {
    const c = (await cards()).find((x) => x.t === "深度研究一个课题");
    ok(c && c.ops.includes("管理员对全组织藏的") && !c.ops.includes("放回"), "管理员藏的：成员这边只有一句说明，没有「放回」", c);
  }

  // ═════════════ D. 个人桌面版 ═════════════
  console.log("\n【D】个人桌面版没有「公司」那一栏");
  solo = true;
  who = "carol";
  await open();
  {
    const c = await chips();
    ok(!c.includes("公司"), "栏目里没有「公司」", c);
    await run(`document.querySelector(".hub-head .tpl-new").click()`);
    await until(`!!document.querySelector(".tpl-ed")`, "新建");
    ok((await editor()).scope.length === 0, "编辑框里也没有「放在」");
    await key("Escape");
  }
  solo = false;

  // ═════════════ E. 英文 ═════════════
  console.log("\n【E】切英文：界面上的字一个汉字不剩");
  const CJK = /[一-鿿]/;
  who = "carol";
  await open();
  await run('I18N.setLang("en")');
  await sleep(120);
  {
    // 内置模板的标题、说明、分类、正文本来就是中文，不在这一页的翻译范围里；用户写的也不翻
    const left = await run(`(() => {
      const out = [];
      const skip = (el) => el.closest(".tt, .dd, .ct, pre, [translate=no], .tpl-cats");
      const walk = (n) => { for (const c of n.childNodes) {
        if (c.nodeType === 3) { if (/[一-鿿]/.test(c.nodeValue) && !skip(c.parentElement)) out.push(c.nodeValue.trim()); }
        else if (c.nodeType === 1 && !["SCRIPT", "STYLE"].includes(c.nodeName)) walk(c); } };
      walk(document.getElementById("assist-page"));
      // 「公司」那枚栏目的悬停字是组织名，是用户起的名字，不翻
      for (const el of document.querySelectorAll("#assist-page [placeholder], #assist-page [title]:not(.tpl-src [data-s=org])"))
        for (const a of ["placeholder", "title"]) if (/[一-鿿]/.test(el.getAttribute(a) || "") && !skip(el)) out.push(a + "=" + el.getAttribute(a));
      return out; })()`);
    ok(left.length === 0, "列表页：栏目、按钮、搜索框都翻了", left);
  }
  const boxText = () => run(`(() => { const b = [...document.querySelectorAll(".ask-box")].pop(); if (!b) return "没框";
    const t = []; const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) t.push(c.nodeValue); else if (c.nodeType === 1 && c.nodeName !== "DATALIST") walk(c); } };
    walk(b); for (const el of b.querySelectorAll("[placeholder]")) t.push(el.getAttribute("placeholder"));
    return t.join(" ").replace(/\\s+/g, " ").trim(); })()`);
  await run(`document.querySelector(".hub-head .tpl-new").click()`);
  await until(`!!document.querySelector(".tpl-ed")`, "英文下开编辑框");
  await sleep(80);
  {
    const t = await boxText();
    ok(!CJK.test(t), "编辑框：标题、各栏、提示、占位字、按钮都翻了", t);
    await run(`document.querySelector('.tpl-ed .tpl-scope [data-sc="org"]').click()`);
    await sleep(80);
    const t2 = await boxText();
    ok(!CJK.test(t2), "换到「公司」之后的提示也翻了", t2);
  }
  await key("Escape");
  await sleep(40);
  if (await run(`!!document.querySelector(".tpl-ed")`)) {
    // 点过「公司」算改过：会先问一句，英文下这一问也得是英文
    const t = await boxText();
    ok(!CJK.test(t), "「丢掉吗」那一问也翻了", t);
    await run(`[...document.querySelectorAll(".ask-box .ask-ok")].pop().click()`);
    await sleep(60);
  }
  await clickOp("写本周周报", ".tpl-use");
  await until(`!!document.querySelector(".tpl-fill")`, "英文下点「填进输入框」");
  await sleep(80);
  {
    // 空的名字和预览里的正文是模板作者写的中文，不算
    const t = await run(`(() => { const b = document.querySelector(".tpl-fill"); const t = [];
      const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) t.push(c.nodeValue); else if (c.nodeType === 1 && !c.matches("pre, [translate=no]")) walk(c); } };
      walk(b); for (const el of b.querySelectorAll("[placeholder]")) t.push(el.getAttribute("placeholder")); return t.join(" ").replace(/\\s+/g, " ").trim(); })()`);
    ok(!CJK.test(t), "填空表：标题、按钮、提示都翻了", t);
  }
  await key("Escape");
  await run(`document.querySelector(".hub-head .tpl-new").click()`);
  await until(`!!document.querySelector(".tpl-ed")`, "英文下再开编辑框");
  await run(`(() => { const ta = document.querySelector('.tpl-ed [data-k="p"]'); ta.value = "a b"; ta.setSelectionRange(0, 1); document.querySelector(".tpl-ed .tpl-mk").click(); })()`);
  await sleep(80);
  {
    const t = await boxText();
    ok(!CJK.test(t.replace(/__a__|\ba\b/g, "")), "挖了空之后，下面那一排（几个空、试填一下）也翻了", t);
  }
  await key("Escape");
  await sleep(40);
  if (await run(`!!document.querySelector(".tpl-ed")`)) { await run(`[...document.querySelectorAll(".ask-box .ask-ok")].pop().click()`); await sleep(60); }
  await clickOp("写本周周报", ".tpl-hide");
  await until(`!!document.querySelector('.ask-box [data-sc="org"]')`, "英文下点「藏起来」");
  await sleep(80);
  {
    const t = await boxText();
    // 模板名本身是中文（内置的），那一段不算
    ok(!CJK.test(t.replace("写本周周报", "")), "藏起那一问翻了（只剩模板名本身）", t);
  }
  await run(`[...document.querySelectorAll(".ask-box .ask-no")].pop().click()`);
  {
    const s = await run(`[
      I18N.tr("已藏起 3", "en"), I18N.tr("自己加的模板没取到：HTTP 500", "en"),
      I18N.tr("没藏成：HTTP 500", "en"), I18N.tr("没放回：HTTP 500", "en"), I18N.tr("没删掉：HTTP 500", "en"),
      I18N.tr("藏起来了，「已藏起」里能放回", "en"), I18N.tr("存好了", "en"), I18N.tr("删掉了，点这里撤销", "en"),
      I18N.tr("没救回来：HTTP 500", "en"), I18N.tr("放回来了", "en"), I18N.tr("还有 2 个空，按 Tab 跳到下一个", "en")]`);
    ok(s.every((x) => !CJK.test(x)), "toast 和带数目的那几句也有译文", s);
  }
  await run('I18N.setLang("zh")');

  console.log(`\n${pass} 过 / ${fail} 挂`);
  win.destroy(); srv.close();
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(() => main().catch((e) => {
  console.error("跑挂了：", e);
  app.exit(1);
}));
