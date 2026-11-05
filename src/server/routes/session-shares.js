// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const express = require("express");
const shares = require("../../domains/account/session-shares");

function createSessionSharesRouter({ store, multiUser, sessionOf, ownerOf, orgOf, memberOf, sanitize, enabled = false }) {
  const app = express.Router({ caseSensitive: true });
  const headers = (_req, res, next) => { res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" }); next(); };
  app.use(["/api/session/:id/share", "/api/session-shares"], headers);
  app.use(["/api/session/:id/share", "/api/session-shares"], (_req, res, next) => {
    if (!(typeof enabled === "function" ? enabled() : enabled)) return res.status(404).json({ error: "对话分享暂未开放", disabled: true });
    next();
  });
  const own = (req, res) => {
    if (!multiUser()) { res.status(403).json({ error: "单人模式不提供组织分享" }); return null; }
    const s = shares.SID.test(req.params.id) && sessionOf(req.params.id);
    if (!s) { res.status(404).json({ error: "这个任务已经不在了" }); return null; }
    if (!req.user || ownerOf(s) !== req.user.username) { res.status(403).json({ error: "只能分享或撤回自己的任务" }); return null; }
    return s;
  };
  const view = (row) => ({ active: !!row, ...(row ? { url: "/shared.html#" + row.token, created_at: row.created_at } : {}) });
  app.get("/api/session/:id/share", (req, res) => { if (own(req, res)) res.json(view(store.find(req.params.id, req.user.username, orgOf(req.user)))); });
  app.post("/api/session/:id/share", (req, res) => { if (own(req, res)) res.json(view(store.create(req.params.id, req.user.username, orgOf(req.user)))); });
  app.delete("/api/session/:id/share", (req, res) => { if (own(req, res)) { store.revoke(req.params.id, req.user.username, orgOf(req.user)); res.json({ active: false }); } });
  function shared(req, res) {
    const row = multiUser() && req.user && store.get(req.params.token);
    const owner = row && memberOf(row.org, row.owner);
    const s = row && sessionOf(row.sid);
    if (!row || orgOf(req.user) !== row.org || !owner || owner.status !== "active" || !s || ownerOf(s) !== row.owner) { res.status(404).json({ error: "分享已撤回或当前账号无权查看" }); return null; }
    return s;
  }
  app.get("/api/session-shares/:token", (req, res) => { const s = shared(req, res); if (s) res.json(shares.publicTask(s, sanitize)); });
  app.get("/api/session-shares/:token/file", (req, res) => {
    const s = shared(req, res); if (!s) return;
    const name = typeof req.query.path === "string" ? req.query.path : "";
    const r = shares.resolveDelivered(s, name);
    if (!r) return res.status(404).json({ error: "这个文件已经不在分享中" });
    res.set("Content-Security-Policy", "sandbox; default-src 'none'");
    res.download(r.file, require("path").basename(name));
  });
  app.use((_error, _req, res, _next) => res.status(503).json({ error: "分享记录暂时不可用，请稍后重试" }));
  return app;
}
module.exports = { createSessionSharesRouter };
