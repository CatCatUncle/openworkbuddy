#!/usr/bin/env node
"use strict";
/**
 * 数一遍这个项目现在有多少东西，写进 docs/stats.json。
 *
 * 为什么要这么个文件：README 顶上那排徽章想写「34 个技能 / 40 个连接器」，
 * 但手写的数字一定会过期——加了技能没人记得回来改 README，过半年那排数字就成了假的。
 * shields.io 能直接读一个公开 JSON 里的字段（dynamic/json），所以把数字放这儿，
 * 徽章自己去读：改了代码、跑一次 `npm run stats`、提交，徽章就跟着变。
 *
 * 这个法子是从 oomol-lab/open-connector 的 README 学来的——它那两颗 Providers / Actions
 * 徽章是从自家线上目录接口实时读的。我们没有那样的公开接口，就退一步读仓库里的静态文件，
 * 效果一样，还少一个会挂的外部依赖。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// 只数 git 真跟踪的技能，不数磁盘上有什么。
// 本机的 skills/ 底下还躺着十来个 .gitignore 掉的第三方技能包（仓库不打包别人的代码，
// 在应用内一键从上游装）。按磁盘数出来是 34，可别人 clone 下来只有 24——
// 徽章立刻就成了假的，而且是「写在 README 第一屏、谁都验得了」的那种假。
// git ls-files 拿的是「这个仓库发出去到底带了什么」，跟 repo-hygiene 那条守卫同一个判据。
const trackedSkillDirs = new Set(
  require("child_process")
    .execFileSync("git", ["ls-files", "skills/"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((f) => f.split("/")[1])
    .filter(Boolean)
);
// 大小写跟 skills.js 的 /^skill\.md$/i 对齐：macOS 大小写不敏感，写死 SKILL.md 在 Linux 上一个都数不出来
const skills = [...trackedSkillDirs]
  .filter((n) => {
    try { return fs.readdirSync(path.join(ROOT, "skills", n)).some((f) => /^skill\.md$/i.test(f)); }
    catch { return false; }
  })
  .length;

const experts = JSON.parse(read("experts.json"));
const stats = {
  _说明: "README 徽章读的就是这个文件；改完代码跑 `npm run stats` 再提交。别手改。",
  updated: new Date().toISOString().slice(0, 10),
  version: JSON.parse(read("package.json")).version,
  skills,
  // 工具不只 TOOL_DEFS 一处：委派、问用户、定时、发信这些定义在 agent.js，按会话条件挂上去。
  // 只数 tools.js 那一份，徽章上写的是 27，可用户在设置页数得出 36——差的正好是「最像 agent 的那几个」。
  // 按名字去重，免得哪天同一个工具两边都定义了被数两遍。
  tools: (() => {
    const base = require(path.join(ROOT, "tools.js")).TOOL_DEFS.map((t) => t.name);
    const extra = [...read("agent.js").matchAll(/^  name: "([a-z_]+)",$/gm)].map((m) => m[1]);
    return new Set([...base, ...extra]).size;
  })(),
  connectors: require(path.join(ROOT, "mcp-catalog.js")).ITEMS.length,
  experts: (experts.experts || []).length,
  teams: (experts.teams || []).length,
};

// 一个都数不出来多半是路径或大小写出了问题，这时候写进去等于把 README 的数字清零，不如直接报错
for (const k of ["skills", "tools", "connectors", "experts", "teams"]) {
  if (!stats[k]) throw new Error(`统计不出 ${k}（数出来是 ${stats[k]}）——先别写文件，检查一下是不是路径变了`);
}

const out = path.join(ROOT, "docs", "stats.json");
fs.writeFileSync(out, JSON.stringify(stats, null, 2) + "\n");
console.log("[stats] " + path.relative(ROOT, out) + "：" +
  `技能 ${stats.skills} · 工具 ${stats.tools} · 连接器 ${stats.connectors} · 专家 ${stats.experts} · 专家团 ${stats.teams}`);
