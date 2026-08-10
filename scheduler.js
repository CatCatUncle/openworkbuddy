"use strict";
/**
 * 自动化 / 定时任务 — 到点自动让 Agent 执行任务（如每天早上生成日报、每周五汇总周报）。
 * 任务持久化在 schedules.json；cron 5 字段：分 时 日 月 周（支持 * , - 和 星号/步长）。
 */

const fs = require("fs");
const path = require("path");

const STORE = path.join(__dirname, "schedules.json");

/** 错过的任务最多往回补一天；关机一个月不该开机就把一个月的晨报全补一遍 */
const MAX_CATCHUP_MS = 24 * 3600 * 1000;
/** 两次 tick 差这么久，就认为中间那段没人看着（睡眠 / 应用关了） */
const GAP_MS = 90 * 1000;

function loadStore(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return { tasks: Array.isArray(j.tasks) ? j.tasks : [], last_tick_at: j.last_tick_at || "" };
  } catch {
    return { tasks: [], last_tick_at: "" };
  }
}
function saveStore(store, file) {
  // 先写临时文件再改名：直接覆写的话，写到一半断电就只剩半个 JSON，整张任务表就没了
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// ---------- 迷你 cron 解析 ----------

/**
 * 解析一个 cron 字段。支持 *、5、1-5、*\/15、1-30/5、5/10，逗号分隔。
 * 越界和写反的一律报错——静默收下的后果是任务永远不触发，而界面上看它一切正常。
 */
function parseField(field, min, max, label) {
  const values = new Set();
  const bad = (why) => new Error(`${label}字段「${field}」${why}`);
  for (const part of String(field).split(",")) {
    const bits = part.split("/");
    if (bits.length > 2) throw bad(`里的「${part}」不认识`);
    let step = 1;
    if (bits.length === 2) {
      if (!/^\d+$/.test(bits[1])) throw bad(`的步长「${bits[1]}」不是数字`);
      step = parseInt(bits[1], 10);
      // 步长 0 会让下面的 for 永远走不动，整个进程就卡死在这一行（server 跑在 Electron 主进程里，界面会一起冻住）
      if (step < 1) throw bad("的步长必须 ≥ 1");
    }
    const range = bits[0];
    let lo, hi, m;
    if (range === "*") {
      lo = min; hi = max;
    } else if ((m = range.match(/^(\d+)-(\d+)$/))) {
      lo = parseInt(m[1], 10); hi = parseInt(m[2], 10);
      if (lo > hi) throw bad(`里的范围「${range}」写反了`);
    } else if (/^\d+$/.test(range)) {
      lo = parseInt(range, 10);
      hi = bits.length === 2 ? max : lo; // 标准 cron：5/10 是「从 5 开始每 10」
    } else {
      throw bad(`里的「${part}」不认识`);
    }
    if (lo < min || hi > max) throw bad(`超出范围，只能是 ${min}-${max}`);
    for (let i = lo; i <= hi; i += step) values.add(i);
  }
  if (!values.size) throw bad("没圈出任何值");
  return values;
}

function parseCron(expr) {
  const fields = String(expr || "").trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron 需要 5 个字段：分 时 日 月 周");
  const dow = parseField(fields[4], 0, 7, "周");
  if (dow.has(7)) { dow.delete(7); dow.add(0); } // 标准 cron 里 0 和 7 都是周日
  return {
    minute: parseField(fields[0], 0, 59, "分"),
    hour: parseField(fields[1], 0, 23, "时"),
    dom: parseField(fields[2], 1, 31, "日"),
    month: parseField(fields[3], 1, 12, "月"),
    dow,
    // 标准 cron 的怪脾气：日和周都限定了就是「或」，得留着原样才判得出来
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

function cronMatches(cron, date) {
  if (!cron.minute.has(date.getMinutes())) return false;
  if (!cron.hour.has(date.getHours())) return false;
  if (!cron.month.has(date.getMonth() + 1)) return false;
  const dom = cron.dom.has(date.getDate());
  const dow = cron.dow.has(date.getDay());
  // 「每月 1 号 或 每周一」——两个都写了具体值时标准 cron 是取或，不是取且
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  return dom && dow;
}

// ---------- 调度器 ----------

function createScheduler({ runtime, onResult, storePath }) {
  // 测试要能指到别处去，不然一跑测试就把用户真的任务表洗了
  const file = storePath || STORE;
  const store = loadStore(file);
  let lastMinuteKey = "";
  /** 正在跑的任务 id → 开始时间戳。同一个任务不许叠着跑，上一次没跑完就跳过这次 */
  const running = new Map();
  // 上次看表是什么时候。开机第一眼不补跑，否则第一次装起来就会把历史全部重放一遍
  let lastTickMs = store.last_tick_at ? Date.parse(store.last_tick_at) || 0 : 0;

  function list() {
    return store.tasks.map((t) => ({ ...t, running: running.has(t.id), running_since: running.get(t.id) ? new Date(running.get(t.id)).toISOString() : null }));
  }

  function add({ name, cron, task, catch_up }) {
    task = String(task || "").trim();
    if (!task) throw new Error("任务描述不能为空");
    parseCron(cron); // 校验
    const item = {
      id: "sch_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: String(name || "").trim() || task.slice(0, 30),
      cron: String(cron).trim(),
      task,
      enabled: true,
      // 错过了要不要补：默认补。笔记本合上盖子过一夜，晨报不该就这么没了
      catch_up: catch_up !== false,
      created_at: new Date().toISOString(),
      last_run: null,
      last_result: null,
    };
    store.tasks.push(item);
    saveStore(store, file);
    return item;
  }

  function remove(id) {
    const before = store.tasks.length;
    store.tasks = store.tasks.filter((t) => t.id !== id);
    saveStore(store, file);
    return store.tasks.length < before;
  }

  function toggle(id, enabled) {
    const t = store.tasks.find((t) => t.id === id);
    if (!t) return false;
    t.enabled = enabled;
    saveStore(store, file);
    return true;
  }

  /** 错过了补不补跑 */
  function setCatchUp(id, on) {
    const t = store.tasks.find((t) => t.id === id);
    if (!t) return false;
    t.catch_up = !!on;
    saveStore(store, file);
    return true;
  }

  async function runOne(ref, trigger) {
    // list() 出去的是副本，外面拿着副本回来跑的话，进度会写在副本上存不下来——一律换回本体
    const item = store.tasks.find((t) => t.id === (ref && ref.id ? ref.id : ref));
    if (!item) throw new Error("任务不存在");
    if (running.has(item.id)) {
      const since = new Date(running.get(item.id)).toTimeString().slice(0, 5);
      throw new Error(`这个任务正在跑（${since} 开始），等它跑完再说`);
    }
    console.log(`[定时任务] 触发 (${trigger}): ${item.name}`);
    running.set(item.id, Date.now());
    item.last_run = new Date().toISOString();
    item.last_trigger = trigger;
    saveStore(store, file);
    try {
      // 每次执行用全新会话，避免历史无限增长
      const history = [{ role: "user", content: item.task }];
      const { finalText } = await runtime.runTask({ history });
      item.last_result = (finalText || "完成").slice(0, 500);
      saveStore(store, file);
      if (onResult) await onResult(item, finalText);
      return finalText;
    } catch (e) {
      item.last_result = "出错: " + e.message;
      saveStore(store, file);
      if (onResult) await onResult(item, "执行出错: " + e.message);
      throw e;
    } finally {
      running.delete(item.id);
    }
  }

  function fire(item, trigger) {
    if (running.has(item.id)) {
      console.log(`[定时任务] ${item.name} 上一次还没跑完，跳过这次`);
      return false;
    }
    runOne(item, trigger).catch((e) => console.error(`[定时任务] ${item.name} 失败:`, e.message));
    return true;
  }

  /**
   * 中间断了一段（睡眠、应用关着）时，把那段时间里本该触发的任务捞出来。
   * 一段里命中几次也只补跑一次，补的是最近该跑的那次——补跑是「这件事还没做」，
   * 不是把闹钟按错过的次数重放一遍。返回补了哪些 id。
   */
  function catchUp(fromMs, toMs) {
    const fired = new Set();
    const start = Math.max(fromMs, toMs - MAX_CATCHUP_MS);
    if (toMs - fromMs > MAX_CATCHUP_MS) {
      console.warn(`[定时任务] 停了 ${Math.round((toMs - fromMs) / 3600000)} 小时，只补最近 24 小时的，更早的按过期丢掉`);
    }
    // 从断点后的下一分钟找到本次 tick 的前一分钟；当前这一分钟走正常路径，别重复
    const from = Math.floor(start / 60000) * 60000 + 60000;
    const to = Math.floor(toMs / 60000) * 60000;
    for (const item of store.tasks) {
      if (!item.enabled || item.catch_up === false) continue;
      let cron;
      try { cron = parseCron(item.cron); } catch { continue; }
      let at = null;
      for (let ms = from; ms < to; ms += 60000) {
        const d = new Date(ms);
        if (cronMatches(cron, d)) at = d;
      }
      if (!at) continue;
      item.missed_at = at.toISOString();
      console.log(`[定时任务] ${item.name} 错过了 ${at.toTimeString().slice(0, 5)} 那次，现在补跑`);
      if (fire(item, "补跑")) fired.add(item.id);
    }
    return fired;
  }

  function tick() {
    const now = new Date();
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (key === lastMinuteKey) return; // 每分钟只判断一次
    lastMinuteKey = key;
    const nowMs = now.getTime();
    let caught = new Set();
    if (lastTickMs && nowMs - lastTickMs > GAP_MS) {
      try { caught = catchUp(lastTickMs, nowMs); } catch (e) { console.warn("[定时任务] 补跑检查出错:", e.message); }
    }
    lastTickMs = nowMs;
    store.last_tick_at = now.toISOString();
    for (const item of store.tasks) {
      if (!item.enabled || caught.has(item.id)) continue; // 刚补跑过的这次就别再来一遍
      try {
        if (cronMatches(parseCron(item.cron), now)) fire(item, "cron");
      } catch (e) {
        console.warn(`[定时任务] ${item.name} cron 无效:`, e.message);
      }
    }
    saveStore(store, file);
  }

  const timer = setInterval(tick, 20000);
  timer.unref && timer.unref();

  return { list, add, remove, toggle, setCatchUp, runOne, tick, catchUp, stop: () => clearInterval(timer) };
}

module.exports = { createScheduler, parseCron, cronMatches };
