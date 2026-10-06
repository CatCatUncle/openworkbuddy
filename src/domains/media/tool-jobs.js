// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 直调生成（/api/tool/run）的收单台账：同一个 clientJobId 只真跑一次。
 *
 * 画布上点一下「生成」就是一笔钱。以前请求一断（网络抖一下、代理超时、页面刷新），服务端跟着叫停，
 * 画布那头看见「失败」又补一枪——可上游早就收下了第一单，照样出片、照样扣费，同一格买了两次。
 * 现在每一枪带一个画布自己起的 clientJobId：
 *   · 带了 id 的这一枪不跟请求同生死：连接断了它照样跑完，结果记在台账里；
 *   · 同一个 id 再来：还在跑就等它、跑完了就把那份结果原样交回去，一次上游都不再调；
 *   · 上游一收单就把任务号记进项目里的台账（.openworkbuddy/tool-jobs.json）。服务重启之后
 *     那一单查得到「收过单、任务号是几」，不会当成没发生过——只是收不回来了，见 toolJobLookup。
 * 查状态（GET /api/tool/job）只读台账，不开枪。
 *
 * 台账按人分：键是「用户名 + id」，别人拿到这个 id 也查不到、等不到这一单。
 * 读写全是同步的：同一个进程里几枪同时收尾也不会互相盖掉对方那一条。
 */
const fs = require("fs");
const path = require("path");

const JOB_KEEP_MS = 24 * 3600 * 1000;   // 留一天：断网回来、重启回来、第二天打开画布点「看结果」都还在
const JOB_MAX = 300;                    // 一个项目的台账最多这么多条，满了先丢最老的已收尾那几条
const JOB_TEXT_MAX = 4000;              // 回执原话留这么长：够贴在卡片上，台账不至于长成几兆
const JOB_ID_RE = /^[A-Za-z0-9_.:-]{8,80}$/;

const running = new Map();              // 键 → 这个进程里正在跑的那一枪（promise）
// 键 → 收尾时那份结果。台账写不进盘（磁盘满、目录只读）的时候靠它兜着：
// 不兜的话，同一个 id 再来一趟就查不到「跑过」，又开一枪
const recent = new Map();
const RECENT_MAX = 500;

/** 画布给的 id 认不认：长度 8–80、只有字母数字和 _ . : -。不认就当没带，照老规矩跑 */
function toolJobId(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  return JOB_ID_RE.test(s) ? s : "";
}

function toolJobKey(owner, id) { return `${String(owner || "")}|${id}`; }

/** 台账文件：跟着项目走（.openworkbuddy 下），开枪那一刻就定死，中途切项目也记回原来那一份 */
function toolJobFile(workspaceDir) { return path.join(String(workspaceDir || ""), ".openworkbuddy", "tool-jobs.json"); }

function toolJobRead(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data.jobs === "object" && data.jobs ? data : { version: 1, jobs: {} };
  } catch { return { version: 1, jobs: {} }; }
}

/** 过期的、超出条数的清掉。在跑的一条都不丢：丢了就查不到它收过单 */
function toolJobPrune(jobs, now = Date.now()) {
  const out = {};
  const keys = Object.keys(jobs).filter((k) => {
    const j = jobs[k];
    if (!j || typeof j !== "object") return false;
    if (j.state === "running") return true;
    return now - (Number(j.doneAt || j.at) || 0) < JOB_KEEP_MS;
  });
  const done = keys.filter((k) => jobs[k].state !== "running").sort((a, b) => (Number(jobs[a].doneAt || jobs[a].at) || 0) - (Number(jobs[b].doneAt || jobs[b].at) || 0));
  const drop = new Set(done.slice(0, Math.max(0, keys.length - JOB_MAX)));
  for (const k of keys) if (!drop.has(k)) out[k] = jobs[k];
  return out;
}

/** 改一条、整份写回：先写临时文件再改名，写到一半断电也只是少了这一笔，不会把整份台账写坏 */
function toolJobPatch(file, key, patch) {
  const data = toolJobRead(file);
  const cur = data.jobs[key] || {};
  data.jobs[key] = { ...cur, ...patch };
  data.jobs = toolJobPrune(data.jobs);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
  } catch (e) {
    // 台账写不进去不能拦着这一枪：钱的事以上游为准，台账只是给人回来查的。但得留痕
    console.warn(`[tool-jobs] 台账写不进去（${file}）：${e.message}`);
  }
  return data.jobs[key];
}

/** 台账里这一条对外长什么样：只给状态、任务号、时间，回执本身单独放在 response 里 */
function toolJobView(entry, { live = false } = {}) {
  if (!entry) return null;
  // 盘上写着「在跑」、这个进程里却没有它：服务重启过，那一枪没收完
  const state = entry.state === "running" && !live ? "interrupted" : entry.state;
  return {
    id: entry.id, tool: entry.tool || "", model: entry.model || "", state,
    submitted: entry.submitted || "", at: Number(entry.at) || 0, doneAt: Number(entry.doneAt) || 0,
  };
}

