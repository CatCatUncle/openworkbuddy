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

/**
 * 用自己工作目录的人也能建多个项目（工作空间），一个项目一个文件夹，全在他自己那份工作目录里：
 *   - 默认项目就是工作目录本身（folder 为空）：以前的成果都摊在那儿，换个根等于把它们藏了；
 *   - 新建的放在 <工作目录>/projects/<文件夹>，文件夹名照项目名来（规则同 folderName），项目改名文件夹不动；
 *   - 不能另选文件夹：服务器上的路径不归他，选进别人那份就是串台。
 * 清单记在这张表他那一条里（projects / active），跟着账号改名走。不放进工作目录：那儿 agent 写得动，
 * 一句话就能把项目改指到别处去。
 */
const PROJECTS = "projects"; // task-dirs.js 的 appRoot 认同一个名字：这下面一层固定按对话分文件夹
const DEFAULT_PROJECT = "默认项目"; // 跟前端「没记项目的老会话算默认项目」同一个名字

/** 表里记的文件夹名信得过才用：一层、不带路径分隔符、不以点开头 */
function okFolder(f) {
  return typeof f === "string" && f.length > 0 && f.length <= 64 && !/[/\\:*?"<>|\0]/.test(f) && !f.startsWith(".") && f === path.basename(f);
}
function cleanProject(p) {
  if (!p || typeof p !== "object" || typeof p.name !== "string" || !p.name.trim()) return null;
  const folder = p.folder ? String(p.folder) : "";
  if (folder && !okFolder(folder)) return null;
  return { ...p, folder };
}

/** 这个账号自己的项目清单和当前项目。一个都没记过就是只有一个默认项目（就是他的工作目录） */
function projectsOf(username) {
  const e = table().users[username];
  let list = (e && Array.isArray(e.projects) ? e.projects : []).map(cleanProject).filter(Boolean);
  if (!list.length) list = [{ name: DEFAULT_PROJECT, folder: "" }];
  const active = e && list.some((p) => p.name === e.active) ? e.active : list[0].name;
  return { projects: list.map((p) => ({ ...p })), active };
}
function saveProjects(username, projects, active) {
  const db = load();
  const e = db.users[username];
  if (!e || !e.dir) throw new Error("你的工作目录还没分好，稍后再试");
  e.projects = projects;
  e.active = active;
  save(db);
  forget();
}
/** 新项目的文件夹名：照项目名来，跟清单里已有的撞了（不分大小写）就加 _2 */
function newFolder(projects, name) {
  const base = folderName(name);
  const used = new Set(projects.map((p) => String(p.folder || "").toLowerCase()).filter(Boolean));
  let f = base;
  for (let i = 2; used.has(f.toLowerCase()); i++) f = `${base}_${i}`;
  return f;
}
/**
 * 项目文件夹的绝对路径，建好并核实还在 home 里面；不在就抛。
 * 工作目录里的东西 agent 改得动：projects 或项目文件夹被换成指向别处的软链接，建之前先看一眼、建完再按真实路径核一遍
 */
function openProject(home, folder) {
  if (!folder) return home;
  if (!okFolder(folder)) throw new Error("项目文件夹名不合法");
  const parent = path.join(home, PROJECTS);
  const abs = path.join(parent, folder);
  for (const p of [parent, abs]) {
    let st = null;
    try { st = fs.lstatSync(p); } catch {}
    if (st && !st.isDirectory()) throw new Error("项目文件夹不是普通文件夹");
  }
  fs.mkdirSync(abs, { recursive: true });
  const realHome = fs.realpathSync.native(home);
  const real = fs.realpathSync.native(abs);
  if (!real.startsWith(realHome + path.sep)) throw new Error("项目文件夹不在你的工作目录里");
  return abs;
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

module.exports = { rootOf, homes, knownRootOf, accountsDir, rename, folderName, projectsOf, saveProjects, newFolder, openProject, PROJECTS, DEFAULT_PROJECT, _internals: { FILE, forget } };
