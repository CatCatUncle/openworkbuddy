"use strict";
/**
 * IM 会话仓库 —— 飞书/QQ/企微/公众号/微信/webhook 每个会话一条历史数组，落盘保存。
 *
 * 以前 IM 直接借网页那张内存 Map 用：一边存 { history, transcript } 一边存裸数组，
 * 类型撞上就是个哑炮；更实际的问题是重启一次（改个配置就要重启），
 * 飞书上所有对话的上下文全没了，用户那边表现为"它怎么突然失忆了"。
 *
 * 对外故意长得像 Map（has / get / set），只多一个 save：runTask 是就地往数组里追加的，
 * 不会经过 set，所以跑完一轮得由调用方招呼一声。
 */

const path = require("path");
const store = require("./store");

function createImSessionStore({ dir, maxEntries = 120 } = {}) {
  const mem = new Map();
  const fileOf = (key) => path.join(dir, String(key).replace(/[^\w-]/g, "_") + ".json");

  /**
   * 历史太长要砍，但只能从「一整轮的开头」下刀：从中间切会把 tool_use 和它的结果
   * 劈成两半，模型直接 400。就地改数组——调用方手里攥着的是同一个引用。
   */
  function cap(list) {
    if (list.length <= maxEntries) return list;
    for (let i = list.length - maxEntries; i < list.length; i++) {
      if (list[i] && list[i].role === "user") {
        list.splice(0, i);
        break;
      }
    }
    return list;
  }

  function persist(key, list) {
    try {
      store.writeJsonAtomic(fileOf(key), cap(list));
    } catch (e) {
      console.warn(`[IM会话] 存盘失败（${key}）：${e.message}`);
    }
  }

  return {
    has(key) {
      if (!mem.has(key)) {
        const d = store.readJson(fileOf(key), null);
        if (Array.isArray(d)) mem.set(key, d);
      }
      return mem.has(key);
    },
    get(key) {
      this.has(key); // 顺带把盘上的读回来
      return mem.get(key);
    },
    set(key, list) {
      mem.set(key, list);
      persist(key, list);
      return this;
    },
    /** 一轮跑完调一次 */
    save(key) {
      const list = mem.get(key);
      if (Array.isArray(list)) persist(key, list);
    },
  };
}

module.exports = { createImSessionStore };
