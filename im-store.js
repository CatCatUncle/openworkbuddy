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
  // 「盘上这个文件空不空」的小账本：键是文件名，值是 { mtimeMs, size, nonEmpty }。
  // 只为 keys() 服务——省掉的是重复的整份 JSON.parse，不缓存内容本身，所以不会读到脏数据。
  const probe = new Map();
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
     *
     * 这个数字挂在 /im/status 上，网页 15 秒问一次、开着就一直问。以前每问一次
     * 就把盘上每个会话文件整份 JSON.parse 一遍（飞书一个群聊就 100KB+），
     * 而且解出来只用来判个「空不空」，转手就扔——下次再来还得重解。
     * 同步解析卡的是同一条事件循环，跟正在跑的任务抢的是同一口气。
     * 改成按 (mtime, size) 记账：文件没动过就不重解，动过了才重来一次。
     */
    keys() {
      const out = new Set();
      for (const [k, v] of mem) if (Array.isArray(v) && v.length) out.add(k);
      let names = [];
      try { names = fs.readdirSync(dir); } catch {}
      const alive = new Set();
      for (const n of names) {
        if (!n.endsWith(".json")) continue;
        const k = n.slice(0, -5);
        alive.add(n);
        if (out.has(k)) continue;
        const f = path.join(dir, n);
        let st = null;
        try { st = fs.statSync(f); } catch { continue; }
        const memo = probe.get(n);
        if (memo && memo.mtimeMs === st.mtimeMs && memo.size === st.size) {
          if (memo.nonEmpty) out.add(k);
          continue;
        }
        const d = store.readJson(f, null);
        const nonEmpty = Array.isArray(d) && d.length > 0;
        probe.set(n, { mtimeMs: st.mtimeMs, size: st.size, nonEmpty });
        if (nonEmpty) out.add(k);
      }
      for (const n of probe.keys()) if (!alive.has(n)) probe.delete(n); // 文件删了账也销掉
      return [...out];
    },
    /** 清空全部 IM 会话上下文（内存 + 盘），返回清掉的段数。文件名和 key 不一定可逆，所以按目录扫 */
    clear() {
      const n = this.keys().length;
      mem.clear();
      probe.clear();
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
