// @ts-check
"use strict";
/**
 * 这一趟任务花了多少钱——只数这一趟的，别的会话同时在花的不算进来。
 *
 * 跟 quota.withActor 同一个路子：用 AsyncLocalStorage 把一个小账本挂在这趟任务的异步链上，
 * 记账的地方（quota.record 算完钱那一行、im.js 收到整趟的 usage 那一刻）只管 note 一笔，
 * 不用知道自己在谁的任务里。没进过 track 的调用 note 是空操作 = 老行为一字不差。
 *
 * 只认得同一个进程里的账：CLI 引擎（Claude Code / Codex）的工具跑在 engines/tool-bridge.js
 * 那个子进程里，这里看不见。所以调用方拿到的数只在「整趟都在本进程里跑」时才算完整，
 * 不完整的时候该不显示，不该当成完整的数给人看（im.js 就是这么做的）。
 *
 * 「单价未知」按项数，不按次数：同一个没登记价格的搜索源搜了 30 次，是 1 项不知道，不是 30 项。
 */
const { AsyncLocalStorage } = require("async_hooks");

/** @typedef {{ yuan: number, unknownN: number }} Spend */
/** @typedef {{ yuan: number, unknown: Set<string>, onChange: ((s: Spend) => void) | null }} Store */

/** @type {AsyncLocalStorage<Store>} */
const als = new AsyncLocalStorage();

/** 保留 6 位小数，跟 pricing.js 一个口径：单次调用常常只有几厘钱 @param {number} n */
function r6(n) { return Math.round((n + Number.EPSILON) * 1e6) / 1e6; }

/** @param {Store} st @returns {Spend} */
function snap(st) { return { yuan: st.yuan, unknownN: st.unknown.size }; }

/**
 * 在一个新账本里跑 fn。每记一笔就回调一次 onChange(当前合计)。
 * @template T
 * @param {((s: Spend) => void) | null | undefined} onChange
 * @param {() => T} fn
 * @returns {T}
 */
function track(onChange, fn) {
  return als.run({ yuan: 0, unknown: new Set(), onChange: typeof onChange === "function" ? onChange : null }, fn);
}

/**
 * 记一笔。不在 track 里就什么也不做（返回 false）。
 * unknown 的那笔不加钱，只记「这一项不知道单价」——绝不当 0 元加进去。
 * @param {{ cap?: string, model?: string, yuan?: number, unknown?: boolean }} [item]
 * @returns {boolean}
 */
function note(item = {}) {
  const st = als.getStore();
  if (!st) return false;
  if (item.unknown) st.unknown.add(`${item.cap || ""}\u0000${item.model || ""}`);
  else {
    const y = Number(item.yuan);
    if (Number.isFinite(y) && y > 0) st.yuan = r6(st.yuan + y);
  }
  // 回调出错不能反过来把记账（进而把那次已经成功的调用）搅黄
  if (st.onChange) try { st.onChange(snap(st)); } catch {}
  return true;
}

/**
 * 自己直连付费接口、既不走 quota.record 也不回 usage 的工具：这里看不见它花了多少。
 * look_at_image（src/tools/media.js）直接调视觉模型，没记账也没回 token 数。
 * 用过就记一项「单价未知」，合计不当成完整的数；等它自己记上账，就从这里拿掉。
 */
const UNMETERED_TOOLS = new Set(["look_at_image"]);

/** 工具跑完（不论几层子智能体里）调一次；只有看不见花费的那几个会记 @param {unknown} name @returns {boolean} */
function noteTool(name) {
  return UNMETERED_TOOLS.has(String(name || "")) ? note({ cap: "tool", model: String(name), unknown: true }) : false;
}

/** 当前这一趟的合计；不在 track 里是 null @returns {Spend | null} */
function snapshot() {
  const st = als.getStore();
  return st ? snap(st) : null;
}

module.exports = { track, note, noteTool, snapshot, UNMETERED_TOOLS };
