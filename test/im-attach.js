// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * IM 附件挑选（im.js 的 pickAttachments）。
 *
 * 起因是真事：飞书上先做了两张封面图（当轮发过），下一轮做 Word 文档，agent 回复末尾顺口一句
 * 「之前那两张封面图也还在工作目录里（owb_cover_poster.png、owb_cover_ai.jpg），要的话说一声」，
 * 两张图就被当成「点名要发」又发了一遍。提到 ≠ 要发。
 *
 * 盯的几件事，每条配反向对照：
 *   ① 本轮有新文件时，只提到名字的旧文件不附；
 *   ② 旧文件写了 [[发文件: 名字]] 才附，标记从正文里剥干净；
 *   ③ 本轮一个新文件都没有（「把上次那个发我」）时，点到名字的旧文件照发；
 *   ④ [[不发文件]] 一个都不附，新文件也不附；
 *   ⑤ 同一张图的 svg+png 只发 png（原有规矩不能丢）；
 *   ⑥ 收进来的附件名在 Windows 上换掉冒号、保留名、末尾的点（im-media 的 safeBaseName / saveInbound）。
 */
const path = require("path");
const os = require("os");
const fs = require("fs");
const { mod } = require("./lib/mod");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-im-attach-"));
process.env.OPENWORKBUDDY_HOME = HOME;
const { pickAttachments } = require(mod("im"))._internals;

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra).slice(0, 600) : "")); }
};
const names = (r) => r.files.map((f) => f.name).sort();
const eq = (got, want, msg) => ok(JSON.stringify(got) === JSON.stringify(want), msg, { got, want });

const f = (name) => ({ name });
const docx = f("OpenWorkBuddy项目介绍.docx");
const poster = f("owb_cover_poster.png");
const ai = f("owb_cover_ai.jpg");
const all = [docx, poster, ai, f("gen_owb_docx.js")];

console.log("① 顺口提到的旧文件不发");
{
  const out = "Word 文档做好了：OpenWorkBuddy项目介绍.docx。\n之前生成的两张封面图也还在工作目录里（owb_cover_poster.png、owb_cover_ai.jpg），需要的话说一声一起发。";
  const r = pickAttachments({ out, fresh: [docx], all });
  eq(names(r), ["OpenWorkBuddy项目介绍.docx"], "只发这轮新做的 docx，两张旧封面不跟着发");
  ok(r.out.includes("owb_cover_poster.png"), "正文原样保留（提到它没错，只是不发）");
}

console.log("② 旧文件要发得写标记");
{
  const out = "文档和封面都发你。\n[[发文件: owb_cover_poster.png]]";
  const r = pickAttachments({ out, fresh: [docx], all });
  eq(names(r), ["OpenWorkBuddy项目介绍.docx", "owb_cover_poster.png"], "标了的旧文件附上，没标的 owb_cover_ai.jpg 不附");
  ok(!r.out.includes("[[") && !r.out.includes("发文件"), "标记从正文里剥干净了", r.out);
  const r2 = pickAttachments({ out: "好\n[[发文件：work/sub/owb_cover_ai.jpg]]", fresh: [docx], all });
  eq(names(r2), ["OpenWorkBuddy项目介绍.docx", "owb_cover_ai.jpg"], "全角冒号、带路径的写法也认（按基名比）");
  const r3 = pickAttachments({ out: "[[发文件: 不存在.png]]", fresh: [docx], all });
  eq(names(r3), ["OpenWorkBuddy项目介绍.docx"], "标了个不存在的文件：不凭空造附件");
}

console.log("③ 本轮没有新文件：点名照发");
{
  const out = "上次那张在这：owb_cover_poster.png，文件马上作为附件发给你。";
  const r = pickAttachments({ out, fresh: [], all });
  eq(names(r), ["owb_cover_poster.png"], "「把上次那张发我」：点到名字就发");
  const r2 = pickAttachments({ out, fresh: [docx], all });
  eq(names(r2), ["OpenWorkBuddy项目介绍.docx"], "反向对照：同一句话，本轮有新文件时就不再凭名字发");
}

console.log("④ [[不发文件]]");
{
  const r = pickAttachments({ out: "全文如下……\n[[不发文件]]", fresh: [docx], all });
  eq(r.files.length, 0, "新文件也不附");
  ok(!r.out.includes("[[不发文件]]"), "标记剥掉了");
  const r2 = pickAttachments({ out: "全文如下……\n[[发文件: owb_cover_ai.jpg]]\n[[不发文件]]", fresh: [docx], all });
  eq(r2.files.length, 0, "两个标记同时出现：不发优先");
}

console.log("⑤ svg/png 双胞胎只发 png");
{
  const svg = f("架构图.svg"), png = f("架构图.png");
  const r = pickAttachments({ out: "图画好了", fresh: [svg, png], all: [svg, png] });
  eq(names(r), ["架构图.png"], "同主名只发 PNG");
}

console.log("⑥ 收进来的附件名在 Windows 上能落盘");
{
  // 手机上发来的「Q3:计划.docx」在 NTFS 上会写成 0 字节的 Q3 + 备用数据流，用户打不开。
  // 本机不是 Windows，靠 platform 参数测；每条都配 darwin 的反向对照，确认别的系统一点不变。
  const { safeBaseName, saveInbound } = require(mod("im-media"));
  const cases = [
    ["Q3:计划.docx", "Q3_计划.docx", "Q3:计划.docx"],
    ["CON.txt", "_CON.txt", "CON.txt"],
    ["报告?.pdf", "报告_.pdf", "报告?.pdf"],
    ["草稿. ", "草稿", "草稿."],
    ["a\\b:c.txt", "b_c.txt", "b:c.txt"],
    ["正常名字.png", "正常名字.png", "正常名字.png"],
  ];
  for (const [raw, win, mac] of cases) {
    eq(safeBaseName(raw, "win32"), win, `Windows：${JSON.stringify(raw)} → ${win}`);
    eq(safeBaseName(raw, "darwin"), mac, `反向对照 macOS：${JSON.stringify(raw)} → ${mac}`);
  }
  // HOME 本身就是这一轮新建的临时目录，里面用固定的子目录就够了；收尾时跟着 HOME 一起删
  const dir = path.join(HOME, "inbound");
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.from("纪要正文");
  const a = saveInbound(dir, "会议:纪要.txt", buf, { platform: "win32" });
  eq(a, "会议_纪要.txt", "Windows：存下来的名字换掉了冒号");
  ok(fs.existsSync(path.join(dir, a)) && fs.readFileSync(path.join(dir, a), "utf8") === "纪要正文", "文件真的落在那个名字上，内容完整");
  eq(saveInbound(dir, "", buf, { platform: "win32", fallback: "NUL" }), "_NUL", "Windows：备用名是保留名也换掉");
  eq(saveInbound(dir, "会议:纪要.txt", buf, { platform: "darwin" }), "会议:纪要.txt", "反向对照 macOS：名字原样");
  // 不传 platform 走本机：本机不是 Windows，行为和改之前一样
  if (process.platform !== "win32") eq(safeBaseName("Q3:计划.docx"), "Q3:计划.docx", "不传 platform：非 Windows 照旧");
}

console.log(`\n${pass} 通过，${fail} 失败`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