/** 回执压一压再记：content 留前 JOB_TEXT_MAX 个字，其余字段原样 */
function toolJobTrim(response) {
  if (!response || typeof response !== "object") return response;
  const body = response.body && typeof response.body === "object" ? { ...response.body } : {};
  if (typeof body.content === "string" && body.content.length > JOB_TEXT_MAX) body.content = body.content.slice(0, JOB_TEXT_MAX) + "…";
  if (typeof body.error === "string" && body.error.length > JOB_TEXT_MAX) body.error = body.error.slice(0, JOB_TEXT_MAX) + "…";
  return { status: Number(response.status) || 200, body };
}

/**
 * 查一单：{ job, response } 或 null（没这一单）。不开枪。
 * 在跑的 response 是 null；跑完的带当时那份回执；服务重启前没收完的 state 是 interrupted、response 是 null——
 * 媒体层眼下没有「拿任务号去上游补收」的口子，所以只能把任务号交给人，让他去渠道控制台查
 */
function toolJobLookup({ file, owner, id }) {
  const key = toolJobKey(owner, id);
  const live = running.has(key);
  const entry = toolJobRead(file).jobs[key];
  if (!entry && !live && recent.has(key)) { const r = recent.get(key); return { job: r.job, response: { status: r.status, body: r.body } }; }
  if (!entry) return live ? { job: { id, state: "running", submitted: "", at: 0, doneAt: 0 }, response: null } : null;
  const job = toolJobView(entry, { live });
  return { job, response: job.state === "running" || job.state === "interrupted" ? null : entry.response || null };
}

/**
 * 跑一单，或者认出这一单已经跑过 / 正在跑。
 *
 *   exec({ onSubmitted }) → Promise<{ status, body }>：真去开枪的那一下。body 里 submitted 非空 = 上游收过单。
 *   返回 Promise<{ status, body, job, replayed }>：replayed=true 表示这一趟没开枪，交回的是同一单的结果。
 *
 * exec 抛错也收成一份回执（500 + 原话），台账照样记「收尾了」：调用方不必再包一层 try
 */
async function toolJobRun({ file, owner, id, tool, model, exec }) {
  const key = toolJobKey(owner, id);
  // 同一个进程里还在跑：等它，交回它的结果，不再开第二枪
  if (running.has(key)) {
    const out = await running.get(key);
    return { ...out, replayed: true };
  }
  if (recent.has(key)) return { ...recent.get(key), replayed: true };
  const before = toolJobRead(file).jobs[key];
  if (before) {
    const job = toolJobView(before, { live: false });
    // 收尾过的：原样交回。没收尾的（重启前在跑）：不重开——那一单可能已经在上游渲染、扣费
    if (job.state === "interrupted") {
      return { status: 409, body: { error: `这一单服务重启前没收完${job.submitted ? `（上游任务号 ${job.submitted}）` : ""}，没有再发一次。`, submitted: job.submitted, isError: true, ok: false }, job, replayed: true };
    }
    const r = before.response || { status: 200, body: {} };
    return { status: r.status, body: r.body, job, replayed: true };
  }
  const at = Date.now();
  toolJobPatch(file, key, { id, owner: String(owner || ""), tool: String(tool || ""), model: String(model || ""), state: "running", at, submitted: "" });
  const onSubmitted = (info) => {
    const taskId = String((info && info.taskId) || info || "");
    if (!taskId) return;
    toolJobPatch(file, key, { submitted: taskId, proto: String((info && info.proto) || ""), submittedAt: Date.now() });
  };
  const work = (async () => {
    let out;
    try { out = toolJobTrim(await exec({ onSubmitted })); }
    catch (e) { out = { status: Number(e && e.status) || 500, body: { error: String((e && e.message) || e) } }; }
    const body = out.body || {};
    const ok = out.status < 400 && !body.isError && body.ok !== false;
    const cur = toolJobRead(file).jobs[key] || {};
    const submitted = String(body.submitted || cur.submitted || "");
    const entry = toolJobPatch(file, key, { state: ok ? "done" : "failed", doneAt: Date.now(), submitted, response: out });
    const done = { ...out, job: toolJobView(entry || { id, tool, model, state: ok ? "done" : "failed", at, doneAt: Date.now(), submitted }, { live: false }) };
    recent.set(key, done);
    while (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
    return done;
  })();
  running.set(key, work);
  try { return { ...(await work), replayed: false }; }
  finally { running.delete(key); }
}

module.exports = {
  toolJobId, toolJobKey, toolJobFile, toolJobRead, toolJobPrune, toolJobPatch, toolJobView, toolJobLookup, toolJobRun,
  JOB_KEEP_MS, JOB_MAX,
  _internals: { running, recent },
};
