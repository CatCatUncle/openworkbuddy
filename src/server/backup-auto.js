// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 定时自动备份。
 *
 * 「立即备份」那颗按钮一直都在，可真出事的那天回头一看，最近一份往往是三个月前手点的。
 * 这里每小时醒一次，看离上一份自动备份够不够一个周期，够了就打一份，只留最近 KEEP 份。
 *
 * 几条规矩：
 *   · 默认关。备份包里有 config.json（全部 Key），在不在磁盘上多躺几份，得用户自己点头。
 *   · 只清自己打的（文件名带 -auto）。手点的、导入的、恢复前留底的，一份都不碰。
 *   · 正在恢复时不打：解包到一半去 tar，打出来的是半新半旧的一锅。
 *   · 失败要留痕（审计 + 日志），不许悄悄吞掉——备份坏了没人知道，比没开还糟。
 *   · 周期按「上一份自动备份的时间」算，不按进程启动时间：天天重开应用的人也能按时备上。
 */

const AUTO_TAG = "auto";
const KEEP = 7;
const ALLOWED_DAYS = [0, 1, 7]; // 0 = 关
const TICK_MS = 60 * 60 * 1000;
const FIRST_TICK_MS = 2 * 60 * 1000; // 刚启动那会儿机器正忙着加载，别抢

const isAuto = (name) => /-auto\.tar\.gz$/.test(String(name || ""));

/** 界面/接口传进来的周期收成 0/1/7，别的一律当关 */
function normalizeDays(v) {
  const n = Number(v);
  return ALLOWED_DAYS.includes(n) ? n : 0;
}

/** list 是 listBackups() 的结果（新的在前）。返回该不该现在打一份 */
function isDue(list, everyDays, now = Date.now()) {
  if (!everyDays) return false;
  const last = (list || []).filter((b) => isAuto(b.name)).map((b) => Date.parse(b.at)).filter(Number.isFinite);
  if (!last.length) return true;
  // 留一小时余量：每小时才醒一次，卡着整 24 小时算的话，会一天天往后漂
  return now - Math.max(...last) >= everyDays * 86400000 - TICK_MS;
}

/** 超出 keep 份的自动备份（最老的那些），手动的不在里面 */
function toPrune(list, keep = KEEP) {
  return (list || [])
    .filter((b) => isAuto(b.name))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(keep)
    .map((b) => b.name);
}

/**
 * 打包时跳过能重新生成的东西：按本机 tar 是哪一家给 --exclude 参数，模式一律从 -C 那一层的开头算。
 *
 * 两家 tar 的 --exclude 默认都不锚定开头——路径里任何一段对得上就跳过。
 * 2026-09-29 复审实测（bsdtar 3.5.3）：用户自己的技能 skills/x/ 底下要是有个 data/ 目录，
 * 里面的 metrics/、thumbs/、runtime/codex/cache/、*.json.bak 全被当成我们的派生数据悄悄漏打，
 * 恢复出来那个技能就缺了一块，打包时一个字都不说。
 *   · bsdtar（mac、Windows 自带）：模式前加 ^ 就锚定开头。
 *   · GNU tar（Linux）：--anchored 摆在这些 --exclude 前面；它不认 ^，加了等于一个都不排除。
 *   · 认不出是哪家（busybox 之类）：一个都不排除。包大一点，不会少东西。
 * @param {string} versionText `tar --version` 的输出
 * @param {string[]} patterns 如 "data/thumbs"、"data/*.json.bak"
 * @returns {string[]}
 */
function tarExcludeArgs(versionText, patterns) {
  const v = String(versionText || "");
  if (/bsdtar|libarchive/i.test(v)) return patterns.map((p) => "--exclude=^" + p);
  if (/\bGNU tar\b/.test(v)) return ["--anchored", ...patterns.map((p) => "--exclude=" + p)];
  return [];
}

/**
 * deps：
 *   everyDays()   → 当前配置的周期
 *   list()        → listBackups()
 *   make(tag)     → makeBackup(tag)，返回文件名
 *   remove(name)  → 删一份
 *   busy()        → 正在恢复/备份就返回 true
 *   audit(msg, verdict)
 */
function createAutoBackup(deps) {
  let running = false;
  let timer = null;
  let lastError = "";

  async function tick(now = Date.now()) {
    if (running) return { skipped: "running" };
    const days = normalizeDays(deps.everyDays());
    if (!days) return { skipped: "off" };
    if (deps.busy && deps.busy()) return { skipped: "busy" };
    if (!isDue(deps.list(), days, now)) return { skipped: "not-due" };
    running = true;
    try {
      const name = await deps.make(AUTO_TAG);
      const pruned = [];
      for (const n of toPrune(deps.list())) {
        try { deps.remove(n); pruned.push(n); }
        catch (e) { deps.audit(`自动备份：旧的 ${n} 没删掉（${e.message}）`, "失败"); }
      }
      lastError = "";
      deps.audit(`自动备份已存为 ${name}` + (pruned.length ? `，清掉了更早的 ${pruned.length} 份` : ""), "放行");
      return { made: name, pruned };
    } catch (e) {
      lastError = e.message;
      deps.audit(`自动备份失败：${e.message}`, "失败");
      console.warn("[自动备份] 失败:", e.message);
      return { error: e.message };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    const first = setTimeout(() => { tick(); }, FIRST_TICK_MS);
    if (first.unref) first.unref();
    timer = setInterval(() => { tick(); }, TICK_MS);
    if (timer.unref) timer.unref(); // 测试里起完就关的进程，别被这个定时器吊住
  }

  return { tick, start, isRunning: () => running, lastError: () => lastError };
}

module.exports = { createAutoBackup, normalizeDays, isDue, toPrune, isAuto, tarExcludeArgs, AUTO_TAG, KEEP };
