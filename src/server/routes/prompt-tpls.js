// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 参考模板库里自己加的那几层：
 *   GET    /api/prompt-tpls                  我的 + 公司的 + 两层各自藏掉的内置模板
 *   POST   /api/prompt-tpls                  新建 / 改一条（scope: mine | org）
 *   DELETE /api/prompt-tpls/:scope/:id       删一条
 *   POST   /api/prompt-tpls/hidden           藏起 / 放回一条内置模板
 *
 * 三层，谁能改谁看得见各不相同：
 *   · 内置：写死在前端 PROMPT_TPLS 里，谁都改不了。点「改」其实是存一份副本，再把原来那条藏起来
 *   · 我的：每个账号一份，只有本人看得见、改得了。存在 data/prompt-tpls/users/<账号键>.json
 *   · 公司：每个组织一份，全组织看得见，只有管理员（admin.write）改得了，改动进组织审计。
 *     存在 data/prompt-tpls/orgs/<组织 id>.json。个人桌面版没有「公司」这回事，这一层整个不给
 *
 * 管理员藏掉的内置模板对全组织生效，成员藏掉的只对自己生效；成员放不回管理员藏的。
 *
 * 这个接口不在 admin.platformGuard 的写表里（那张表管的是整台服务器一份的设置），
 * 所以「公司」这一层的权限得在这儿自己判，不能指望前面那道闸。
 *
 * 写法照 src/server/routes/library.js：路由写在顶层、依赖由 createPromptTplsRouter(deps) 一次填上，
 * 不回头 require server.js。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const store = require("../../platform/store");
const prefs = require("../../core/config/prefs");
const { dataPath } = require("../../platform/paths");

// OPENWORKBUDDY_DATA_DIR 跟 account.js / prefs.js 同一个口子：跑测试时指到临时目录
const baseDir = () => path.join(process.env.OPENWORKBUDDY_DATA_DIR || dataPath("data"), "prompt-tpls");

const MAX_ITEMS = 200;     // 一层最多存多少条。再多就不是「参考」了，是另一个资料库
const MAX_HIDDEN = 100;
const LIMIT = { t: 40, c: 12, d: 80, p: 8000 };
const BUILTIN_ID = /^b-[a-z0-9-]{1,40}$/;

// 下面这几个由 createPromptTplsRouter(deps) 填上
let isSolo = () => false;
let canEditOrg = () => false;
let orgIdOf = () => "default";
let orgName = () => "";
let audit = () => {};

function fileOf(scope, user) {
  if (scope === "mine") {
    const k = prefs.keyOf(user);
    return k ? path.join(baseDir(), "users", k + ".json") : "";
  }
  const id = String(orgIdOf(user) || "");
  // 组织 id 是服务端自己发的，照理不会带怪字符；还是夹一道，别让它拼出目录外的路径
  return /^[\w-]{1,64}$/.test(id) ? path.join(baseDir(), "orgs", id + ".json") : "";
}

function load(scope, user) {
  const f = fileOf(scope, user);
  const raw = f ? store.readJson(f, null) : null;
  const items = Array.isArray(raw && raw.items) ? raw.items.filter((x) => x && typeof x.id === "string") : [];
  const hidden = Array.isArray(raw && raw.hidden) ? raw.hidden.filter((x) => BUILTIN_ID.test(x)) : [];
  return { items, hidden };
}

function save(scope, user, data) {
  const f = fileOf(scope, user);
  if (!f) throw new Error("没认出是谁，存不了");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  store.writeJsonAtomic(f, { items: data.items, hidden: data.hidden }, { pretty: true });
}

/** 这一层这个人能不能写。不能写时返回一句给人看的原因 */
function writeProblem(scope, user) {
  if (scope === "mine") return "";
  if (scope !== "org") return "没有这一层";
  if (isSolo()) return "个人桌面版没有公司模板";
  if (!canEditOrg(user)) return "公司模板只有管理员能改";
  return "";
}

function clean(b) {
  const s = (k) => String((b && b[k]) == null ? "" : b[k]).trim();
  const t = s("t"), c = s("c"), d = s("d");
  const p = String((b && b.p) == null ? "" : b.p).replace(/\r\n/g, "\n").trim();
  if (!t) throw new Error("标题不能空着");
  if (!p) throw new Error("提示词不能空着");
  if (t.length > LIMIT.t) throw new Error(`标题最多 ${LIMIT.t} 个字`);
  if (c.length > LIMIT.c) throw new Error(`分类最多 ${LIMIT.c} 个字`);
  if (d.length > LIMIT.d) throw new Error(`说明最多 ${LIMIT.d} 个字`);
  if (p.length > LIMIT.p) throw new Error(`提示词最多 ${LIMIT.p} 个字`);
  const icon = /^[a-z0-9-]{1,32}$/.test(s("icon")) ? s("icon") : "file-text";
  return { t, c: c || "其他", d, p, icon };
}

