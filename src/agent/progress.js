// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";

// 清单是模型确认的交付状态，工具次数只决定何时提醒，绝不换算成完成率。
const { normalizeTodos } = require("./code-tools");
const CONTINUE_RE = /^(?:【任务类型：[^】]*】\s*)?(?:继续(?:给我完成|完成)?|接着做|接着干|接着来|接着上次进度做|continue|go on|keep going)[\s。.!！]*$/i;

function restorePendingTodos(history) {
  const list = Array.isArray(history) ? history : [];
  const isAsk = (m) => m && m.role === "user" && typeof m.content === "string" && !/^【(?:系统|目标验收|用户插话)/.test(m.content);
  const ask = [...list].reverse().find(isAsk);
  if (!ask || !CONTINUE_RE.test(ask.content.trim())) return null;
  let floor = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (isAsk(list[i]) && !CONTINUE_RE.test(list[i].content.trim())) { floor = i; break; }
  }
  const successful = new Set();
  for (let i = list.length - 1; i >= floor; i--) {
    const m = list[i];
    if (m.role === "tool") for (const r of m.results || []) if (!r.isError) successful.add(r.id);
    if (m.role !== "assistant") continue;
    for (const tc of [...(m.toolCalls || [])].reverse()) {
      if (tc.name !== "todo_write" || !successful.has(tc.id)) continue;
      const r = normalizeTodos((tc.input || {}).todos);
      // 最新成功清单已清空/全完成时，不能捡起更早的未完成清单。
      return !r.error && r.items.some((t) => t.status !== "done") ? r.items : null;
    }
  }
  return null;
}

function parseMilestones(raw) {
  const items = [];
  for (const line of String(raw).slice(0, 20000).split("\n")) {
    const m = /^\s*[-*]\s*\[([ xX])\]\s*(.+)/.exec(line);
    if (m) items.push({ text: m[2].trim().slice(0, 120), done: m[1] !== " " });
    if (items.length >= 60) break;
  }
  return items;
}

function createProgressTracker({ now = Date.now, maxTools = 6, maxAgeMs = 90000 } = {}) {
  let plan = null, at = 0, calls = 0, nudged = false, restored = false;
  const open = () => plan && plan.items.some((t) => plan.type === "todos" ? t.status !== "done" : !t.done);
  const overdue = () => !!open() && (restored || calls >= maxTools || (calls > 0 && now() - at >= maxAgeMs));
  return {
    update(event, { restore = false } = {}) {
      plan = { ...event, items: event.items.map((t) => ({ ...t })) };
      restored = restore; at = restore ? 0 : now(); calls = 0; nudged = false;
      return { ...plan, at: at || null, ...(restore ? { restored: true } : {}) };
    },
    toolFinished() { if (open()) calls++; },
    overdue,
    todosOverdue() { return !!plan && plan.type === "todos" && overdue(); },
    beforeStep() {
      if (!overdue()) return { prompt: "", requireSync: false };
      const requireSync = nudged && plan.type === "todos";
      nudged = true;
      const items = plan.items.slice(0, 20).map((t) => plan.type === "todos"
        ? `[${t.status}] ${t.content}` : `[${t.done ? "done" : "pending"}] ${t.text}`).join("\n");
      const target = plan.type === "todos" ? "todo_write" : `更新 ${plan.file || "PROGRESS.md"}`;
      return {
        requireSync,
        prompt: `\n\n【系统·执行中进度核对】${restored ? "下面是上一轮留下的清单，尚未核对现场" : `清单确认后已执行 ${calls} 个工具，需核对实际进展`}。\n${items}\n请先根据已有工具结果${target}，同步真实状态；必要时可先只读核验。未完成的仍保持进行中/待做，说明当前操作或阻塞，绝不能为刷新进度把未做的事标成完成。清单仍然准确时也应通过同一工具确认一次。${requireSync ? "清单核对前，新写入、命令和生成操作暂不执行；读取、查询和停止后台命令仍可用。" : ""}`,
      };
    },
  };
}

module.exports = { CONTINUE_RE, createProgressTracker, parseMilestones, restorePendingTodos };
