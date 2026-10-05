// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 资料库收藏：一人一份，跟着资料库的根走（libraryRootOf(user)/.favorites.json）。
 *
 * 为什么放在资料库根里、名字还带个点：
 *   · 一人一个根本来就是 2026-09 那次「新号看见别人的合同」事故之后定下的隔离单位，收藏跟着它，
 *     换账号就是换一份，不用再单开一张按用户分的表；
 *   · 点开头的名字，列资料库、全库搜索、agent 的 library_list 都本来就跳过（.inspirations.json 同一个路子）。
 *     不带点的话，这份清单会作为「一个文件」出现在用户自己的资料库里，还能被顺手删掉。
 *
 * 几条规矩，test/library-favs.js 每条都钉着：
 *   · 原子写：先写临时名再改名（store.writeJsonAtomic），写到一半断电不会留下半份 JSON；
 *   · 同一个根的写一个接一个排队：20 下连点收藏 / 取消，一条都不丢——并发的「读-改-写」
 *     不排队的话，后写的那份会拿着自己读到的旧清单把前一份盖掉；
 *   · 文件坏了不硬扛：原样改名成 .favorites.json.bad-<毫秒> 留给人看，按「没有收藏」往下走；
 *   · 收藏的东西没了（被删、被挪）不偷偷从清单里抹掉，列出来时标 missing，让用户自己决定。
 */
const fs = require("fs");
const path = require("path");
const store = require("./src/platform/store");

const FAV_FILE = ".favorites.json";
const FAV_MAX = 5000; // 一个人收藏到这个数已经不是「收藏」了；再多也只是让每次列资料库多 parse 一份大 JSON
const SRCS = new Set(["lib", "ws"]);

/** 每个根一条写队列 */
const chains = new Map();
/** 读缓存：根 → { mtimeMs, size, data }。列资料库每次都要问一遍「哪些收藏了」，文件不动就不重读 */
const cache = new Map();

function favFileOf(root) {
  return path.join(String(root || ""), FAV_FILE);
}

/** src:path 这一对规整成清单里的键。path 统一正斜杠、去首尾斜杠；不合法的返回空串 */
function favKey(src, rel) {
  const s = String(src || "");
  if (!SRCS.has(s)) return "";
  const parts = String(rel || "").replace(/\\/g, "/").split("/").filter((x) => x && x !== ".");
  if (!parts.length || parts.some((x) => x === ".." || /[\u0000-\u001f]/.test(x))) return "";
  return s + ":" + parts.join("/");
}
function splitKey(k) {
  const i = k.indexOf(":");
  return { src: k.slice(0, i), path: k.slice(i + 1) };
}

const empty = () => ({ v: 1, items: {} });

/**
 * 读一份收藏清单。坏了（不是 JSON、结构不对）就改名成 .bad-<毫秒> 隔离，按空的算。
 * 读不到（还没收藏过）是正常情况，也按空的算，不留任何东西。
 * @returns {{ v: number, items: Record<string, { at: number, mtime?: string, size?: number }> }}
 */
function readFavs(root) {
  const file = favFileOf(root);
  let st;
  try { st = fs.statSync(file); } catch { cache.delete(file); return empty(); }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
  let data = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && raw.items && typeof raw.items === "object" && !Array.isArray(raw.items)) data = raw;
  } catch {}
  if (!data) {
    const bad = `${file}.bad-${Date.now()}`;
    try {
      fs.renameSync(file, bad);
      console.error(`[收藏] ${path.basename(file)} 读不出来，已原样改名成 ${path.basename(bad)}，按没有收藏往下走`);
    } catch (e) {
      console.error(`[收藏] ${path.basename(file)} 读不出来，改名隔离也没成功（${(e && e.message) || e}），这一次按没有收藏算`);
    }
    cache.delete(file);
    return empty();
  }
  // 只留认得出的条目：手改坏了的某一条不该拖累整份
  const items = {};
  for (const [k, v] of Object.entries(data.items)) {
    if (!favKey(splitKey(k).src, splitKey(k).path) || !v || typeof v !== "object") continue;
    items[k] = { at: Number(v.at) || 0, ...(v.mtime ? { mtime: String(v.mtime) } : {}), ...(Number.isFinite(v.size) ? { size: v.size } : {}) };
  }
  const clean = { v: 1, items };
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data: clean });
  return clean;
}

/** 这个根下收藏了哪些，Set<"src:path">。列资料库时逐行打 fav 标记用 */
function favKeys(root) {
  return new Set(Object.keys(readFavs(root).items));
}

/** 同一个根上的写排成一队；前一件出错不拦后一件 */
function serial(root, fn) {
  const key = path.resolve(String(root || ""));
  const prev = chains.get(key) || Promise.resolve();
  const job = prev.then(fn, fn);
  const tail = job.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return job;
}

/**
 * 收藏 / 取消收藏。返回这一条最后的状态（true = 在收藏里）。
 * @param {string} root 资料库的根（libraryRootOf(user)）
 * @param {{ src: string, path: string, on: boolean, mtime?: string, size?: number, now?: number }} op
 * @returns {Promise<boolean>}
 */
function setFav(root, { src, path: rel, on, mtime, size, now }) {
  const k = favKey(src, rel);
  if (!k) return Promise.reject(Object.assign(new Error("收藏的路径不合法"), { status: 400 }));
  return serial(root, () => {
    const data = readFavs(root);
    const items = { ...data.items };
    if (on) {
      if (!items[k] && Object.keys(items).length >= FAV_MAX) {
        throw Object.assign(new Error(`收藏已经有 ${FAV_MAX} 条了，先取消几条再加`), { status: 400 });
      }
      items[k] = { at: (items[k] && items[k].at) || Number(now) || Date.now(), ...(mtime ? { mtime: String(mtime) } : {}), ...(Number.isFinite(size) ? { size } : {}) };
    } else {
      if (!items[k]) return false; // 本来就没收藏：不为一个空操作去写盘
      delete items[k];
    }
    fs.mkdirSync(String(root), { recursive: true });
    store.writeJsonAtomic(favFileOf(root), { v: 1, items }, { backup: false });
    cache.delete(favFileOf(root));
    return !!on;
  });
}

/**
 * 列出收藏，新收藏的在前。missing 交给调用方判：lib 要按资料库的根解析，ws 要按当前工作区解析，
 * 这里不知道「当前」是哪个根。判不出来（抛错）按没了算——指着一个解析不了的路径，用户点下去也打不开。
 * @param {string} root
 * @param {(src: string, rel: string) => boolean} exists
 * @returns {{ src: string, path: string, at: number, missing: boolean }[]}
 */
function listFavs(root, exists) {
  const rows = [];
  for (const [k, v] of Object.entries(readFavs(root).items)) {
    const { src, path: rel } = splitKey(k);
    let here = false;
    try { here = !!exists(src, rel); } catch { here = false; }
    rows.push({ src, path: rel, at: v.at, missing: !here });
  }
  rows.sort((a, b) => b.at - a.at);
  return rows;
}

module.exports = { FAV_FILE, FAV_MAX, favFileOf, favKey, favKeys, readFavs, setFav, listFavs };
