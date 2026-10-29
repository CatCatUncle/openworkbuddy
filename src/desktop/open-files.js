// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const path = require("path"), crypto = require("crypto");
const EXTENSIONS = "html htm md markdown txt csv tsv json xml pdf doc docx docm dotx dotm xls xlsx xlsm xltx ppt pptx pptm ppsx wps wpt et ett dps dpt ofd ceb cebx rtf odt ods odp png jpg jpeg webp svg".split(" ");
const pending = new Map();
function offer(files, now = Date.now()) {
  for (const [key, entry] of pending) if (now - entry.at > 15 * 60 * 1000) pending.delete(key);
  const accepted = [...new Set(files.filter(f => typeof f === "string" && path.isAbsolute(f) && EXTENSIONS.includes(path.extname(f).slice(1).toLowerCase())))].slice(0, 20);
  if (!accepted.length) return "";
  const token = crypto.randomBytes(24).toString("hex");
  pending.set(token, { files: accepted, at: now });
  while (pending.size > 32) pending.delete(pending.keys().next().value);
  return token;
}
function take(token, now = Date.now()) {
  const entry = pending.get(token); pending.delete(token);
  return entry && now - entry.at <= 15 * 60 * 1000 ? entry.files : [];
}
module.exports = { EXTENSIONS, offer, take };
