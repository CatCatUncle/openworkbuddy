// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 账号自己的工作目录（不止一个账号时）。
 *
 * 谁用自己的、谁留在原来那份共享根上，判据在 admin.js 的 keepsSharedSpace；这里只管「自己的那份在哪」。
 *
 * 放哪：
 *   - 默认组织：<数据根>/accounts/<文件夹>。不放进 data/：沙箱把整个 data/ 当密区（账号、Key 都在里面），
 *     工作目录落在那下面，run_shell 连当前目录都进不去。也不放进老主人的工作目录：那是别人的根，
 *     他一列文件就全看见了（同 org.js 红线 2）。
 *   - 租户组织：组织根下一层（<root_dir>/<文件夹>，没配就是 data/tenants/<id>/<文件夹>）。
 *     租户里没人留在组织根上，嵌在里面不漏。
 *
 * 文件夹名照账号名来，人在访达里一眼认得出是谁的：文件系统不认的字符换成 _；
 * 大小写不敏感的盘上 Bob 和 bob 是同一个文件夹，所以撞名一律按不分大小写判，后来的加 _2。
 * 第一次分配时记进 data/account-spaces.json，之后只认这张表：账号改名、别处冒出同名文件夹，都不再变。
 * 表里的条目不删：删掉的账号，文件夹还在盘上，名字也不能让给后来的人。
 */

const fs = require("fs");
const path = require("path");
const { dataPath } = require("../../platform/paths");
const store = require("../../platform/store");
const org = require("./org");

// 跟 account.js / org.js 同一个口子：跑测试时指到临时目录
const DATA_DIR = process.env.OPENWORKBUDDY_DATA_DIR || dataPath("data");
const FILE = path.join(DATA_DIR, "account-spaces.json");

/** 默认组织各账号的工作目录都在这下面一层 */
function accountsDir() {
  return dataPath("accounts");
}

function load() {
  const d = store.readJson(FILE, { users: {} });
  return { users: (d && d.users && typeof d.users === "object" && d.users) || {} };
}
function save(db) {
  store.writeJsonAtomic(FILE, db, { pretty: true });
}

/** 这个组织的个人目录挂在哪一层 */
function parentOf(o) {
  if (!o || o.id === org.DEFAULT_ORG) return accountsDir();
  return path.resolve(org.rootDirOf(o, ""));
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i; // Windows 上这几个名字建不出文件夹，带扩展名也不行
/** 账号名 → 文件夹名（还没去重） */
function folderName(username) {
  let s = String(username || "").normalize("NFC").replace(/[^\w一-龥.-]/g, "_");
  // 开头结尾的点：.. 会跳到上一层，结尾的点 Windows 会悄悄吃掉；开头的 - 拿去拼命令会被当成选项
  s = s.replace(/^[.]+|[.]+$/g, "").replace(/^-/, "_").slice(0, 40).replace(/[.]+$/, "");
  if (!s) s = "user";
  if (RESERVED.test(s.split(".")[0])) s = s.replace(/^[^.]*/, (m) => m + "_");
  return s;
}

/** 在 parent 下给 base 挑一个没被占的名字：表里同组织的、盘上已有的，都按不分大小写比 */
function pick(parent, db, orgId, base) {
  const used = new Set();
  for (const e of Object.values(db.users)) if (e && e.org === orgId && e.dir) used.add(String(e.dir).toLowerCase());
  try { for (const n of fs.readdirSync(parent)) used.add(n.toLowerCase()); } catch {}
  let dir = base;
  for (let i = 2; used.has(dir.toLowerCase()); i++) dir = `${base}_${i}`;
  return dir;
}

// 每个请求都要问一次，读盘的结果记两秒；分配、改名当场作废
let memo = { at: 0, db: /** @type {{users: Record<string, any>}|null} */ (null) };
function table() {
  const now = Date.now();
  if (memo.db && now - memo.at < 2000) return memo.db;
  memo = { at: now, db: load() };
  return memo.db;
}
function forget() {
  memo = { at: 0, db: null };
  homesMemo = { at: 0, list: [] };
}

/**
 * 这个账号自己的工作目录（绝对路径），第一次问时分配并建好。
 * 算不出来就抛：调用方必须拦下这条请求，不能退回共享根——退回去就是把别人的文件摆到他眼前。
 * @param {{ username: string, org?: string }} user
 * @param {{ id: string }} [known] 调用方手上已经读好的这个人的组织（请求上挂着的那份），省一次读 orgs.json
 */
function rootOf(user, known) {
  if (!user || !user.username) throw new Error("没有登录账号");
  const id = org.orgIdOf(user);
  const o = known && known.id === id ? known : org.getOrg(id);
  const parent = parentOf(o);
  let e = table().users[user.username];
  if (!e || e.org !== o.id || !e.dir) {
    const db = load(); // 分配前重读一遍，别拿两秒前的旧表盖掉刚分出去的名字
    e = db.users[user.username];
    if (!e || e.org !== o.id || !e.dir) {
      e = { org: o.id, dir: pick(parent, db, o.id, folderName(user.username)), at: new Date().toISOString() };
      db.users[user.username] = e;
      save(db);
    }
    forget();
  }
  const abs = path.join(parent, e.dir);
  if (path.dirname(abs) !== parent) throw new Error("个人目录名不合法");
  if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
  return abs;
}

/** 已经分出去的个人目录（含删掉的账号留下的），不建、不查盘 */
let homesMemo = { at: 0, list: /** @type {string[]} */ ([]) };
function homes() {
  const now = Date.now();
  if (now - homesMemo.at < 2000) return homesMemo.list;
  const list = [];
  try {
    const orgs = new Map(org.listOrgs().map((o) => [o.id, o]));
    for (const e of Object.values(table().users)) {
      if (!e || !e.dir) continue;
      const o = orgs.get(e.org || org.DEFAULT_ORG);
      if (!o) continue; // 组织已经删了：它的根不归任何人，别人也绑不到那儿
      list.push(path.join(parentOf(o), e.dir));
    }
  } catch {}
  homesMemo = { at: now, list };
  return list;
}

/** 这个账号已经分到的个人目录；没分过回空串（不分配） */
function knownRootOf(username) {
  const e = table().users[username];
  if (!e || !e.dir) return "";
  try {
    const o = org.getOrg(e.org || org.DEFAULT_ORG);
    if (o.id !== (e.org || org.DEFAULT_ORG)) return "";
    return path.join(parentOf(o), e.dir);
  } catch { return ""; }
}

/** 账号改名：表里换键，文件夹名不动 */
function rename(oldName, newName) {
  const db = load();
  if (!db.users[oldName] || db.users[newName]) return;
  db.users[newName] = db.users[oldName];
  delete db.users[oldName];
  save(db);
  forget();
}

module.exports = { rootOf, homes, knownRootOf, accountsDir, rename, folderName, _internals: { FILE, forget } };
