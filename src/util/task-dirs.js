// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 成果按对话分文件夹：哪些根下分、文件夹叫什么。
 *
 * 以前只认一个根——默认工作空间（~/OpenWorkBuddy/workspace）。于是装好之后随手建个项目，
 * 哪怕目录一个字没填（落在 ~/OpenWorkBuddy/projects/<名>），从那以后所有对话的产出全摊在项目根下，
 * 两条对话各写一份「报告.html」，后写的那份就把先写的盖了。飞书/微信来的所有对话挤一个 IM_对话/，
 * 所有定时任务挤一个 定时任务/，同样不分对话。
 *
 * 现在的口径：**应用自己建的根**一律按对话分——默认工作空间、没填目录时替项目建的 projects/<名>、
 * 没指定目录的租户根 tenants/<id>。用户自己挑的现成文件夹（代码仓库、素材目录）照旧就地读写：
 * 那里的文件本来就在根上，在里面再套一层「任务_xxx」反倒把人要改的东西和产出拆散了。
 *
 * 路径比较先认真实路径、再看大小写：macOS / Windows 的盘默认不分大小写，
 * 选文件夹时拼成 ~/openworkbuddy/workspace 也还是同一个地方，不能因此判成「用户自选」。
 */
const fs = require("fs");
const path = require("path");

const CASE_FOLD = process.platform === "darwin" || process.platform === "win32";

/** 比较用的规范形：已存在的那一截换成真实路径（/tmp 和 /private/tmp 是同一个），不存在的尾巴原样接上 */
function canonDir(p) {
  let cur = path.resolve(String(p || ""));
  const rest = [];
  for (;;) {
    try { cur = fs.realpathSync.native(cur); break; } catch {}
    const up = path.dirname(cur);
    if (up === cur) break;
    rest.unshift(path.basename(cur));
    cur = up;
  }
  const out = path.join(cur, ...rest);
  return CASE_FOLD ? out.toLowerCase() : out;
}

function samePlace(a, b) {
  if (!a || !b) return false;
  return canonDir(a) === canonDir(b);
}

/**
 * 这个根下要不要按对话分成果文件夹。
 * @param {string} dir 当前工作目录
 * @param {{ workspace: string, projects?: string, tenants?: string }} anchors
 *   workspace = 默认工作空间；projects / tenants = 应用替人建目录的那两个父目录（其下一层才算）
 */
function perChatRoot(dir, anchors) {
  if (!dir || !anchors || !anchors.workspace) return false;
  const d = canonDir(dir);
  if (d === canonDir(anchors.workspace)) return true;
  const parent = path.dirname(d);
  return [anchors.projects, anchors.tenants].some((p) => !!p && parent === canonDir(p));
}

// 素材锚点（【图片 1：IMG_8037.JPG】）是发送时自动补进正文的，不是用户写的字
const ANCHOR = /【(?:图片|视频|音频|文本摘录|文件)\s*\d+：([^】]+)】/gu;
const clean = (t) => String(t).replace(/https?:\/\/\S+/g, "").replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 12);

/**
 * 文件夹名里那段标题：最多 12 个字，只留文字和数字。一个字都剩不下时返回空串，由调用方兜底。
 * 【任务类型：X】前缀和素材锚点先洗掉——不洗的话真实数据里出现过「任务_0826_任务类型数据分析及可视化_3」
 * 和「任务_0921_图片1IMG8037JP」，用户真正问的那句一个字都没进名字。
 * 只拖了张图、一个字没写：拿文件名（去掉扩展名）兜底。
 */
function taskSlug(text) {
  const raw = String(text || "");
  const src = raw.replace(/^\s*【任务类型：[^】]*】\s*/, "").replace(ANCHOR, " ");
  const firstName = ((raw.match(/【(?:图片|视频|音频|文本摘录|文件)\s*\d+：([^】]+)】/u) || [])[1] || "").replace(/\.[^.]+$/, "");
  return clean(src) || clean(firstName);
}

/** 「月日」四位，文件夹名用 */
function dayStamp(d = new Date()) {
  return String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}

/**
 * 在 root 下挑一个还没人用的相对目录名：base、base_2、base_3……
 * taken 是「刚分出去、还没写出文件」的那批（两个新对话同时起步不许撞同名）
 * @param {string} root
 * @param {string} base 相对 root 的路径，可以带一层父目录（IM_对话/0930_做个海报）
 * @param {Set<string>} [taken]
 */
function freeDir(root, base, taken) {
  let dir = base;
  for (let i = 2; fs.existsSync(path.join(root, dir)) || (taken && taken.has(dir)); i++) dir = `${base}_${i}`;
  return dir;
}

/**
 * 一趟跑完什么都没产出，就把刚建的空文件夹撤掉（连同变空了的父目录，如 IM_对话/）。
 * 用 rmdirSync 而不是 rm -r：它删不掉非空目录，判断万一有误，最坏也只是删不动。
 * @returns {boolean} 文件夹现在是否已经不在了
 */
