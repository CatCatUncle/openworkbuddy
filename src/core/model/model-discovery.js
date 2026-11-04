// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";

// Discovery uses the same URL/auth rules as real inference, including custom gateways.
const crypto = require("crypto");
const { pingRequest } = require("./llm");
const media = require("./media-models");

function listRequest({ base_url, api_key, api = "openai" }) {
  const ping = pingRequest({ base_url, api_key, provider: api, model: "discovery" });
  const url = ping.url.replace(/\/models\/discovery:generateContent$/, "/models")
    .replace(/\/api\/chat$/, "/api/tags")
    .replace(/\/(?:chat\/completions|responses|messages)$/, "/models");
  const headers = /** @type {Record<string, string>} */ ({ ...ping.headers });
  if (!api_key) delete headers.Authorization;
  return { url, headers };
}

/** Same host can expose different model permissions to different keys/protocols. Never cache by host alone. */
function cacheKey(input) {
  const { url } = listRequest(input);
  return crypto.createHash("sha256").update(JSON.stringify([url, input.api || "openai", input.api_key || ""])).digest("hex");
}

function modelRow(raw, api) {
  const m = typeof raw === "string" ? { id: raw } : raw || {};
  let id = String(m.id || m.model || m.name || "");
  if (api === "gemini") id = id.replace(/^models\//, "");
  const cap = media.capOfModel({ ...m, id });
  const row = /** @type {any} */ ({ id, cap: cap.cap, ...(cap.sure ? { sure: true } : {}) });
  const supported = m.api_supported;
  // An image/embedding/3D endpoint must never become the onboarding chat default.
  if (supported && Object.keys(supported).length) row.chat = !!(supported["chat/completions"] || supported.responses || supported.messages);
  else if (Array.isArray(m.supportedGenerationMethods)) row.chat = m.supportedGenerationMethods.includes("generateContent");
  else if (m.domain) row.chat = /^(LLM|VLM)$/i.test(m.domain);
  else if (/embed|rerank|seed3d|hitem3d|hyper3d/i.test(id)) row.chat = false;
  const tools = m.features && m.features.tools;
  if (tools && typeof tools.function_calling === "boolean") row.tools = tools.function_calling;
  return row;
}

/** A visible model is a candidate, not proof of permission/balance. Chat is verified separately with a tiny request. */
async function discover(input, fetcher = fetch) {
  const { url, headers } = listRequest(input);
  const r = await fetcher(url, { headers, redirect: "error", signal: AbortSignal.timeout(12000) });
  if (!r.ok) return { ok: false, status: r.status, why: `渠道没给列表（HTTP ${r.status}）`, models: [] };
  const j = /** @type {any} */ (await r.json());
  if (!j || typeof j !== "object") return { ok: false, why: "渠道返回的不是模型清单", models: [] };
  const out = j.output || {};
  const raw = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : Array.isArray(out.models) ? out.models : null;
  if (!raw) return { ok: false, why: "渠道返回的不是模型清单", models: [] };
  const seen = new Set();
  const models = raw.map(m => modelRow(m, input.api)).filter(m => {
    if (!m.id || seen.has(m.id)) return false;
    seen.add(m.id); return true;
  }).slice(0, 600);
  const total = Number(out.total || j.total || 0);
  const complete = !j.has_more && !j.nextPageToken && !j.next_page_token && !(total > raw.length) && raw.length <= 600;
  return { ok: true, models, complete };
}

module.exports = { listRequest, cacheKey, modelRow, discover };
