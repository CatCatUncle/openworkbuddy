"use strict";
/**
 * 评测跑批 v3 — 用真实模型把 TASKS 全量跑一遍，机器判分 + 稳定性 + 回归对比。
 * 用法：
 *   npm run eval                          # 全量，用 config.json 的全局默认模型
 *   npm run eval -- --model DeepSeek      # 指定模型条目（可对比不同渠道）
 *   npm run eval -- --task js-func        # 只跑单个任务（逗号分隔跑多个）
 *   npm run eval -- --repeat 3            # 每题跑 3 次：pass@1 均值 + pass^k（每次都过才算稳）
 *   npm run eval -- --concurrency 3       # 并发数（默认 2）
 *   npm run eval -- --judge Kimi          # AI 评委：逐维度二元判定（每个质量问题只答 是/否）
 *   npm run eval -- --save-baseline       # 跑完把本次结果钉成基线（eval/baseline.json）
 * 产物：eval/runs/<时间戳>/ 下有每个任务（×每次尝试）的工作目录 + results.json；仓库不追踪。
 * 三条线分开记：机器判分（硬对错）· 稳定性（k 次重复）· AI 评委（质量维度，只判首轮）。
 * 每个失败的尝试都有确定性失败码，聚合后能直接看出「败在哪一类」。
 * 方法论依据见 docs/评测方法论.md。
 */

const fs = require("fs");
const path = require("path");
const { dataPath, preferData } = require("../paths");
const { spawnSync } = require("child_process");
const { createLLM } = require("../llm");
const { createAgentRuntime, mapPool } = require("../agent");
const { McpManager } = require("../mcp");
const { setWorkspaceDir } = require("../tools");
const store = require("../store");
const { TASKS } = require("./tasks");

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const hasFlag = (k) => argv.includes("--" + k);
const TASK_TIMEOUT = (+argOf("timeout", 0) || 360) * 1000; // 每题上限，默认 6 分钟
const CONCURRENCY = Math.max(1, +argOf("concurrency", 2) || 2);
const REPEAT = Math.max(1, Math.min(5, Math.round(+argOf("repeat", 1)) || 1));
const BASELINE_PATH = dataPath("eval", "baseline.json");

// ---------- 失败码：每个失败的尝试归成唯一一类，按「越硬的死因越优先」裁定 ----------
const FAIL_CODE_LABELS = {
  crash: "崩溃",
  timeout: "超时被收尾",
  max_steps: "步数用尽",
  loop_suspect: "疑似死循环",
  tool_error_storm: "工具连环报错",
  missing_artifact: "没交产物",
  wrong_output: "产物内容不对",
};

function failCode(att) {
  if (att.passed === att.total) return null;
  if (att.crashed) return "crash";
  const stop = att.stopped || "";
  if (/运行时间|响应超时/.test(stop)) return "timeout";
  if (/步数/.test(stop)) return "max_steps";
  if (att.loop_streak >= 3) return "loop_suspect";
  if (att.tool_errors >= 5) return "tool_error_storm";
  const firstFail = (att.checks || []).find((c) => !c.ok);
  if (firstFail && /存在|可解析/.test(firstFail.name)) return "missing_artifact";
  return "wrong_output";
}

// ---------- AI 评委 v2（逐维度二元判定）----------
// 打 1-5 分会漂移（评委各有各的 3 分），且长回复容易骗高分。改成逐条质量问题只答 true/false，
// 分数 = 达标维度占比，可复现、可对比。机器判分负责硬对错，评委只管机器测不了的「质量」。
const JUDGE_SYSTEM = `你是严格的 AI 智能体评测评委。机器已经判过硬性对错，你只负责逐条回答「质量维度问题」——每个问题只准回答 true（达标）或 false（不达标），不打分数。
判定纪律：
- 拿证据说话：过程记录和产物摘录里找得到依据才算 true；证据不足一律 false。
- 别被篇幅迷惑：回复写得长不等于写得好，只看是否达标。
- 机器判分只是背景信息，你只回答质量维度问题本身。
只输出一个 JSON 对象，不要输出任何其它文字。`;