function view(user) {
  const mine = load("mine", user);
  const orgOn = !isSolo();
  return {
    mine,
    org: orgOn ? { ...load("org", user), name: orgName(user) } : null,
    can_edit_org: orgOn && !!canEditOrg(user),
  };
}

function upsert(user, b) {
  const scope = b && b.scope;
  const why = writeProblem(scope, user);
  if (why) throw Object.assign(new Error(why), { status: scope === "org" ? 403 : 400 });
  const fields = clean(b);
  const data = load(scope, user);
  const now = new Date().toISOString();
  let item;
  if (b.id) {
    item = data.items.find((x) => x.id === b.id);
    if (!item) throw Object.assign(new Error("这条模板已经不在了，可能刚被删掉"), { status: 404 });
    Object.assign(item, fields, { updated_at: now });
  } else {
    if (data.items.length >= MAX_ITEMS) throw new Error(`这一层已经存了 ${MAX_ITEMS} 条，删掉几条再加`);
    item = { id: (scope === "org" ? "o-" : "u-") + crypto.randomBytes(6).toString("hex"), ...fields, created_at: now, updated_at: now };
    if (scope === "org") item.by = user.username;
    data.items.unshift(item);
  }
  // 从内置模板改过来的：副本存好的同一步把原来那条藏起来，两步分开的话中间失败就是一式两份
  if (b.hide && BUILTIN_ID.test(b.hide) && !data.hidden.includes(b.hide) && data.hidden.length < MAX_HIDDEN) data.hidden.push(b.hide);
  save(scope, user, data);
  if (scope === "org") {
    audit({ org: orgIdOf(user), actor: user.username, action: b.id ? "改公司模板" : "加公司模板", target: item.t,
      detail: b.hide ? "照内置模板改的，原来那条对全组织藏起" : "" });
  }
  return item;
}

function remove(user, scope, id) {
  const why = writeProblem(scope, user);
  if (why) throw Object.assign(new Error(why), { status: scope === "org" ? 403 : 400 });
  const data = load(scope, user);
  const i = data.items.findIndex((x) => x.id === id);
  if (i < 0) throw Object.assign(new Error("这条模板已经不在了"), { status: 404 });
  const [gone] = data.items.splice(i, 1);
  save(scope, user, data);
  if (scope === "org") audit({ org: orgIdOf(user), actor: user.username, action: "删公司模板", target: gone.t });
  return gone;
}

function setHidden(user, scope, id, on) {
  const why = writeProblem(scope, user);
  if (why) throw Object.assign(new Error(why), { status: scope === "org" ? 403 : 400 });
  if (!BUILTIN_ID.test(String(id || ""))) throw new Error("只有内置模板能藏起来，自己加的直接删");
  const data = load(scope, user);
  const had = data.hidden.includes(id);
  if (on && !had) {
    if (data.hidden.length >= MAX_HIDDEN) throw new Error("藏的太多了，放回几条再藏");
    data.hidden.push(id);
  } else if (!on && had) {
    data.hidden = data.hidden.filter((x) => x !== id);
  } else {
    return data.hidden; // 本来就是这个状态，不写盘、不记审计
  }
  save(scope, user, data);
  if (scope === "org") audit({ org: orgIdOf(user), actor: user.username, action: on ? "对全组织藏起内置模板" : "放回内置模板", target: id });
  return data.hidden;
}

function send(res, fn) {
  try {
    res.json(fn());
  } catch (e) {
    res.status((e && e.status) || 400).json({ error: (e && e.message) || "没存上" });
  }
}

const router = express.Router();
router.get("/api/prompt-tpls", (req, res) => send(res, () => view(req.user)));
router.post("/api/prompt-tpls", (req, res) => send(res, () => ({ ok: true, item: upsert(req.user, req.body || {}) })));
router.post("/api/prompt-tpls/hidden", (req, res) => send(res, () => {
  const b = req.body || {};
  return { ok: true, hidden: setHidden(req.user, b.scope, b.id, b.hidden !== false) };
}));
router.delete("/api/prompt-tpls/:scope/:id", (req, res) => send(res, () => {
  remove(req.user, req.params.scope, req.params.id);
  return { ok: true };
}));

/**
 * @param deps.isSolo      () => 是不是个人桌面版（是的话没有「公司」这一层）
 * @param deps.canEditOrg  (user) => 能不能改本组织的公司模板
 * @param deps.orgIdOf     (user) => 组织 id
 * @param deps.orgName     (user) => 组织名，界面上标「公司」那一层用
 * @param deps.audit       ({org, actor, action, target, detail}) => 记组织审计
 */
function createPromptTplsRouter(deps) {
  ({ isSolo, canEditOrg, orgIdOf, orgName, audit } = { isSolo, canEditOrg, orgIdOf, orgName, audit, ...deps });
  return router;
}

module.exports = { createPromptTplsRouter, view, upsert, remove, setHidden, MAX_ITEMS, LIMIT };
