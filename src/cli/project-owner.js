// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const path = require("path");
const canonical = require("../util/task-dirs").canonDir;
function cliProject({ explicit, cwd, projects = [], existing = {} }) {
  const continuing = (existing.transcript || []).length > 0 || (existing.history || []).length > 0;
  if (continuing) {
    if (explicit && explicit !== existing.project) throw Error("续接任务保留原项目归属；请在桌面端移动任务，或新建任务时指定项目");
    return { project: existing.project || "", project_unassigned: !existing.project };
  }
  if (explicit) {
    const hit = projects.find(p => p.name === explicit); if (!hit) throw Error("找不到项目「" + explicit + "」，请使用桌面端已创建的项目名称");
    return { project: hit.name, project_unassigned: false };
  }
  const here = canonical(cwd);
  const matches = projects.filter(p => p && p.name && p.dir).map(p => ({ name: p.name, dir: canonical(p.dir) }))
    .filter(p => { const rel = path.relative(p.dir, here); return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep)); })
    .sort((a, b) => b.dir.length - a.dir.length);
  return { project: matches[0]?.name || "", project_unassigned: !matches.length };
}
module.exports = { cliProject };
