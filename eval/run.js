"use strict";
/**
 * 评测跑批 — 用真实模型把 TASKS 全量跑一遍，机器判分出分数卡。
 * 用法：
 *   npm run eval                     # 全量，用 config.json 的全局默认模型
 *   npm run eval -- --model DeepSeek # 指定模型条目（可对比不同渠道）
 *   npm run eval -- --task js-func   # 只跑单个任务（逗号分隔跑多个）
 *   npm run eval -- --concurrency 3  # 并发数（默认 2）
 *   npm run eval -- --judge Kimi      # 机器判分之后，再让指定模型当 AI 评委逐题打 1-5 质量分
 * 产物：eval/runs/<时间戳>/ 下有每个任务的工作目录 + results.json；仓库不追踪。
 * 判分是确定性的（见 tasks.js），同一套题跑不同模型/不同版本可直接对比总分。
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
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


// ---------- AI 评委（LLM-as-judge）----------
// 机器判分只认硬证据（对/错），评委补「质量」维度：写得好不好、过程干不干净。两条线分开记，谁也不污染谁。
const JUDGE_SYSTEM = `你是严格的 AI 智能体评测评委。根据题目、评分标准、机器判分结果、过程指标和产物摘录，给这道题的完成质量打 1-5 的整数分：
5=完美达成且交付质量高；4=达成但有小瑕疵；3=基本达成但有明显缺陷；2=只完成一部分；1=几乎没完成或答非所问。
机器判分是硬证据，必须尊重：机器全过通常落在 3-5（再看质量分档），机器挂了核心项通常落在 1-3。
过程也计入：步数异常多、工具大量报错、被强制收尾，都要酌情扣分。
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
  const checksText = res.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}${c.note ? "（" + c.note + "）" : ""}`).join("\n");
  const user = `# 题目
${task.prompt}

# 评分标准（rubric）
${task.rubric || "按题目要求的完成度、正确性、交付质量综合判断。"}

# 机器判分（硬校验，已确认）
${checksText}

# 过程指标
用时 ${res.elapsed_s}s · ${res.tool_calls} 次工具调用（失败 ${res.tool_errors || 0} 次）· ${res.tokens.prompt + res.tokens.completion} tokens${res.stopped ? " · 强制收尾：" + res.stopped : ""}${res.crashed ? " · 崩溃：" + res.crashed : ""}

# 智能体最终回复
${(res.final_text || "（无）").slice(0, 3000)}

# 产物文件摘录
${artifactExcerpts(dir, res) || "（无产物文件）"}

只输出一个 JSON 对象：{"score": 1到5的整数, "verdict": "一句话结论", "reasons": ["理由"], "deductions": ["扣分点，可为空数组"]}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await judgeLLM.chat({ system: JUDGE_SYSTEM, history: [{ role: "user", content: user }], tools: [], signal: AbortSignal.timeout(120000) });
      const m = String(r.text || "").match(/\{[\s\S]*\}/);
      if (!m) continue;
      const j = JSON.parse(m[0]);
      const score = Math.max(1, Math.min(5, Math.round(+j.score)));
      if (!Number.isFinite(score)) continue;
      const arr = (x) => (Array.isArray(x) ? x : []).map((v) => String(v).slice(0, 300)).slice(0, 5);
      return { score, verdict: String(j.verdict || "").slice(0, 200), reasons: arr(j.reasons), deductions: arr(j.deductions) };
    } catch (e) { if (attempt) return { error: String(e.message).slice(0, 200) }; }
  }
  return { error: "评委输出无法解析（两次都没拿到合法 JSON）" };
}

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
    let toolErrors = 0;
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
    const line = `${passed === checks.length ? "✅" : passed ? "🟡" : "❌"} ${task.id} ${passed}/${checks.length} · ${elapsed}s · ${toolCalls} 步 · ${usage.prompt + usage.completion} tokens${crashed ? " · 崩溃:" + crashed.slice(0, 60) : r && r.stopped ? " · 收尾:" + r.stopped.slice(0, 40) : ""}`;
    console.log(line);
    for (const c of checks.filter((x) => !x.ok)) console.log(`   ✗ ${c.name}${c.note ? " — " + c.note : ""}`);
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
    return {
      id: task.id, name: task.name, passed, total: checks.length, checks,
      elapsed_s: elapsed, tool_calls: toolCalls, tool_errors: toolErrors,
      tokens: { prompt: usage.prompt, completion: usage.completion, calls: usage.calls },
      stopped: (r && r.stopped) || null, crashed, log,
      final_text: ((r && r.finalText) || "").slice(0, 6000), artifacts,
    };
  });

  // AI 评委环节（可选）：--judge 指定另一个模型逐题打质量分
  const judgeName = argOf("judge", "");
  let judgeMeta = null;
  if (judgeName) {
    const judgeEntry = (config.models || []).find((m) => m.name === judgeName);
    if (!judgeEntry) {
      console.error(`AI 评委模型「${judgeName}」不在 config.models 里，跳过评委环节`);
    } else {
      console.log(`\n⚖️ AI 评委开始：${judgeName}（${judgeEntry.model}）逐题打分…`);
      const judgeLLM = createLLM({ ...config, active_model: judgeName });
      await mapPool(results, CONCURRENCY, async (res) => {
        const task = tasks.find((t) => t.id === res.id);
        res.judge = await judgeOne(judgeLLM, task, res, path.join(wsDir, res.id));
        console.log(res.judge && res.judge.score ? `   ⚖️ ${res.id} → ${res.judge.score}/5 ${res.judge.verdict || ""}` : `   ⚖️ ${res.id} → 失败：${(res.judge && res.judge.error) || "?"}`);
      });
      const scored = results.filter((r) => r.judge && r.judge.score);
      judgeMeta = {
        model: judgeName, model_id: judgeEntry.model, scored: scored.length,
        avg: scored.length ? +(scored.reduce((s, r) => s + r.judge.score, 0) / scored.length).toFixed(2) : null,
      };
    }
  }

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
    score_pct: Math.round((score / totalChecks) * 100), tokens_total: tokens, avg_prompt_per_call: avgPrompt,
    commit: gitCommit(), judge: judgeMeta, human: null, results,
  };
  fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify(summary, null, 2));

  console.log(`\n====== 总分 ${summary.score_pct}%（检查项 ${score}/${totalChecks}，整题全过 ${fullPass}/${results.length}）· 共 ${tokens} tokens · 平均每步背 ${avgPrompt} prompt tokens${judgeMeta && judgeMeta.avg != null ? ` · AI 评委均分 ${judgeMeta.avg}/5` : ""} ======`);
  console.log(`明细：${path.join(runDir, "results.json")}`);
  process.exit(fullPass === results.length ? 0 : 1);
}

main().catch((e) => { console.error("评测崩溃:", e); process.exit(2); });
