// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 多人服务器上，哪些连接器和技能不给成员用。
 *
 * 平台管理员装的默认全员共享，老配置照旧。这里记的是例外：
 * config.member_off = { mcp: [服务器名], skills: [技能名] }。
 * 比如财务连接器只留给管理员。没写就是都共享。
 * 平台管理员和单人模式不受影响。
 */
const security = require("../safety/security");

const KINDS = Object.freeze(["mcp", "skills"]);

/** @param {any} config @param {string} kind @returns {string[]} */
function offList(config, kind) {
  const list = config && config.member_off && config.member_off[kind];
  return Array.isArray(list) ? list.filter((name) => typeof name === "string") : [];
}

/** 这个账号算不算受限成员。查不到账号时按成员算，跟沙箱那边同一个取舍 */
function restricted(/** @type {any} */ who) {
  if (!security.isMultiUser()) return false;
  const name = who && typeof who === "object" ? (who.username || who.name || who.id) : who;
  return !name || !security.isPlatformAdmin(name);
}

/** @param {any} config @param {string} kind @param {string} name @param {any} who */
function hidden(config, kind, name, who) {
  return offList(config, kind).includes(name) && restricted(who);
}

/** @param {any} config @param {string} kind @param {string} name @param {boolean} shared */
function setShared(config, kind, name, shared) {
  if (!KINDS.includes(kind)) throw new Error("只能设置连接器和技能");
  const label = String(name || "").trim();
  if (!label || label.length > 200) throw new Error("名字不对");
  const rest = offList(config, kind).filter((item) => item !== label);
  const next = shared ? rest : [...rest, label];
  config.member_off = { ...(config.member_off || {}), [kind]: next };
  if (!next.length) delete config.member_off[kind];
  if (!Object.keys(config.member_off).length) delete config.member_off;
}

module.exports = { KINDS, offList, restricted, hidden, setShared };
