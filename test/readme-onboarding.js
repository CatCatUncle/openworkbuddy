// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
process.on("uncaughtException", error => { console.error(error.stack || error); process.exit(1); });
const fs = require("fs"), path = require("path"), assert = require("assert/strict");
const root = path.join(__dirname, ".."), read = (file) => fs.readFileSync(path.join(root, file), "utf8");
let count = 0;
const brokenStrong = /\*\*[^*\n]*\p{P}\*\*(?=[\p{L}\p{N}])/u;
for (const [file, label, why, commercial] of [["README.md", "## 快速开始：", "## 为什么是它", "## 商用授权"], ["README.en.md", "## Quick start:", "## Why this one", "## Commercial license"]]) {
 const text = read(file), start = text.indexOf(label);
 assert.ok(start > 0 && start < text.indexOf(why) && start < text.indexOf(commercial));
 assert.ok(text.indexOf('href="#quick-start"') < start);
 const quick = text.slice(start, text.indexOf(why));
 assert.ok(!brokenStrong.test(quick), file + ": a punctuation-ended bold label must not touch the following word");
 assert.ok(quick.includes("project-update.pptx")); assert.ok(quick.includes("npm ci\nnpm start")); assert.ok(quick.includes("localhost:3800")); assert.ok(quick.includes("Node.js 18+"));
 assert.ok(quick.includes("16:9") && quick.includes("PowerPoint") && quick.includes("LibreOffice"));
 const prompt = quick.match(/```text\n([\s\S]*?)\n```/);
 assert.ok(prompt, file + ": a copyable presentation task is required");
 assert.equal(prompt[1] + "\n", read(file === "README.md" ? "examples/quick-start/task.md" : "examples/quick-start/task.en.md"), file + ": README and downloadable task must match");
 assert.ok(quick.includes("Craft")); assert.ok(quick.includes("examples/quick-start/"));
 assert.match(text, /utm_source=github&amp;utm_medium=readme&amp;utm_campaign=first_result/);
 assert.ok(!text.includes('width="120"')); assert.ok(text.includes('src="docs/images/demo.gif"'));
 const mail = "contact@aijentra.com", wechat = "agi_smith";
 for (const [area, section] of [["first screen", text.slice(0, start)], ["commercial licensing", text.slice(text.indexOf(commercial))]]) {
  assert.ok(section.includes("mailto:" + mail) && section.includes(wechat), file + ": " + area + " must retain public licensing email and WeChat");
 }
 assert.ok(!/\[(?:联系维护者|[Cc]ontact the maintainer)\]\(https:\/\/github\.com\/CatCatUncle\)/.test(text), file + ": a profile link cannot replace public purchase contacts");
 count++; console.log("✓ " + file + ": clear first task, prerequisites, verified-output criteria and early start link");
}
assert.ok(brokenStrong.test("**计时方式：**从开始安装") && !brokenStrong.test("**计时方式**：从开始安装"), "Bold label rendering guard must detect the broken form and accept the rendered form");
for (const [file, sections] of [["examples/quick-start/task.md", ["封面", "本周完成", "当前进展", "下周计划"]], ["examples/quick-start/task.en.md", ["Cover", "Completed this week", "Current progress", "Next week"]]]) {
 const text = read(file); assert.ok(text.includes("project-update.pptx")); assert.ok(sections.every((section) => text.includes(section)));
}
assert.deepEqual(read("docs/adoption-metrics.csv").trim().split("\n").length, 1);
const metrics = read("docs/采用与反馈.md"); assert.ok(metrics.includes("缺失") && metrics.includes("分母") && metrics.includes("No first-success time or rate has been published")); count++; console.log("✓ Metrics define success, denominators and missing observations; the template contains no fabricated data");
for (const file of ["docs/index.html", "docs/zh/index.html"]) { const text = read(file); assert.match(text, /utm_source=website&amp;utm_medium=referral&amp;utm_campaign=first_result/); assert.ok(text.includes("#quick-start")); assert.ok(!text.includes("follow releases")); }
count++; console.log("✓ Website links identify the reverse direction and point to the same first-success path");
console.log(`README onboarding: ${count} checks passed`);
