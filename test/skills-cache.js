// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 技能表缓存：一轮对话不再把几十个 skill.md 从盘上读好几遍——也不许因此读到旧的。
 *
 * 2026-09-29 量的：一轮里 getSkills 至少调 4 次（系统提示词、use_skill、开工前那道闸问一次、判一次），
 * 每次 readFileSync 52 个 skill.md（约 297KB）再加插件技能；5 个对话一起跑就是每轮上千次同步读。
 * 这套测试钉两件互相拉扯的事：
 *   ① 假引擎连跑 10 轮，第 2～10 轮每轮的 readFileSync 不超过第 1 轮，skill.md 一个都不再读；
 *      ★反向对照★ 把缓存关掉，同样 10 轮每轮都整张表重读，累计次数跟着轮数线性涨。
 *   ② 改了就得认：走 saveSkill / deleteSkill / 安装的当场生效；新建、删掉目录当场生效；
 *      绕开这些路径就地改写 skill.md 的，1 秒窗口内还是旧的（★反向对照★：证明缓存真在起作用），
 *      作废一次或过了 1 秒就是新的。插件带来的技能、.state.json 同样认。
 *
 * 模型整个换成假的：一分钱不花、一个字节不出网。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { mod } = require("./lib/mod");

// 赶在 require 生产模块之前：skills.js 的 SKILLS_DIR 在 require 那一刻就按数据目录定死了
const HOME = require("./lib/own-home")("skills-cache");
// 测试自己的临时根下再分小目录：跟着 HOME 一起收，不另起 mkdtemp
let subSeq = 0;
const subdir = (tag) => { const d = path.join(HOME, `${tag}-${++subSeq}`); fs.mkdirSync(d, { recursive: true }); return d; };
const SKILLS = path.join(HOME, "skills");
const PLUGINS = path.join(HOME, "plugins");

// 照真实数据的量造：52 个技能、正文每个 5～6KB（真的是 297KB / 52 个），一部分带资源文件，一个用大写 SKILL.md
const N_LOCAL = 52;
const body = (i, extra) => `---\nname: s-${String(i).padStart(2, "0")}\ndescription: 第 ${i} 号技能：测缓存用\n---\n\n${extra || "正文"} ${i}\n` + "照着做的规矩。".repeat(800);
for (let i = 0; i < N_LOCAL; i++) {
  const dir = path.join(SKILLS, `s-${String(i).padStart(2, "0")}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, i === 7 ? "SKILL.md" : "skill.md"), body(i));
  if (i % 5 === 0) fs.writeFileSync(path.join(dir, "helper.py"), "print('x')\n");
}
const PLUGIN_SCHEMA_URL = () => require(mod("plugins")).PLUGIN_SCHEMA;
function makePlugin(name, skills) {
  const root = path.join(PLUGINS, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ $schema: PLUGIN_SCHEMA_URL(), name }));
  for (const [s, text] of Object.entries(skills)) {
    fs.mkdirSync(path.join(root, "skills", s), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: 插件带来的 ${s}\n---\n\n${text}\n`);
  }
  return root;
}

const ROOT = path.join(__dirname, "..");
const skills = require(mod("skills"));
const jev = require(mod("jev"));
const tools = require(mod("tools"));
const { createAgentRuntime } = require(mod("agent"));
const { McpManager } = require(mod("mcp"));
const cache = skills._internals.skillsCache;

makePlugin("cache-plugin", { "p-one": "插件技能一号正文", "p-two": "插件技能二号正文" });
const N_ALL = N_LOCAL + 2;

