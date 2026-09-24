"use strict";
/**
 * 一键合成的两条接口：/api/canvas/compose 的 POST（算计划 / 开跑 / 叫停）和 GET（查进度）。
 * 从 server.js 搬出来的，URL、状态码、返回体一个字没动；队列本身在 lib/compose-jobs.js，这里只翻译请求。
 * 顶层登记、路由器变量叫 app 的缘故见 routes/canvas.js 开头。
 */
const express = require("express");

// createComposeRouter(deps) 填上：lib/compose-jobs.js 的 createComposeJobs 造出来的那一份
let jobs;

// 大小写敏感跟 server.js 一致：子路由器不继承外面那个 case sensitive routing 的设置
const app = express.Router({ caseSensitive: true });

app.post("/api/canvas/compose", async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    if (body.cancel) return res.json({ ok: true, job: jobs.cancel(body.cancel) });
    const { plan, bins, boardUnreadable } = await jobs.plan(name, body.subtitles, body.music);
    if (!body.run) return res.json({ ok: true, plan, ...(boardUnreadable ? { boardUnreadable } : {}) });
    if (!plan.ready) return res.status(400).json({ error: (plan.blockers.find((b) => b.level === "stop") || {}).text || "现在还合成不了", plan });
    const started = jobs.start(name, plan, bins.ffmpeg);
    if (started.busy) return res.status(409).json({ error: "已经有一条在拼了，等它跑完或者先叫停", job: started.busy });
    res.json({ ok: true, job: started.job, plan });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/canvas/compose", async (req, res) => {
  try {
    const id = String(req.query.job || "").trim();
    if (id) {
      const job = jobs.get(id);
      if (!job) return res.status(404).json({ error: "这条合成记录已经不在了（服务重启过，或者太久了）" });
      return res.json({ ok: true, job });
    }
    res.json({ ok: true, job: jobs.running() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/** deps.jobs：createComposeJobs(...) 的返回值（plan / start / cancel / get / running） */
function createComposeRouter(deps) {
  ({ jobs } = deps);
  return app;
}

module.exports = { createComposeRouter };