function gitCommit() {
  try {
    const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 5000 });
    return r.status === 0 ? String(r.stdout).trim() : "";
  } catch { return ""; }
}

function artifactExcerpts(dir, res) {
  const parts = [];
  for (const a of (res.artifacts || []).slice(0, 4)) {
    if (!/\.(md|txt|html|js|mjs|cjs|py|json|csv|svg|log)$/i.test(a.name)) { parts.push(`【${a.name}】二进制/未摘录（${a.size} 字节）`); continue; }
    let t = "";
    try { t = fs.readFileSync(path.join(dir, a.name), "utf8").slice(0, 1500); } catch {}
    parts.push(`【产物 ${a.name}（${a.size} 字节，摘录开头）】\n${t}`);
  }
  return parts.join("\n\n");
}

async function judgeOne(judgeLLM, task, res, dir) {
  const dims = Array.isArray(task.rubric) ? task.rubric : [String(task.rubric || "整体完成质量是否达标（正确、干净、无糊弄）")];
  const checksText = res.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}${c.note ? "（" + c.note + "）" : ""}`).join("\n");
  const user = `# 题目
${task.prompt}

# 质量维度问题（逐条判定 true/false）
${dims.map((q, i) => `${i}. ${q}`).join("\n")}

# 机器判分（硬校验，背景信息）
${checksText}

# 过程指标
用时 ${res.elapsed_s}s · ${res.tool_calls} 次工具调用（失败 ${res.tool_errors || 0} 次）· ${res.tokens.prompt + res.tokens.completion} tokens${res.stopped ? " · 强制收尾：" + res.stopped : ""}${res.crashed ? " · 崩溃：" + res.crashed : ""}

# 智能体最终回复
${(res.final_text || "（无）").slice(0, 3000)}

# 产物文件摘录
${artifactExcerpts(dir, res) || "（无产物文件）"}

只输出一个 JSON 对象，必须覆盖上面每一个编号：
{"dims": [{"i": 0, "pass": true或false, "note": "一句话依据"}, ...]}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await judgeLLM.chat({ system: JUDGE_SYSTEM, history: [{ role: "user", content: user }], tools: [], signal: AbortSignal.timeout(120000) });
      const m = String(r.text || "").match(/\{[\s\S]*\}/);
      if (!m) continue;
      const j = JSON.parse(m[0]);
      if (!Array.isArray(j.dims)) continue;
      const byIdx = new Map(j.dims.map((d) => [Math.round(+d.i), d]));
      const out = dims.map((q, i) => {
        const d = byIdx.get(i);
        return { q, pass: !!(d && d.pass === true), note: String((d && d.note) || (d ? "" : "评委未作答")).slice(0, 200) };
      });
      const passed = out.filter((d) => d.pass).length;
      return { dims: out, passed, total: out.length };
    } catch (e) { if (attempt) return { error: String(e.message).slice(0, 200) }; }
  }
  return { error: "评委输出无法解析（两次都没拿到合法 JSON）" };
}

