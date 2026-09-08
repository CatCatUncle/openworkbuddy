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

const fs = require("fs");
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
    /**
     * 有几段会话在记着上下文：内存里的 + 盘上还没读进来的。
     * 只数非空的——「set(key, [])」是闲置重置留下的空壳，用户眼里那不算一段会话。
     */
    keys() {
      const out = new Set();
      for (const [k, v] of mem) if (Array.isArray(v) && v.length) out.add(k);
      let names = [];
      try { names = fs.readdirSync(dir); } catch {}
      for (const n of names) {
        if (!n.endsWith(".json")) continue;
        const k = n.slice(0, -5);
        if (out.has(k)) continue;
        const d = store.readJson(path.join(dir, n), null);
        if (Array.isArray(d) && d.length) out.add(k);
      }
      return [...out];
    },
    /** 清空全部 IM 会话上下文（内存 + 盘），返回清掉的段数。文件名和 key 不一定可逆，所以按目录扫 */
    clear() {
      const n = this.keys().length;
      mem.clear();
      let names = [];
      try { names = fs.readdirSync(dir); } catch {}
      for (const f of names) {
        if (!f.endsWith(".json")) continue;
        try { fs.unlinkSync(path.join(dir, f)); } catch (e) { console.warn(`[IM会话] 删不掉 ${f}：${e.message}`); }
      }
      return n;
    },
  };
}

module.exports = { createImSessionStore };
