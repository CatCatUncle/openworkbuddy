// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 拿已经跑完的一轮重新过一遍 AI 评委，智能体不重跑。
 *   node eval/rejudge.js --dir 2026-10-05-101500 --judge Kimi
 *
 * 用途是调评委（rejudge rehearsal loop）：改了判定纪律（评测页 →「评委提示词」），拿同一批产物重判，
 * 对着人工标注看一致率是涨了还是跌了。只花评委那点钱，产物和机器判分一个字不动。
 * 上一版评委的结论留在 judge_prev 里（只留最近 5 版），人工分和标注原样保留。
 */
const fs = require("fs");
const path = require("path");
const { dataPath } = require("../paths");
const { createLLM } = require("../llm");
const { mapPool } = require("../agent");
const store = require("../store");
const { TASKS } = require("./tasks");
const judgeLib = require("./judge");

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const turnsOf = (task) => (Array.isArray(task.turns) && task.turns.length ? task.turns.map(String) : [String(task.prompt || "")]);

async function main() {
  const dir = argOf("dir", "");
  const judgeName = argOf("judge", "");
  if (!/^[\w.-]+$/.test(dir)) { console.error("用法：node eval/rejudge.js --dir <跑批目录名> --judge <模型名>"); process.exit(1); }
  const config = store.readJson(dataPath("config.json"), null);
  if (!config) { console.error("没有 config.json，先在应用里配好模型"); process.exit(1); }
  const judgeEntry = (config.models || []).find((m) => m.name === judgeName);
  if (!judgeEntry) { console.error(`评委模型「${judgeName}」不在 config.models 里`); process.exit(1); }
  const runDir = dataPath("eval", "runs", dir);
  const file = path.join(runDir, "results.json");
  const j = store.readJson(file, null);
  if (!j) { console.error("没有这次评测的记录：" + dir); process.exit(1); }

  const jp = judgeLib.loadJudgeSystem();
  const candidate = (config.models || []).find((m) => m.name === j.model);
  const selfJudge = !!candidate && candidate.model === judgeEntry.model;
  console.log(`◆ 重判 ${dir}（被测 ${j.model}）· 评委 ${judgeName}（${judgeEntry.model}）· 判定纪律 ${jp.custom ? "自定义" : "默认"}版 ${jp.hash}`);
  if (selfJudge) console.log("   ▲ 评委和被测是同一个模型：已知会偏袒自己的输出");
  if (!(j.results || []).some((r) => Array.isArray(r.trace))) console.log("   · 这轮是旧格式，没记过程：评委只能凭回复和产物判，问到过程的维度会标「拿不准」");

  const judgeLLM = createLLM({ ...config, active_model: judgeName });
  const wsDir = path.join(runDir, "workspace");
  const results = j.results || [];
  await mapPool(results, 2, async (res) => {
    const task = TASKS.find((t) => t.id === res.id);
    if (!task) { console.log(`   · ${res.id} 题库里已经没有这题，跳过`); return; }
    res.judge = await judgeLib.judgeOne(judgeLLM, task, res, path.join(wsDir, res.id), { system: jp.system, commonDims: jp.common_dims, turnsOf });
    console.log(res.judge && res.judge.dims ? `   ◆ ${res.id} → ${res.judge.passed}/${res.judge.total} 维达标${res.judge.unsure ? ` · ${res.judge.unsure} 条拿不准` : ""}` : `   ◆ ${res.id} → 失败：${(res.judge && res.judge.error) || "?"}`);
  });

  if (j.judge) j.judge_prev = [{ ...j.judge, system: undefined }, ...(j.judge_prev || [])].slice(0, 5);
  j.judge = judgeLib.judgeMetaOf(results, {
    model: judgeName, model_id: judgeEntry.model, self_judge: selfJudge,
    prompt_hash: jp.hash, prompt_custom: jp.custom, system: jp.system, common_dims: jp.common_dims, at: new Date().toISOString(), rejudged: true,
  });
  j.human = judgeLib.humanStats(results);
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
  const prev = j.judge_prev && j.judge_prev[0];
  console.log(`\n====== 评委质量 ${j.judge.avg_pct == null ? "—" : j.judge.avg_pct + "%"}${prev && prev.avg_pct != null ? `（上一版 ${prev.avg_pct}%）` : ""}${j.judge.unsure ? ` · ${j.judge.unsure} 条拿不准待人工` : ""}${j.human.judge_agree_pct != null ? ` · 与人工一致 ${j.human.judge_agree_pct}%（对了 ${j.human.judge_compared} 条）` : ""} ======`);
}

if (require.main === module) main().catch((e) => { console.error("重判崩溃:", e); process.exit(2); });
