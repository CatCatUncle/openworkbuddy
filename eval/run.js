"use strict";
/**
 * 评测跑批 — 用真实模型把 TASKS 全量跑一遍，机器判分出分数卡。
 * 用法：
 *   npm run eval                     # 全量，用 config.json 的全局默认模型
 *   npm run eval -- --model DeepSeek # 指定模型条目（可对比不同渠道）
 *   npm run eval -- --task js-func   # 只跑单个任务（逗号分隔跑多个）
 *   npm run eval -- --concurrency 3  # 并发数（默认 2）
 * 产物：eval/runs/<时间戳>/ 下有每个任务的工作目录 + results.json；仓库不追踪。
 * 判分是确定性的（见 tasks.js），同一套题跑不同模型/不同版本可直接对比总分。
 */

const fs = require("fs");
const path = require("path");
const { createLLM } = require("../llm");
const { createAgentRuntime, mapPool } = require("../agent");
const { McpManager } = require("../mcp");
const { setWorkspaceDir } = require("../tools");
const store = require("../store");
const { TASKS } = require("./tasks");

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const TASK_TIMEOUT = (+argOf("timeout", 0) || 360) * 1000; // 每题上限，默认 6 分钟
const CONCURRENCY = Math.max(1, +argOf("concurrency", 2) || 2);

async function main() {
  const config = store.readJson(path.join(__dirname, "..", "config.json"), null);
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
  const runDir = path.join(__dirname, "runs", stamp);
  const wsDir = path.join(runDir, "workspace");
  fs.mkdirSync(wsDir, { recursive: true });
  setWorkspaceDir(wsDir);

  const expertsMeta = store.readJson(path.join(__dirname, "..", "experts.json"), {}) || {};
  const runtime = createAgentRuntime({
    config: evalConfig, llm, mcpManager: new McpManager(),
    experts: expertsMeta.experts || [], expertTeams: expertsMeta.teams || [],
  });

  const only = argOf("task", "");
  const tasks = only ? TASKS.filter((t) => only.split(",").includes(t.id)) : TASKS;
  if (!tasks.length) { console.error("没匹配到任务，可选：" + TASKS.map((t) => t.id).join(", ")); process.exit(1); }
  console.log(`评测开始：${tasks.length} 题 · 模型 ${modelName}（${entry.model}）· 并发 ${CONCURRENCY} · 每题上限 ${TASK_TIMEOUT / 60000} 分钟`);
  console.log(`工作目录：${runDir}\n`);

  const results = await mapPool(tasks, CONCURRENCY, async (task) => {
    const dir = path.join(wsDir, task.id);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(task.inputs || {})) fs.writeFileSync(path.join(dir, name), content);
    if (task.prepare) task.prepare(dir);

    const log = []; // 只留诊断有用的事件（错误/重试/强制收尾），不存全量流水
    let toolCalls = 0;
    const t0 = Date.now();
    let r = null, crashed = null;
    try {
      r = await runtime.runTask({
        taskLabel: `评测·${task.id}`,
        baseDir: task.id,
        history: [{ role: "user", content: task.prompt }],
        mode: "craft",
        deadline: t0 + TASK_TIMEOUT,
        emit: (ev) => {
          if (ev.type === "tool_use") toolCalls++;
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
    const line = `${passed === checks.length ? "✅" : passed ? "🟡" : "❌"} ${task.id} ${passed}/${checks.length} · ${elapsed}s · ${toolCalls} 步 · ${usage.prompt + usage.completion} tokens${crashed ? " · 崩溃:" + crashed.slice(0, 60) : r && r.stopped ? " · 收尾:" + r.stopped.slice(0, 40) : ""}`;
    console.log(line);
    for (const c of checks.filter((x) => !x.ok)) console.log(`   ✗ ${c.name}${c.note ? " — " + c.note : ""}`);
    return {
      id: task.id, name: task.name, passed, total: checks.length, checks,
      elapsed_s: elapsed, tool_calls: toolCalls,
      tokens: { prompt: usage.prompt, completion: usage.completion, calls: usage.calls },
      stopped: (r && r.stopped) || null, crashed, log,
    };
  });

  const score = results.reduce((s, r) => s + r.passed, 0);
  const totalChecks = results.reduce((s, r) => s + r.total, 0);
  const fullPass = results.filter((r) => r.passed === r.total).length;
  const tokens = results.reduce((s, r) => s + r.tokens.prompt + r.tokens.completion, 0);
  // 每次模型调用平均背多少 prompt tokens：系统提示+工具清单的固定开销都在这里，涨了要警惕
  const calls = results.reduce((s, r) => s + (r.tokens.calls || 0), 0);
  const avgPrompt = calls ? Math.round(results.reduce((s, r) => s + r.tokens.prompt, 0) / calls) : 0;
  const summary = {
    at: new Date().toISOString(), model: modelName, model_id: entry.model,
    tasks: results.length, full_pass: fullPass, checks_passed: score, checks_total: totalChecks,
    score_pct: Math.round((score / totalChecks) * 100), tokens_total: tokens, avg_prompt_per_call: avgPrompt, results,
  };
  fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify(summary, null, 2));

  console.log(`\n====== 总分 ${summary.score_pct}%（检查项 ${score}/${totalChecks}，整题全过 ${fullPass}/${results.length}）· 共 ${tokens} tokens · 平均每步背 ${avgPrompt} prompt tokens ======`);
  console.log(`明细：${path.join(runDir, "results.json")}`);
  process.exit(fullPass === results.length ? 0 : 1);
}

main().catch((e) => { console.error("评测崩溃:", e); process.exit(2); });
