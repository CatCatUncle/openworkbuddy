"use strict";
/**
 * 自动化 / 定时任务 — 到点自动让 Agent 执行任务（如每天早上生成日报、每周五汇总周报）。
 * 任务持久化在 schedules.json；cron 5 字段：分 时 日 月 周（支持 * , - 和 星号/步长）。
 */

const fs = require("fs");
const path = require("path");

const STORE = path.join(__dirname, "schedules.json");

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    return { tasks: [] };
  }
}
function saveStore(store) {
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2), "utf8");
}

// ---------- 迷你 cron 解析 ----------

function parseField(field, min, max) {
  const values = new Set();
  for (const part of field.split(",")) {
    let m;
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if ((m = part.match(/^\*\/(\d+)$/))) {
      const step = parseInt(m[1], 10);
      for (let i = min; i <= max; i += step) values.add(i);
    } else if ((m = part.match(/^(\d+)-(\d+)$/))) {
      for (let i = parseInt(m[1], 10); i <= parseInt(m[2], 10); i++) values.add(i);
    } else if (/^\d+$/.test(part)) {
      values.add(parseInt(part, 10));
    } else {
      throw new Error(`无法解析 cron 字段: ${part}`);
    }
  }
  return values;
}

function parseCron(expr) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron 需要 5 个字段：分 时 日 月 周");
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dom: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    dow: parseField(fields[4], 0, 6), // 0=周日
  };
}

function cronMatches(cron, date) {
  return (
    cron.minute.has(date.getMinutes()) &&
    cron.hour.has(date.getHours()) &&
    cron.dom.has(date.getDate()) &&
    cron.month.has(date.getMonth() + 1) &&
    cron.dow.has(date.getDay())
  );
}

// ---------- 调度器 ----------

function createScheduler({ runtime, onResult }) {
  const store = loadStore();
  let lastMinuteKey = "";

  function list() {
    return store.tasks;
  }

  function add({ name, cron, task }) {
    parseCron(cron); // 校验
    const item = {
      id: "sch_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name || task.slice(0, 30),
      cron,
      task,
      enabled: true,
      created_at: new Date().toISOString(),
      last_run: null,
      last_result: null,
    };
    store.tasks.push(item);
    saveStore(store);
    return item;
  }

  function remove(id) {
    const before = store.tasks.length;
    store.tasks = store.tasks.filter((t) => t.id !== id);
    saveStore(store);
    return store.tasks.length < before;
  }

  function toggle(id, enabled) {
    const t = store.tasks.find((t) => t.id === id);
    if (!t) return false;
    t.enabled = enabled;
    saveStore(store);
    return true;
  }

  async function runOne(item, trigger) {
    console.log(`[定时任务] 触发 (${trigger}): ${item.name}`);
    item.last_run = new Date().toISOString();
    saveStore(store);
    try {
      // 每次执行用全新会话，避免历史无限增长
      const history = [{ role: "user", content: item.task }];
      const { finalText } = await runtime.runTask({ history });
      item.last_result = (finalText || "完成").slice(0, 500);
      saveStore(store);
      if (onResult) await onResult(item, finalText);
      return finalText;
    } catch (e) {
      item.last_result = "出错: " + e.message;
      saveStore(store);
      if (onResult) await onResult(item, "执行出错: " + e.message);
      throw e;
    }
  }

  function tick() {
    const now = new Date();
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (key === lastMinuteKey) return; // 每分钟只判断一次
    lastMinuteKey = key;
    for (const item of store.tasks) {
      if (!item.enabled) continue;
      try {
        if (cronMatches(parseCron(item.cron), now)) {
          runOne(item, "cron").catch((e) => console.error(`[定时任务] ${item.name} 失败:`, e.message));
        }
      } catch (e) {
        console.warn(`[定时任务] ${item.name} cron 无效:`, e.message);
      }
    }
  }

  const timer = setInterval(tick, 20000);
  timer.unref && timer.unref();

  return { list, add, remove, toggle, runOne };
}

module.exports = { createScheduler, parseCron };
