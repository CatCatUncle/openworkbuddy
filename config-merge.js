"use strict";
/**
 * 配置文件的三方合并 —— 「我改的」盖到「磁盘上现在这份」上。
 *
 * 起因是一条很实在的抱怨：在编辑器里把 API Key 粘进 config.json，回到界面点一下保存，
 * Key 没了。因为存盘存的是内存里那整份 config，而那份是启动时读的，压根不知道文件被人动过。
 * 同一类事还有：另开一个窗口、或者命令行 `wb engine xxx`，两边都拿几秒前的整份内存互相覆盖。
 *
 * 这里的路子不是「谁后写谁赢」，而是先算出**这个进程到底改了哪几处**（拿当前内存跟
 * 上一次跟磁盘对齐时的快照做差），再把这几处按路径盖到磁盘那份上。没被我改过的地方，
 * 磁盘上是什么样就还是什么样——用户粘的 Key 一个字不动。
 */

const fs = require("fs");

/** 文件的改动时间；没有这个文件就当 0（0 表示「没得比」，调用方据此跳过合并） */
function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** 深拷一份当基线。配置里都是能进 JSON 的东西，结构化克隆那一套在这儿属于杀鸡用牛刀 */
function snapshot(v) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return {};
  }
}

const isPlain = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * 这个进程改了哪几处（相对基线）。返回一条条路径，不是整份对象——整份对象正是病根。
 *
 * 数组整条算一个叶子：models、mcp_servers 这些用户是整条换的，逐项合并只会合出一张
 * 谁也没想要的混合表（删掉的又回来了，顺序还乱）。
 *
 * @returns {Array<{path: string[], value?: *, remove?: boolean}>}
 */
function changedPaths(base, cur, prefix = [], out = []) {
  const b = isPlain(base) ? base : {};
  const c = isPlain(cur) ? cur : {};
  for (const k of Object.keys(c)) {
    const p = prefix.concat(k);
    if (!(k in b)) {
      out.push({ path: p, value: c[k] });
      continue;
    }
    if (isPlain(b[k]) && isPlain(c[k])) {
      changedPaths(b[k], c[k], p, out);
      continue;
    }
    if (JSON.stringify(b[k]) !== JSON.stringify(c[k])) out.push({ path: p, value: c[k] });
  }
  // 删掉一条渠道、清空一个字段，也是改动。只合并新增的话，界面上删掉的东西存一次就回来了
  for (const k of Object.keys(b)) if (!(k in c)) out.push({ path: prefix.concat(k), remove: true });
  return out;
}

/** 按路径把一处改动盖到 obj 上；路上缺的层补成对象 */
function applyAt(obj, keys, value, remove) {
  if (!isPlain(obj) || !keys.length) return obj;
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!isPlain(node[k])) node[k] = {};
    node = node[k];
  }
  const last = keys[keys.length - 1];
  if (remove) delete node[last];
  else node[last] = value;
  return obj;
}

/**
 * 把 cur 相对 base 的那些改动，盖到 disk 上（就地改 disk）。
 * @returns {{merged: object, changed: Array}} changed 是这次盖上去的清单，用来说人话：「本进程改了 N 处」
 */
function mergeOnto(disk, base, cur) {
  const changed = changedPaths(base, cur);
  for (const c of changed) applyAt(disk, c.path, c.value, c.remove);
  return { merged: disk, changed };
}

module.exports = { mtimeOf, snapshot, changedPaths, applyAt, mergeOnto };