let pass = 0, fail = 0, finished = false;
process.on("exit", (code) => {
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`);
  process.exitCode = 1;
});
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra) : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 数 readFileSync：全部的，和其中读 skill.md 的（大小写都算）
const realRead = fs.readFileSync;
const reads = { all: 0, skill: 0 };
fs.readFileSync = function (p, ...rest) {
  reads.all++;
  if (typeof p === "string" && /[\\/]skill\.md$/i.test(p)) reads.skill++;
  return realRead.call(this, p, ...rest);
};
const count = (fn) => {
  const a = reads.all, s = reads.skill;
  const r = fn();
  return { all: reads.all - a, skill: reads.skill - s, r };
};
const find = (name) => skills.loadSkills().find((s) => s.name === name);

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log("\n① 假引擎连跑 10 轮：第 2～10 轮每轮的 readFileSync 不超过第 1 轮");
  // ─────────────────────────────────────────────────────────────
  const experts = { list: () => [], get: () => null };
  const cfg = {
    agent: { max_steps: 6, tool_timeout_ms: 30000, ask_user_timeout_ms: 30000, skill_gate: true },
    decide: { api_key: "假 Key，这趟根本不发网络" },
  };
  // 开工前那道闸问的判断模型也换成假的：挑 s-03，确定度 0.9（这样闸那条路上的两次 getSkills 都走到）
  const realAsk = jev.askMetered;
  const { PICK_KEY } = require(mod("skill-gate"));
  jev.askMetered = async () => ({ ok: true, answers: [{ key: PICK_KEY, value: "s-03", sure: 0.9 }] });
  ok(jev.status(cfg).ready === true, "（前置）这份假配置在 jev 眼里算配好了，闸那条路真会走到");

  /** 一轮 = 系统提示词 + 开工前的闸（问一次判一次）+ 模型 use_skill 一次 + 收尾，四处 getSkills 都走到 */
  const oneTurn = async (i) => {
    let step = 0;
    const seen = [];
    const llm = {
      provider: "假", model: "假模型",
      chat: async ({ system }) => {
        seen.push(system);
        step++;
        if (step === 1) return { text: "先加载技能。", toolCalls: [{ id: "tc_" + i, name: "use_skill", input: { name: "s-11" } }], stopReason: "tool_use", usage: { prompt: 10, completion: 5 } };
        return { text: "写完了。", toolCalls: [], stopReason: "end_turn", usage: { prompt: 10, completion: 5 } };
      },
    };
    const dir = subdir("ws");
    const rt = createAgentRuntime({ config: cfg, llm, mcpManager: new McpManager(), experts });
    const a = reads.all, s = reads.skill;
    await tools.withWorkspace(dir, () => rt.runTask({
      history: [{ role: "user", content: `第 ${i} 轮：帮我写一段话` }],
      askUser: async () => "随便",
      emit: () => {},
    }));
    const r = { all: reads.all - a, skill: reads.skill - s, seen };
    fs.rmSync(dir, { recursive: true, force: true });
    return r;
  };
  const tenTurns = async () => {
    const out = [];
    for (let i = 1; i <= 10; i++) out.push(await oneTurn(i));
    return out;
  };

  let on, off;
  try {
    on = await tenTurns();
    // 反向对照：同样 10 轮，缓存关掉
    cache.enabled = false;
    off = await tenTurns();
  } finally {
    cache.enabled = true;
    jev.askMetered = realAsk;
  }
  console.log("    缓存开着 每轮 readFileSync（全部 / 其中 skill.md）：" + on.map((t) => `${t.all}/${t.skill}`).join("  "));
  console.log("    缓存关掉 每轮 readFileSync（全部 / 其中 skill.md）：" + off.map((t) => `${t.all}/${t.skill}`).join("  "));
  const s1 = on[0].seen[1] || "";
  ok(/### 技能：s-03/.test(on[0].seen[0] || "") && /### 技能：s-11/.test(s1), "（前置）闸挑的 s-03、模型 use_skill 的 s-11 都真的挂进了系统提示词：这 10 轮真把技能表用上了", [String(on[0].seen[0] || "").slice(0, 80)]);
  ok(on[0].skill >= N_ALL, `第 1 轮整张表读了一遍（${on[0].skill} 次 ≥ ${N_ALL} 个技能）`, on[0].skill);
  ok(on.slice(1).every((t) => t.skill === 0), "★第 2～10 轮一个 skill.md 都没再读★", on.map((t) => t.skill));
  ok(on.slice(1).every((t) => t.all <= on[0].all), "★第 2～10 轮每轮的 readFileSync 都不超过第 1 轮★（验收那一条）", on.map((t) => t.all));
  ok(off.every((t) => t.skill >= 4 * N_ALL), `★反向对照★ 缓存关掉：每轮都把整张表重读至少 4 遍（≥ ${4 * N_ALL} 次）`, off.map((t) => t.skill));
  const cum = off.reduce((acc, t) => (acc.push((acc[acc.length - 1] || 0) + t.skill), acc), []);
  ok(off.every((t) => t.skill === off[0].skill) && cum[9] === 10 * off[0].skill, `★反向对照★ 累计次数跟着轮数线性涨：${cum.join(" → ")}`, cum);
  ok(off.slice(1).some((t) => t.all > on[0].all) || off.slice(1).reduce((n, t) => n + t.all, 0) > on.slice(1).reduce((n, t) => n + t.all, 0) * 3,
    "★反向对照★ 缓存关掉时验收那一条就不成立了（这条判据真能判红）", { off: off.map((t) => t.all), onTurn1: on[0].all });

  // ─────────────────────────────────────────────────────────────
  console.log("\n② 缓存给出去的跟盘上一模一样，而且改不坏缓存");
  // ─────────────────────────────────────────────────────────────
  {
    const hit = skills.loadSkills();
    cache.enabled = false;
    const fresh = skills.loadSkills();
    cache.enabled = true;
    ok(JSON.stringify(hit) === JSON.stringify(fresh) && hit.length === N_ALL, `缓存那份跟现读的逐字段一样（${hit.length} 个，含插件 2 个）`);
    ok(hit.find((s) => s.name === "s-07"), "  └ 大写 SKILL.md 那个也在");
    ok(hit.find((s) => s.name === "s-05").hasAssets && !hit.find((s) => s.name === "s-06").hasAssets, "  └ 带资源的标记没丢");
    hit.length = 3;
    hit[0].content = "被调用方改坏了";
    const again = skills.loadSkills();
    ok(again.length === N_ALL && again[0].content !== "被调用方改坏了", "★调用方截断数组、改对象字段，下一次拿到的还是完整原样★");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n③ 改了就得认");
  // ─────────────────────────────────────────────────────────────
  {
    // 走 saveSkill 编辑：当场生效，不等 1 秒
    skills.loadSkills();
    skills.saveSkill({ name: "s-01", description: "改过的描述", content: "saveSkill 改过的正文" });
    const t0 = performance.now();
    const got = find("s-01");
    ok(got && /saveSkill 改过的正文/.test(got.content) && performance.now() - t0 < 1000, "★走 saveSkill 编辑：下一次 getSkills 当场就是新的★");

    // 绕开写盘路径、就地改写：1 秒窗口内还是旧的——这就是缓存在起作用
    skills.invalidateSkillsCache();
    skills.loadSkills(); // 窗口从这一刻起算
    fs.writeFileSync(path.join(SKILLS, "s-02", "skill.md"), body(2, "手改过的正文"));
    const stale = count(() => find("s-02"));
    ok(stale.r && !/手改过的正文/.test(stale.r.content) && stale.skill === 0, "★反向对照★ 1 秒窗口内绕开写盘路径就地改写：还是旧的、一个文件都没读（缓存真在起作用）");
    skills.invalidateSkillsCache();
    ok(/手改过的正文/.test(find("s-02").content), "  └ 作废一次，马上就是新的");

    // 过了 1 秒，不作废也认：完整签名比出来 skill.md 的 mtime/大小变了
    skills.loadSkills();
    fs.writeFileSync(path.join(SKILLS, "s-04", "skill.md"), body(4, "过了一秒才看的正文"));
    await sleep(1100);
    ok(/过了一秒才看的正文/.test(find("s-04").content), "★就地改写、不作废：过了 1 秒自己就认出来了★");
    // 反向对照：过了 1 秒但什么都没改 → 只 stat 不重读
    skills.loadSkills();
    await sleep(1100);
    const loads0 = cache.stats.loads, checks0 = cache.stats.fullChecks;
    const idle = count(() => skills.loadSkills());
    ok(idle.skill === 0 && cache.stats.loads === loads0 && cache.stats.fullChecks === checks0 + 1, "★反向对照★ 过了 1 秒但盘上没变：比了一遍签名，一个 skill.md 都没读", { skill: idle.skill, loads: cache.stats.loads - loads0 });

    // 直接往盘上新建一个技能目录（e2e 的插件重名那条就是这么造场景的）：窗口内也当场认
    skills.loadSkills();
    fs.mkdirSync(path.join(SKILLS, "fresh-one"));
    fs.writeFileSync(path.join(SKILLS, "fresh-one", "skill.md"), "---\nname: fresh-one\ndescription: 刚放进来的\n---\n\n新目录正文\n");
    ok(find("fresh-one") && /新目录正文/.test(find("fresh-one").content), "★直接新建技能目录：1 秒窗口内当场就认★（目录级签名比出来的）");
    fs.rmSync(path.join(SKILLS, "fresh-one"), { recursive: true, force: true });
    ok(!find("fresh-one"), "★直接删掉技能目录：当场就没了★");

    // 走 deleteSkill
    skills.loadSkills();
    ok(skills.deleteSkill("s-09") === true && !find("s-09"), "★走 deleteSkill：当场就没了★");

    // 走安装（copySkillFolder：从 GitHub 装、默认技能都走这里）
    const src = subdir("src");
    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: installed-one\ndescription: 装进来的\n---\n\n安装正文\n");
    fs.writeFileSync(path.join(src, "tpl.html"), "<p>x</p>\n");
    skills.loadSkills();
    skills._internals.copySkillFolder(src, "installed-one");
    const ins = find("installed-one");
    ok(ins && /安装正文/.test(ins.content) && ins.hasAssets, "★走安装拷进来：当场就认，带的资源也认★");
    // 安装覆盖同名（目录先删再拷）：新版正文
    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: installed-one\ndescription: 装进来的\n---\n\n重装之后的正文\n");
    skills.loadSkills();
    skills._internals.copySkillFolder(src, "installed-one");
    ok(/重装之后的正文/.test(find("installed-one").content), "★重装覆盖：当场就是新版★");
    fs.rmSync(src, { recursive: true, force: true });
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n④ 插件带来的技能、.state.json 也进签名");
  // ─────────────────────────────────────────────────────────────
  {
    skills.loadSkills();
    const root = makePlugin("late-plugin", { "p-late": "后装插件的正文" });
    ok(find("p-late") && find("p-late").plugin === "late-plugin", "★新装一个插件：当场就认★");
    skills.loadSkills();
    fs.writeFileSync(path.join(root, "skills", "p-late", "SKILL.md"), "---\nname: p-late\ndescription: 插件带来的 p-late\n---\n\n插件就地改过的正文\n");
    ok(!/插件就地改过的正文/.test(find("p-late").content), "★反向对照★ 1 秒窗口内就地改插件的 SKILL.md：还是旧的");
    await sleep(1100);
    ok(/插件就地改过的正文/.test(find("p-late").content), "★过了 1 秒：插件就地改的也认出来了★");
    fs.rmSync(root, { recursive: true, force: true });
    ok(!find("p-late"), "★卸掉插件：当场就没了★");

    // .state.json（技能开关表）一出现、一改，技能表就得重算
    skills.loadSkills();
    let l0 = cache.stats.loads;
    skills.loadSkills();
    ok(cache.stats.loads === l0, "（对照）什么都没动：不重读");
    fs.writeFileSync(path.join(SKILLS, ".state.json"), JSON.stringify({ disabled: ["s-10"] }));
    skills.loadSkills();
    ok(cache.stats.loads === l0 + 1, "★.state.json 一出现：重读★");
    l0 = cache.stats.loads;
    fs.writeFileSync(path.join(SKILLS, ".state.json"), JSON.stringify({ disabled: ["s-10", "s-12", "s-13"] }));
    skills.loadSkills();
    ok(cache.stats.loads === l0 + 1, "★.state.json 就地改写：1 秒窗口内也当场重读★");
    ok(!find(".state.json") && skills.loadSkills().every((s) => !s.name.startsWith(".")), "  └ .state.json 本身不会被当成技能");
  }

  fs.readFileSync = realRead;
  console.log(`\n技能表缓存：${pass} 通过，${fail} 失败`);
  finished = true;
  if (fail) process.exitCode = 1;
})().catch((e) => { fs.readFileSync = realRead; console.error(e); process.exitCode = 1; finished = true; });
