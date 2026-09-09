"use strict";
/**
 * 专家数据的纯函数（server.js 启动时用，测试直接 require）：
 *   validateExperts     —— experts.json 体检：绑的技能存在、团成员是真专家、提示词点名的技能真绑了
 *   mergeBuiltinExperts —— 打包版升级后，把新出的内置专家/专家团补进用户那份，用户改过/删过的不动
 */

/** 返回问题清单（空数组 = 干净）。skillNames 给 Set 就校验技能是否存在，不给就跳过这项。 */
function validateExperts(meta, skillNames) {
  const problems = [];
  const experts = (meta && Array.isArray(meta.experts) && meta.experts) || [];
  const teams = (meta && Array.isArray(meta.teams) && meta.teams) || [];
  const names = new Set();
  for (const e of experts) {
    const name = e && String(e.name || "").trim();
    if (!name) { problems.push("有专家没名字"); continue; }
    const at = `专家「${name}」`;
    if (names.has(name)) problems.push(`${at}重名`);
    names.add(name);
    for (const k of ["description", "system", "avatar", "category"]) if (!String(e[k] || "").trim()) problems.push(`${at}缺 ${k}`);
    if (String(e.description || "").length > 90) problems.push(`${at}的 description 超过 90 字（它每次都进主 Agent 的系统提示词，要短）`);
    const skills = Array.isArray(e.skills) ? e.skills : [];
    if (skillNames) for (const s of skills) if (!skillNames.has(s)) problems.push(`${at}绑定的技能「${s}」不存在`);
    // 提示词里让子智能体 use_skill 某技能，skills 里却没绑：干活前不会被提示加载，等于白写
    for (const m of String(e.system || "").matchAll(/use_skill 加载 ([a-z0-9][a-z0-9-]*)/g)) {
      if (!skills.includes(m[1])) problems.push(`${at}的提示词让加载 ${m[1]}，但 skills 里没绑`);
    }
  }
  const teamNames = new Set();
  for (const t of teams) {
    const name = t && String(t.name || "").trim();
    if (!name) { problems.push("有专家团没名字"); continue; }
    const at = `专家团「${name}」`;
    if (teamNames.has(name)) problems.push(`${at}重名`);
    teamNames.add(name);
    const members = Array.isArray(t.members) ? t.members : [];
    if (members.length < 2) problems.push(`${at}成员不足 2 人`);
    if (new Set(members).size !== members.length) problems.push(`${at}成员重复`);
    for (const m of members) if (!names.has(m)) problems.push(`${at}的成员「${m}」不是已定义的专家`);
    if (!String(t.description || "").trim()) problems.push(`${at}缺 description`);
  }
  return problems;
}

/**
 * 把包里（bundled）新出的内置专家/专家团合并进用户那份（mine，就地改）。
 * 规则：只补用户「从没见过」的内置项——见过的（哪怕已被用户删掉）不再塞回来，用户的自建/改动一律不碰。
 * 「见过」记在 mine.seen_builtins / mine.seen_builtin_teams 里；老文件没这两个字段时，
 * 把当前已有的当作见过（所以第一次升级只补真正新增的）。
 */
function mergeBuiltinExperts(mine, bundled) {
  const experts = Array.isArray(mine.experts) ? mine.experts : (mine.experts = []);
  const teams = Array.isArray(mine.teams) ? mine.teams : (mine.teams = []);
  const have = new Set(experts.map((e) => e.name));
  const haveT = new Set(teams.map((t) => t.name));
  const seen = new Set(Array.isArray(mine.seen_builtins) ? mine.seen_builtins : experts.filter((e) => e.builtin).map((e) => e.name));
  const seenT = new Set(Array.isArray(mine.seen_builtin_teams) ? mine.seen_builtin_teams : teams.map((t) => t.name));
  const added = [], addedTeams = [];
  for (const e of (bundled && bundled.experts) || []) {
    if (!e || !e.builtin || !e.name) continue;
    if (!have.has(e.name) && !seen.has(e.name)) {
      experts.push(JSON.parse(JSON.stringify(e)));
      have.add(e.name);
      added.push(e.name);
    }
    seen.add(e.name);
  }
  for (const t of (bundled && bundled.teams) || []) {
    if (!t || !t.name) continue;
    const members = Array.isArray(t.members) ? t.members : [];
    // 成员被用户删了的团不硬塞：派出去会因为找不到人直接失败
    if (!haveT.has(t.name) && !seenT.has(t.name) && members.length >= 2 && members.every((m) => have.has(m))) {
      teams.push(JSON.parse(JSON.stringify(t)));
      haveT.add(t.name);
      addedTeams.push(t.name);
    }
    seenT.add(t.name);
  }
  mine.seen_builtins = [...seen];
  mine.seen_builtin_teams = [...seenT];
  return { added, addedTeams };
}

module.exports = { validateExperts, mergeBuiltinExperts };