function dropIfEmpty(root, rel) {
  if (!root || !rel) return false;
  const full = path.join(root, rel);
  try {
    if (fs.existsSync(full)) {
      if (fs.readdirSync(full).length) return false;
      fs.rmdirSync(full);
    }
  } catch { return false; }
  // 父目录只收到 root 为止，一层都不越过去
  let up = path.dirname(full);
  while (up !== root && up.startsWith(root + path.sep)) {
    try { if (fs.readdirSync(up).length) break; fs.rmdirSync(up); } catch { break; }
    up = path.dirname(up);
  }
  return true;
}

/* ---------- 一条会话在某个根下的成果文件夹 ----------
 * 网页对话和命令行会话是同一份会话文件（data/sessions/<id>.json），记的也是同一组字段：
 * dir = 正用着的那格（相对 root），root = 那格在哪个根下，dirs = 以前在别的根下用过的格（按根的规范形记）。
 * 两头各写一套的话，终端里起头、网页上接着聊，就会认不回同一格。
 * defaultRoot：老会话没记 root 的，那时只有默认工作空间会分文件夹，按它算。 */

/** 会话正用着的那格是不是在 root 下 */
function sessDirIn(sess, root, defaultRoot) {
  return !!(sess && sess.dir) && samePlace(sess.root || defaultRoot, root);
}
/** 会话在 root 下的那格：正用着的，或者以前在这个根下用过、盘上还在的；都没有给 null */
function sessDirAt(sess, root, defaultRoot) {
  if (sessDirIn(sess, root, defaultRoot)) return sess.dir;
  const d = sess && sess.dirs ? sess.dirs[canonDir(root)] : null;
  return d && fs.existsSync(path.join(root, d)) ? d : null;
}
/** 换走 dir 之前按根记一笔（最多记 20 个根，先进先出） */
function stashSessDir(sess, defaultRoot) {
  if (!sess || !sess.dir) return;
  const dirs = sess.dirs || (sess.dirs = {});
  const k = canonDir(sess.root || defaultRoot);
  delete dirs[k];
  dirs[k] = sess.dir;
  for (const old of Object.keys(dirs).slice(0, -20)) delete dirs[old];
}
/** root 下这条会话已经有自己的那格就接着用它；返回用上没有 */
function useSessDirAt(sess, root, defaultRoot) {
  if (sessDirIn(sess, root, defaultRoot)) return true;
  const d = sessDirAt(sess, root, defaultRoot);
  if (!d) return false;
  stashSessDir(sess, defaultRoot);
  sess.dir = d;
  sess.root = root;
  return true;
}
/**
 * 给会话在 root 下起一格新的（任务_月日_标题），记进会话，建好目录。返回相对名。
 * @param {Set<string>} [taken] 刚分出去、还没写出文件的那批
 */
function newSessDir(sess, root, defaultRoot, text, taken) {
  const slug = taskSlug((sess && sess.title) || text) || "对话";
  const dir = freeDir(root, `任务_${dayStamp()}_${slug}`, taken);
  if (taken) taken.add(dir);
  stashSessDir(sess, defaultRoot); // 上一个根下的那格记着，回那边时接着用
  sess.dir = dir;
  sess.root = root;
  try { fs.mkdirSync(path.join(root, dir), { recursive: true }); } catch {}
  return dir;
}

/**
 * 这条会话以前在 root 下、但不在任何对话文件夹里写过的文件（相对 root），新的在前，最多 limit 个。
 *
 * 分文件夹以前的老会话，产出摊在根上；现在接着聊，新产出进新的那格。两件事得跟上，不然一条对话就拆成两半：
 * 「把报告.md 再改改」整篇重写时要写回根上那份（不是在新格里另起第二份），成果面板的「本对话」也得摆出它们。
 * 不搬老文件：根上同名的那份可能两条对话都写过，搬给哪条都是替人做主。
 * 认的是会话自己 files 事件里的 changed（这一轮写过谁）：带 root 的按根的指纹比，老到没带 root 的只认默认工作空间。
 * @param {any} sess
 * @param {string} root
 * @param {string} defaultRoot
 * @param {string} key 当前根的指纹（tools.workspaceKeyOf(root)）
 */
function flatOutputs(sess, root, defaultRoot, key, limit = 200) {
  if (!sess || !Array.isArray(sess.transcript)) return [];
  const isDefault = samePlace(root, defaultRoot);
  const mine = new Set([sess.dir, ...Object.values(sess.dirs || {})].filter(Boolean).map((d) => String(d).split("/")[0]));
  const out = [];
  for (let i = sess.transcript.length - 1; i >= 0 && out.length < limit; i--) {
    const evs = (sess.transcript[i] && sess.transcript[i].events) || [];
    for (let j = evs.length - 1; j >= 0 && out.length < limit; j--) {
      const ev = evs[j];
      if (!ev || ev.type !== "files" || (ev.root ? ev.root !== key : !isDefault)) continue;
      for (const n of ev.changed || []) {
        const name = String(n || "");
        const top = name.split("/")[0];
        if (!name || path.isAbsolute(name) || top === ".." || mine.has(top) || /^任务_\d{4}_/.test(top) || out.includes(name)) continue;
        out.push(name);
      }
    }
  }
  return out;
}

module.exports = {
  canonDir, samePlace, perChatRoot, taskSlug, dayStamp, freeDir, dropIfEmpty,
  sessDirIn, sessDirAt, stashSessDir, useSessDirAt, newSessDir, flatOutputs,
};
