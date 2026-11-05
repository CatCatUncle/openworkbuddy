// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 写代码那一档（src/agent/code-profile.js）。跑法：node test/code-profile.js
 * 用户原话「cli 执行去写代码效率很低」。录下的真实请求：每一步约 5 万字提示词和工具定义，
 * 非代码文件夹里 run_shell 跑在「任务_」子目录，`node test.js` 直接报找不到模块。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { mod } = require("./lib/mod");
const cp = require(mod("code-profile"));
const taskDirs = require(mod("task-dirs"));

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } };

console.log("【1】工具清单");
const all = ["read_file", "edit_file", "run_shell", "generate_video", "canvas_manage", "send_feishu_message", "desktop_pet", "mcp__gh__issues"].map((name) => ({ name }));
const picked = cp.pickTools(all);
const names = picked.map((t) => t.name);
ok(names.includes("edit_file") && names.includes("run_shell"), "写代码的工具都在");
ok(!names.includes("generate_video") && !names.includes("send_feishu_message") && !names.includes("desktop_pet"), "飞书、生视频、宠物不再每一步都摆着");
ok(names.includes("mcp__gh__issues"), "★用户自己接的连接器留着★ 接它就是要用的");
ok(names.includes("load_tools"), "留了叫回来的入口");

console.log("【2】load_tools");
const offered = new Set(names);
const r = cp.loadGroup("media", all, picked, offered);
ok(!r.isError && picked.some((t) => t.name === "generate_video") && offered.has("generate_video"), "★叫回来下一步就能用★ 工具清单和放行名单一起加");
const n = picked.length;
cp.loadGroup("media", all, picked, offered);
ok(picked.length === n, "叫两次不重复");
ok(cp.loadGroup("没有这组", all, picked, offered).isError, "写错组名说清有哪些");
ok(!cp.loadGroup("browser", all, picked, offered).isError, "这台机器没配的组：如实说，不算错");
for (const [g, list] of Object.entries(cp.TOOL_GROUPS)) ok(list.every((t) => !cp.CODE_TOOLS.has(t)), `${g} 组没有跟常驻工具重复`);

console.log("【3】提示词");
const p = cp.systemPrompt({ name: "小猫", cwd: "/w/proj", osLine: "macOS", shell: "zsh", skillsBlock: "" });
ok(p.length < 2500, `提示词 ${p.length} 字，办公那份一万八`);
ok(p.includes("/w/proj") && p.includes("小猫"), "工作目录和名字写进去了");
ok(!/PROGRESS\.md|成果区|交付物/.test(p), "没有办公交付的规矩");
ok(/不用再读回来确认/.test(p), "写完不用再读回来：回执成功就是写进去了");
ok(cp.modeBlock("ask") && cp.modeBlock("plan") && cp.modeBlock("craft") === "", "只读两档写清不动手");

console.log("【4】git 上下文");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-cp-"));
const gitIn = (args) => require("child_process").spawnSync("git", args, { cwd: dir, encoding: "utf8" });
(async () => {
ok((await cp.gitContext(gitIn)) === "", "不是 git 仓库：什么都不写");
const sh = (a) => require("child_process").spawnSync("git", a, { cwd: dir, stdio: "ignore" });
sh(["init", "-q", "-b", "main"]); sh(["config", "user.email", "t@t"]); sh(["config", "user.name", "t"]);
fs.writeFileSync(path.join(dir, "a.js"), "1"); sh(["add", "."]); sh(["commit", "-qm", "第一次"]);
fs.writeFileSync(path.join(dir, "a.js"), "2");
const g = await cp.gitContext(gitIn);
ok(/分支：main/.test(g) && /a\.js/.test(g) && /第一次/.test(g), "分支、未提交、最近提交都在：省掉开工那一轮");

console.log("【5】目录判定");
ok(taskDirs.hasSourceFiles(dir), "有源码的文件夹认得出");
const docs = fs.mkdtempSync(path.join(os.tmpdir(), "owb-cp-doc-"));
fs.writeFileSync(path.join(docs, "周报.md"), "x"); fs.writeFileSync(path.join(docs, "表.xlsx"), "x");
ok(!taskDirs.hasSourceFiles(docs), "只放文档的文件夹不算，办公任务还是分文件夹");
const src = fs.readFileSync(path.join(__dirname, "..", "cli.js"), "utf8");
ok(/inPlace:[^\n]*hasSourceFiles\(root\)/.test(src), "★命令行里有源码就地读写★ 不然 run_shell 跑在「任务_」里找不到模块");
ok(/profile: runProfile\(\)/.test(src), "命令行把这一档传给了 runTask");
ok(/profile: laneId === "cli" \? "code"/.test(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8")), "桌面工程线走同一档");

fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(docs, { recursive: true, force: true });
console.log(`\n写代码那一档：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
})();
