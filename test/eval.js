"use strict";
/**
 * 评测闭环：题库和跑批器的离线闸门。
 *
 * 跑一遍真评测要花真钱，所以这套测试一次模型都不调。它只钉三件跟钱无关、
 * 但一旦坏了就会让整套评测变成摆设的事：
 *
 *   ① 负对照——**每道题的 checks 在空目录上必须一条都不过**。
 *      一条在空目录里也能绿的 check 是假闸门：它永远绿，却什么都没在看。
 *      （v2 时代 12 题全过 100% 的教训就在这儿：分数高不代表考卷在考人。）
 *   ② 正对照——新题给一份「标准答案」的产物，checks 必须全过。
 *      判不出对的 check 跟判不出错的一样没用，只是没人会发现。
 *   ③ 记忆题的种子真能种进去，而且**只有这道题看得见**。
 *      种失败要当场炸（不然题目无解，最后算在模型头上）；串到别的题里，
 *      那道题的成绩就不是它自己的了。
 *
 * 另外把基线的覆盖面对一遍：baseline.json 里躺着的题 id 必须还在题库里。
 * 改了 id 忘了改基线，回归评测会在你以为它在看的地方留一个洞。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-eval-"));
// 记忆 / 偏好这些都按 OPENWORKBUDDY_DATA_DIR 算路径，且是模块加载时定死的——
// 必须在 require 之前指到临时目录，绝不碰真记忆
process.env.OPENWORKBUDDY_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });

const { TASKS } = require("../eval/tasks");
const memory = require("../memory");
const run = require("../eval/run"); // require 进来不许开跑，见下面第【6】节
const { turnsOf, stepsFor, timeoutFor, seedMemories } = run._internals;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra != null ? "\n      " + String(extra).replace(/\n/g, "\n      ") : "")); }
}
const ROOT = path.join(__dirname, "..");
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const fresh = (n) => { const d = path.join(TMP, n); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };

// ---- ① 题面形状 ----
console.log("\n【1】每道题该有的都得有");
{
  const ids = TASKS.map((t) => t.id);
  ok(new Set(ids).size === ids.length, "题 id 不重复", ids.join(","));
  const bad = TASKS.filter((t) => !t.id || !t.name || !t.level || !t.kind || typeof t.checks !== "function");
  ok(bad.length === 0, "id / name / level / kind / checks 都齐", bad.map((t) => t.id).join(","));
  const noPrompt = TASKS.filter((t) => !turnsOf(t).join("").trim());
  ok(noPrompt.length === 0, "题面不为空（prompt 或 turns 至少有一个）", noPrompt.map((t) => t.id).join(","));
  const noRubric = TASKS.filter((t) => !Array.isArray(t.rubric) || !t.rubric.length);
  ok(noRubric.length === 0, "都有给 AI 评委的质量维度", noRubric.map((t) => t.id).join(","));
  ok(TASKS.some((t) => t.level === 3), "有 L3 高难题（天花板了要加层，不是改旧题）");
  for (const kind of ["长任务", "多轮", "记忆"]) {
    ok(TASKS.some((t) => t.kind === kind), `题库里有「${kind}」这一类（P2.3 要补的短板）`);
  }
}

// ---- ② 负对照：空目录上一条都不许过 ----
console.log("\n【2】★空目录喂进去，没有一条 check 该亮绿★ 亮了就是假闸门");
{
  for (const task of TASKS) {
    const dir = fresh("empty-" + task.id);
    let checks = [];
    let err = null;
    try { checks = task.checks(dir, ""); } catch (e) { err = e.message; }
    ok(!err, `${task.id}：空目录不该把 checks 跑崩`, err);
    ok(Array.isArray(checks) && checks.length > 0, `${task.id}：checks 返回了非空数组`);
    const green = (checks || []).filter((c) => c.ok).map((c) => c.name);
    ok(green.length === 0, `${task.id}：空目录 0 条通过`, green.join(" / "));
  }
}

// ---- ③ 正对照：新题给标准答案，必须全过 ----
console.log("\n【3】新补的三道题，喂标准答案要全过（判不出对的 check 也是坏 check）");
{
  const byId = (id) => TASKS.find((t) => t.id === id);

  // long-haul：十二张单子的标准答案
  {
    const dir = fresh("good-long-haul");
    const want = [
      ["A1001", "水果", 90], ["A1002", "饮料", 36], ["A1003", "蔬菜", 18.5], ["A1004", "未分类", 144],
      ["A1005", "水果", 22], ["A1006", "饮料", 10.8], ["A1007", "蔬菜", 15], ["A1008", "饮料", 8.8],
      ["A1009", "水果", 36], ["A1010", "蔬菜", 6.5], ["A1011", "未分类", 324], ["A1012", "水果", 27.6],
    ];
    want.forEach(([no, cls, amt], i) => {
      fs.writeFileSync(path.join(dir, "out-" + String(i + 1).padStart(2, "0") + ".json"),
        JSON.stringify({ 单号: no, 分类: cls, 金额_人民币: amt }));
    });
    fs.writeFileSync(path.join(dir, "total.json"), JSON.stringify({ 水果: 175.6, 饮料: 55.6, 蔬菜: 40, 未分类: 468 }));
    const checks = byId("long-haul").checks(dir, "做完了");
    const red = checks.filter((c) => !c.ok);
    ok(red.length === 0, "long-haul 标准答案全过", red.map((c) => c.name + "｜" + c.note).join("\n"));

    // 反向：把一张单子的分类改成「其他」，规范第 4 条那条必须变红
    fs.writeFileSync(path.join(dir, "out-04.json"), JSON.stringify({ 单号: "A1004", 分类: "其他", 金额_人民币: 144 }));
    const c2 = byId("long-haul").checks(dir, "");
    ok(c2.some((c) => /其他/.test(c.name) && !c.ok), "写了「其他」就得红——这条闸门真的在看");
  }

  // multi-turn：三轮跑完该留下的东西
  {
    const dir = fresh("good-multi-turn");
    fs.writeFileSync(path.join(dir, "部门合计.json"), JSON.stringify({ 研发: 6.0, 市场: 4.0, 行政: 2.6 }));
    fs.writeFileSync(path.join(dir, "最高部门.txt"), "研发 6.00 万元\n");
    const checks = byId("multi-turn").checks(dir, "");
    const red = checks.filter((c) => !c.ok);
    ok(red.length === 0, "multi-turn 标准答案全过", red.map((c) => c.name + "｜" + c.note).join("\n"));

    // 反向一：实习生没排除（第二轮的改主意没生效）
    fs.writeFileSync(path.join(dir, "部门合计.json"), JSON.stringify({ 研发: 6.6, 市场: 4.5, 行政: 2.6 }));
    ok(byId("multi-turn").checks(dir, "").some((c) => /实习生/.test(c.name) && !c.ok), "实习生没排除就得红");
    // 反向二：最后一轮丢了第一轮定的万元口径，写回了元
    fs.writeFileSync(path.join(dir, "部门合计.json"), JSON.stringify({ 研发: 6.0, 市场: 4.0, 行政: 2.6 }));
    fs.writeFileSync(path.join(dir, "最高部门.txt"), "研发 60000 元\n");
    ok(byId("multi-turn").checks(dir, "").some((c) => /万元口径/.test(c.name) && !c.ok), "★第三轮写回「元」就得红★ 这是整道题唯一考的东西");
  }

  // memory-recall：三条记忆都照做了的周报
  {
    const dir = fresh("good-memory-recall");
    const good = "# 本周访问量\n\n本周访问量整体走高，从 2026-09-14 的 1200 一路涨到 2026-09-20 的 1760，"
      + "最高的一天是 2026-09-19，2050 次。\n\n—— 海川科技数据组\n";
    fs.writeFileSync(path.join(dir, "周报.md"), good);
    const red = byId("memory-recall").checks(dir, "").filter((c) => !c.ok);
    ok(red.length === 0, "memory-recall 标准答案全过", red.map((c) => c.name + "｜" + c.note).join("\n"));

    // 三条记忆各违反一次，各自那条必须红
    fs.writeFileSync(path.join(dir, "周报.md"), good.replace("本周访问量整体", "📈 本周访问量整体"));
    ok(byId("memory-recall").checks(dir, "").some((c) => /emoji/.test(c.name) && !c.ok), "混进 emoji 就得红");
    fs.writeFileSync(path.join(dir, "周报.md"), good.replace("\n—— 海川科技数据组\n", "\n"));
    ok(byId("memory-recall").checks(dir, "").some((c) => /落款/.test(c.name) && !c.ok), "没落款就得红");
    fs.writeFileSync(path.join(dir, "周报.md"), good.replace(/2026-09-19，2050/, "9月19日，2050").replace("2026-09-19", "9月19日"));
    ok(byId("memory-recall").checks(dir, "").some((c) => /9月19日|日期/.test(c.name) && !c.ok), "日期写成「9月19日」就得红");
  }
}

// ---- ④ 记忆种子：种得进去，而且只有自己看得见 ----
console.log("\n【4】记忆题的种子");
{
  const task = TASKS.find((t) => t.id === "memory-recall");
  const user = seedMemories(task, "memory-recall");
  ok(!!user, "有 memories 的题会拿到自己的作用域", user);
  ok(seedMemories({ id: "x" }, "x") === undefined, "没有 memories 的题不开作用域，照旧不带用户身份跑");

  const mine = memory.list(user).map((x) => x.text);
  ok(task.memories.every((m) => mine.includes(m)), "五条全种进去了", mine.join(" | "));

  // 串味检查：另一个身份不该在自己的提示词里看见这题种的记忆
  ok(memory.list("eval_别的题").length === 0, "★别的题看不见这题的记忆★ 串过去了，那道题的成绩就不是它自己的");

  // 种不进去必须当场炸，不许闷着——闷着的话题目无解，最后算在模型头上
  let threw = "";
  try { seedMemories({ id: "坏题", memories: ["x".repeat(500)] }, "坏题"); } catch (e) { threw = e.message; }
  ok(/坏题/.test(threw) && /记忆种不进去/.test(threw), "种不进去会炸且说清是哪道题", threw);
}

// ---- ⑤ 按题抬上限：只抬不降 ----
console.log("\n【5】按题抬上限");
{
  ok(stepsFor({}, 30) === 30, "没写就用全局的");
  ok(stepsFor({ max_steps: 60 }, 30) === 60, "写了更大的就用大的");
  ok(stepsFor({ max_steps: 5 }, 30) === 30, "★写了更小的不作数★ 不然改一行题面就能悄悄把某道题变简单");
  ok(timeoutFor({ timeout_ms: 720000 }, 360000) === 720000, "时间上限同理，只抬不降");
  ok(timeoutFor({ timeout_ms: 1000 }, 360000) === 360000, "时间上限写小了也不作数");
  const lh = TASKS.find((t) => t.id === "long-haul");
  ok(stepsFor(lh, 30) >= 40, "长任务题的步数上限在 40 步以上（P1 验收题的要求）", stepsFor(lh, 30));
}

// ---- ⑥ 多轮题的形状 ----
console.log("\n【6】多轮题");
{
  ok(turnsOf({ prompt: "一句话" }).length === 1, "单轮题摊平成一条");
  const mt = TASKS.find((t) => t.id === "multi-turn");
  ok(turnsOf(mt).length === 3, "多轮题摊平成三条", turnsOf(mt).length);
  ok(!mt.prompt, "多轮题不该再写 prompt（两处题面会打架）");
  // 第一轮定的规矩，后面几轮一个字都不许重复——重复了就成了照抄题面，考的不是记性
  const later = turnsOf(mt).slice(1).join("");
  ok(!/万元/.test(later), "★后面几轮没再提「万元」★ 提了这道题就白出了");
}

// ---- ⑦ 跑批器的接线（静态看代码，不开跑）----
console.log("\n【7】跑批器接线");
{
  const runSrc = src("eval/run.js");
  ok(/require\.main === module/.test(runSrc), "被 require 进来不开跑（跑一遍要花真钱）");
  ok(/process\.env\.OPENWORKBUDDY_DATA_DIR = path\.join\(RUN_DIR, "data"\)/.test(runSrc),
    "★评测把数据目录指到自己的跑批目录★ 不然题里 agent 顺手 remember 一句就进了用户的真记忆");
  const envAt = runSrc.indexOf('process.env.OPENWORKBUDDY_DATA_DIR = path.join(RUN_DIR');
  const memAt = runSrc.indexOf('require("../memory")');
  ok(envAt > 0 && memAt > envAt, "而且是在 require 记忆模块之前指的（那个常量在加载时就定死了）", `env@${envAt} memory@${memAt}`);
  ok(/maxSteps: stepsFor\(task/.test(runSrc), "按题的步数上限真的传给了 runTask");
  ok(/user: memUser/.test(runSrc), "记忆题的作用域真的传给了 runTask，不然种了也召不回");
  ok(/uncovered/.test(runSrc) && /missing/.test(runSrc), "基线对比会点名「没参照的新题」和「基线里有但没跑的题」");

  const agentSrc = src("agent.js");
  ok(/maxSteps: maxStepsOverride/.test(agentSrc) && /maxStepsOverride \|\| config\.agent\.max_steps/.test(agentSrc),
    "agent.runTask 认按次的步数上限，且不写就退回全局配置");
}

// ---- ⑧ 基线的覆盖面 ----
console.log("\n【8】基线");
{
  const base = JSON.parse(src("eval/baseline.json"));
  const ids = new Set(TASKS.map((t) => t.id));
  const gone = Object.keys(base.tasks || {}).filter((id) => !ids.has(id));
  ok(gone.length === 0, "★基线里的题都还在题库里★ 改了 id 忘了改基线，回归评测就在这儿留洞", gone.join(","));
  ok(base.commit && base.at && base.model, "基线记了是哪个 commit、什么时候、哪个模型跑的");
  const uncovered = [...ids].filter((id) => !(base.tasks || {})[id]);
  console.log(`  · 基线还没覆盖 ${uncovered.length} 题：${uncovered.join(", ") || "无"}（新题跑一次 --save-baseline 才有参照）`);
}

// ---- ⑨ P2.2 的规矩写进 CONTRIBUTING 了没有 ----
console.log("\n【9】「改提示词必跑评测」这条规矩");
{
  const c = src("CONTRIBUTING.md");
  ok(/评测/.test(c) && /npm run eval/.test(c), "CONTRIBUTING 里写了怎么跑评测");
  ok(/提示词|工具描述/.test(c), "写清了改哪些东西算触发条件");
  ok(/baseline/.test(c), "写了基线怎么钉");
  const m = src("docs/评测方法论.md");
  // 光搜「多轮」会被开头那句「连续多轮全过」蹭绿，得钉到标题和题形表上
  ok(/##\s*七、/.test(m) && ["长任务", "多轮", "记忆"].every((k) => new RegExp("\\|\\s*" + k + "\\s*\\|").test(m)), "方法论文档列全了四种题形");
  ok(/##\s*八、/.test(m) && /空目录/.test(m) && /test\/eval\.js/.test(m), "方法论文档写了负对照这条闸门");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
