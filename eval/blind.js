// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 盲评：两轮评测同一道题的成果并排给人看，不告诉哪边是哪轮，人选更好的那个。
 *
 * 分数说得清有没有做对，说不清哪份 PPT 更能拿去用。GDPval 的做法是让专家
 * 不看来源比较两份交付物。这里每题的左右随机，选完才揭晓，避免人偏向新模型。
 * 服务端记左右对应，发给页面的内容里没有轮次名，文件也走会话编号读。
 * 模型自己在回答里提到名字时遮不住，这是盲评的已知漏洞。
 */
const crypto = require("crypto");

const PICKS = new Set(["left", "right", "tie"]);
const SAFE_DIR = /^[\w.-]+$/;

/** 两轮都有的题，每题随机一次左右。rand 只给测试用 */
function pair(dirA, runA, dirB, runB, rand = Math.random) {
  if (!SAFE_DIR.test(dirA) || !SAFE_DIR.test(dirB) || dirA === dirB) throw new Error("要选两轮不同的评测");
  const byId = new Map((runB.results || []).map((row) => [row.id, row]));
  const items = (runA.results || []).filter((row) => byId.has(row.id)).map((row) => ({
    task: row.id, name: row.name || row.id, left: rand() < 0.5 ? dirA : dirB, pick: "",
  }));
  if (!items.length) throw new Error("这两轮没有相同的题");
  return { id: crypto.randomBytes(8).toString("hex"), a: dirA, b: dirB, items: items.map((item) => ({ ...item, right: item.left === dirA ? dirB : dirA })), created_at: new Date().toISOString() };
}

const sideOf = (row) => ({ text: String((row && row.final_text) || ""), files: ((row && row.artifacts) || []).map((file) => ({ name: file.name, size: file.size })) });

/** 给页面的内容：只有 left / right，没有轮次。load(dir) 读那一轮的 results */
function view(session, load) {
  const runs = new Map([session.a, session.b].map((dir) => [dir, load(dir) || { results: [] }]));
  const find = (dir, task) => (runs.get(dir).results || []).find((row) => row.id === task);
  return {
    id: session.id,
    items: session.items.map((item, index) => ({ index, task: item.task, name: item.name, pick: item.pick, left: sideOf(find(item.left, item.task)), right: sideOf(find(item.right, item.task)) })),
  };
}

function vote(session, index, pick) {
  if (!PICKS.has(pick)) throw new Error("只能选左边、右边或差不多");
  const item = session.items[Number(index)];
  if (!item) throw new Error("没有这道题");
  item.pick = pick;
  return session;
}

/** 全部选完才给结果：选到一半就揭晓，后面的题就不盲了 */
function tally(session) {
  if (session.items.some((item) => !item.pick)) return null;
  const count = { [session.a]: 0, [session.b]: 0 };
  let ties = 0;
  for (const item of session.items) {
    if (item.pick === "tie") ties += 1;
    else count[item.pick === "left" ? item.left : item.right] += 1;
  }
  const decided = count[session.a] + count[session.b];
  return {
    a: { dir: session.a, wins: count[session.a] }, b: { dir: session.b, wins: count[session.b] }, ties,
    // 平局不计入胜率，题太少时这个数只能当参考
    a_win_rate: decided ? +(count[session.a] / decided).toFixed(3) : null,
    items: session.items.map((item) => ({ task: item.task, name: item.name, winner: item.pick === "tie" ? "" : item.pick === "left" ? item.left : item.right })),
  };
}

/** 这一题这一边是哪轮 */
function dirOf(session, index, side) {
  const item = session.items[Number(index)];
  if (!item || !["left", "right"].includes(side)) return null;
  return { dir: item[side], task: item.task };
}

module.exports = { pair, view, vote, tally, dirOf };