async function main() {
  const config = store.readJson(dataPath("config.json"), null);
  if (!config) { console.error("没有 config.json，先在应用里配好模型"); process.exit(1); }
  const modelName = argOf("model", config.active_model);
  const entry = (config.models || []).find((m) => m.name === modelName);
  if (!entry) { console.error(`模型「${modelName}」不在 config.models 里`); process.exit(1); }

  // 评测专用 agent 参数：步数/时长收紧，跑不完就是跑不完，如实记账
  const evalConfig = {
    ...config,
    agent: { ...config.agent, max_steps: 30, max_runtime_ms: TASK_TIMEOUT, tool_timeout_ms: 60000, llm_timeout_ms: 180000 },
  };
  const llm = createLLM({ ...evalConfig, active_model: modelName });

  // 本地时间做目录名（toISOString 是 UTC，翻记录时对不上表）
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const runDir = dataPath("eval", "runs", stamp);
  const wsDir = path.join(runDir, "workspace");
  fs.mkdirSync(wsDir, { recursive: true });
  setWorkspaceDir(wsDir);

  const expertsMeta = store.readJson(preferData("experts.json"), {}) || {};
  const runtime = createAgentRuntime({
    config: evalConfig, llm, mcpManager: new McpManager(),
    experts: expertsMeta.experts || [], expertTeams: expertsMeta.teams || [],
  });

  const only = argOf("task", "");
  const tasks = only ? TASKS.filter((t) => only.split(",").includes(t.id)) : TASKS;
  if (!tasks.length) { console.error("没匹配到任务，可选：" + TASKS.map((t) => t.id).join(", ")); process.exit(1); }
  console.log(`评测开始：${tasks.length} 题 × ${REPEAT} 次 · 模型 ${modelName}（${entry.model}）· 并发 ${CONCURRENCY} · 每题上限 ${TASK_TIMEOUT / 60000} 分钟`);
  console.log(`工作目录：${runDir}\n`);

  // 每题跑 REPEAT 次，每次独立目录（首轮就叫 task.id，兼容评委/人工打分的取证路径）
  const items = [];
  for (const task of tasks) for (let n = 1; n <= REPEAT; n++) items.push({ task, n });

  const attemptResults = await mapPool(items, CONCURRENCY, async ({ task, n }) => {
    const dirName = n === 1 ? task.id : `${task.id}__r${n}`;
    const dir = path.join(wsDir, dirName);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(task.inputs || {})) fs.writeFileSync(path.join(dir, name), content);
    if (task.prepare) task.prepare(dir);

    const log = []; // 只留诊断有用的事件（错误/重试/强制收尾），不存全量流水
    let toolCalls = 0;
    let toolErrors = 0;
    // 死循环嗅探：同一个工具带同样的参数连续调 ≥3 次
    let lastSig = "";
    let streak = 0;
    let loopStreak = 0;
    const t0 = Date.now();
    let r = null, crashed = null;
    try {
      r = await runtime.runTask({
        taskLabel: `评测·${dirName}`,
        baseDir: dirName,
        history: [{ role: "user", content: task.prompt }],
        mode: "craft",
        deadline: t0 + TASK_TIMEOUT,
        emit: (ev) => {
          if (ev.type === "tool_use") {
            toolCalls++;
            const sig = ev.name + "|" + (ev.input_preview || "");
            streak = sig === lastSig ? streak + 1 : 1;
            lastSig = sig;
            if (streak > loopStreak) loopStreak = streak;
          }
          if (ev.type === "tool_result" && ev.isError) toolErrors++;
          if (["error", "status", "limit"].includes(ev.type)) log.push({ type: ev.type, text: (ev.message || ev.text || ev.note || "").slice(0, 200) });
        },
      });
    } catch (e) {
      crashed = e.message;
      log.push({ type: "crash", text: String(e.message).slice(0, 200) });
    }
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const checks = task.checks(dir, r ? r.finalText : "");
    const passed = checks.filter((c) => c.ok).length;
    const usage = (r && r.usage) || { prompt: 0, completion: 0, calls: 0 };
    // 产物清单（排除题目预置的输入文件）：给 AI 评委和人工打分看的证据
    const inputNames = new Set(Object.keys(task.inputs || {}));
    const artifacts = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        if (inputNames.has(f)) continue;
        const st = fs.statSync(path.join(dir, f));
        if (st.isFile()) artifacts.push({ name: f, size: st.size });
      }
    } catch {}
    const att = {
      taskId: task.id, n, dir: dirName, passed, total: checks.length, checks,
      elapsed_s: elapsed, tool_calls: toolCalls, tool_errors: toolErrors, loop_streak: loopStreak,
      tokens: { prompt: usage.prompt, completion: usage.completion, calls: usage.calls },
      stopped: (r && r.stopped) || null, crashed, log,
      final_text: ((r && r.finalText) || "").slice(0, n === 1 ? 6000 : 1500), artifacts,
    };
    att.fail_code = failCode(att);
    const tag = REPEAT > 1 ? `[r${n}] ` : "";
    const line = `${passed === checks.length ? "✅" : passed ? "🟡" : "❌"} ${tag}${task.id} ${passed}/${checks.length} · ${elapsed}s · ${toolCalls} 步 · ${usage.prompt + usage.completion} tokens${att.fail_code ? " · 败因:" + FAIL_CODE_LABELS[att.fail_code] : ""}`;
    console.log(line);
    for (const c of checks.filter((x) => !x.ok)) console.log(`   ✗ ${c.name}${c.note ? " — " + c.note : ""}`);
    return att;
  });

  // 按题聚合：pass_rate（能不能）+ 是否 k 次全过（稳不稳）
  const results = tasks.map((task) => {
    const atts = attemptResults.filter((a) => a.taskId === task.id).sort((x, y) => x.n - y.n);
    const passes = atts.filter((a) => a.passed === a.total).length;
    const first = atts[0];
    return {
      id: task.id, name: task.name, level: task.level || 1, kind: task.kind || "综合",
      k: atts.length, passes, pass_rate: +(passes / atts.length).toFixed(3),
      flaky: passes > 0 && passes < atts.length,
      fail_codes: [...new Set(atts.map((a) => a.fail_code).filter(Boolean))],
      attempts: atts.map(({ taskId, ...rest }) => rest),
      // 首轮拍平在顶层：评委取证、人工打分、旧版读取方都盯这几个字段
      passed: first.passed, total: first.total, checks: first.checks,
      elapsed_s: first.elapsed_s, tool_calls: first.tool_calls, tool_errors: first.tool_errors,
      tokens: first.tokens, stopped: first.stopped, crashed: first.crashed,
      final_text: first.final_text, artifacts: first.artifacts,
    };
  });

  // AI 评委环节（可选）：只判每题首轮（省成本且样本无偏），逐维度二元判定
  const judgeName = argOf("judge", "");
  let judgeMeta = null;
  if (judgeName) {
    const judgeEntry = (config.models || []).find((m) => m.name === judgeName);
    if (!judgeEntry) {
      console.error(`AI 评委模型「${judgeName}」不在 config.models 里，跳过评委环节`);
    } else {
      console.log(`\n⚖️ AI 评委开始：${judgeName}（${judgeEntry.model}）逐题逐维度判定…`);
      const judgeLLM = createLLM({ ...config, active_model: judgeName });
      await mapPool(results, CONCURRENCY, async (res) => {
        const task = tasks.find((t) => t.id === res.id);
        res.judge = await judgeOne(judgeLLM, task, res, path.join(wsDir, res.id));
        console.log(res.judge && res.judge.dims ? `   ⚖️ ${res.id} → ${res.judge.passed}/${res.judge.total} 维达标${res.judge.dims.filter((d) => !d.pass).map((d) => ` · ✗${d.q.slice(0, 20)}`).join("")}` : `   ⚖️ ${res.id} → 失败：${(res.judge && res.judge.error) || "?"}`);
      });
      const scored = results.filter((r) => r.judge && r.judge.dims);
      judgeMeta = {
        model: judgeName, model_id: judgeEntry.model, mode: "binary", scored: scored.length,
        avg_pct: scored.length ? Math.round((scored.reduce((s, r) => s + r.judge.passed / r.judge.total, 0) / scored.length) * 100) : null,
      };
    }
  }

  // 汇总（检查项口径覆盖所有尝试；pass@1 均值 = 各题通过率的平均）
  const allAtts = attemptResults;
  const score = allAtts.reduce((s, a) => s + a.passed, 0);
  const totalChecks = allAtts.reduce((s, a) => s + a.total, 0);
  const passkCount = results.filter((r) => r.passes === r.k).length;
  const pass1Avg = Math.round((results.reduce((s, r) => s + r.pass_rate, 0) / results.length) * 100);
  const flakyTasks = results.filter((r) => r.flaky).map((r) => r.id);
  const failCodeCounts = {};
  for (const a of allAtts) if (a.fail_code) failCodeCounts[a.fail_code] = (failCodeCounts[a.fail_code] || 0) + 1;
  const tokens = allAtts.reduce((s, a) => s + a.tokens.prompt + a.tokens.completion, 0);
  // 每次模型调用平均背多少 prompt tokens：系统提示+工具清单的固定开销都在这里，涨了要警惕
  const calls = allAtts.reduce((s, a) => s + (a.tokens.calls || 0), 0);
  const avgPrompt = calls ? Math.round(allAtts.reduce((s, a) => s + a.tokens.prompt, 0) / calls) : 0;

  // 基线对比：eval/baseline.json 里钉着某一次跑批的各题通过率，逐题算 Δ，退步的点名
  let baselineCmp = null;
  const base = store.readJson(BASELINE_PATH, null);
  if (base && base.tasks) {
    const deltas = {}, regressions = [], improvements = [];
    for (const r of results) {
      const b = base.tasks[r.id];
      if (!b) continue;
      const dlt = +(r.pass_rate - b.pass_rate).toFixed(3);
      deltas[r.id] = dlt;
      if (dlt < 0) regressions.push(r.id);
      else if (dlt > 0) improvements.push(r.id);
    }
    baselineCmp = { commit: base.commit || "", at: base.at || "", model: base.model || "", deltas, regressions, improvements };
  }

  const summary = {
    at: new Date().toISOString(), model: modelName, model_id: entry.model, repeat: REPEAT,
    tasks: results.length, full_pass: passkCount, pass1_avg: pass1Avg,
    flaky_tasks: flakyTasks, fail_code_counts: failCodeCounts,
    checks_passed: score, checks_total: totalChecks,
    score_pct: Math.round((score / totalChecks) * 100), tokens_total: tokens, avg_prompt_per_call: avgPrompt,
    commit: gitCommit(), judge: judgeMeta, human: null, baseline: baselineCmp, results,
  };
  fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify(summary, null, 2));

  if (hasFlag("save-baseline")) {
    if (only) console.log("⚠️ 本次只跑了部分任务，基线也只覆盖这些题");
    const bl = {
      at: summary.at, commit: summary.commit, model: modelName, repeat: REPEAT,
      pass1_avg: pass1Avg, score_pct: summary.score_pct,
      tasks: Object.fromEntries(results.map((r) => [r.id, { pass_rate: r.pass_rate }])),
    };
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(bl, null, 2));
    console.log(`📌 已把本次结果钉为基线：${BASELINE_PATH}`);
  }

  console.log(`\n====== pass@1 均值 ${pass1Avg}% · 稳定全过 ${passkCount}/${results.length}${REPEAT > 1 ? `（每题 ${REPEAT} 次）` : ""} · 检查项 ${score}/${totalChecks}${flakyTasks.length ? " · ⚡不稳定：" + flakyTasks.join(",") : ""}${judgeMeta && judgeMeta.avg_pct != null ? ` · 评委质量 ${judgeMeta.avg_pct}%` : ""} · 共 ${tokens} tokens · 平均每步背 ${avgPrompt} prompt tokens ======`);
  if (Object.keys(failCodeCounts).length) console.log(`败因分布：${Object.entries(failCodeCounts).map(([c, n]) => `${FAIL_CODE_LABELS[c] || c}×${n}`).join(" · ")}`);
  if (baselineCmp && baselineCmp.regressions.length) console.log(`🔻 相比基线（${baselineCmp.commit}）退步：${baselineCmp.regressions.join(", ")}`);
  else if (baselineCmp) console.log(`对比基线（${baselineCmp.commit}）：无退步${baselineCmp.improvements.length ? "，进步 " + baselineCmp.improvements.join(", ") : ""}`);
  console.log(`明细：${path.join(runDir, "results.json")}`);
  process.exit(passkCount === results.length ? 0 : 1);
}

main().catch((e) => { console.error("评测崩溃:", e); process.exit(2); });
