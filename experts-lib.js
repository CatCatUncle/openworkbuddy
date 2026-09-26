// @ts-check
"use strict";
/**
 * 专家数据的纯函数（server.js 启动时用，测试直接 require）：
 *   validateExperts     —— experts.json 体检：绑的技能存在、团成员是真专家、提示词点名的技能真绑了
 *   mergeBuiltinExperts —— 打包版升级后，把新出的内置专家/专家团补进用户那份、给已有内置专家补绑新技能，
 *                          用户改过/删过的不动
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
 * 已有内置专家的新技能另走 bindBuiltinSkills，记在 mine.seen_builtin_skills。
 * 返回 { added, addedTeams, bound }：bound 是补绑的「专家:技能」，调用方据此决定要不要落盘。
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
  const bound = bindBuiltinSkills(mine, experts, bundled, added);
  return { added, addedTeams, bound };
}

/**
 * 有 seen_builtin_skills 之前最后一版随包的内置专家技能（v0.9.5 的 experts.json 里技能非空的那些）。
 * 老文件第一次跑时拿它当「见过」：手里跟这份一样的专家，说明是原样没动过，包里后来新加的（视频成片师的
 * product-demo）照样补上；这里面有、用户手里没了的，是用户自己删的，不塞回来。
 * 这张表只增不改：改了就会把老用户删掉的技能又塞回去。
 * @type {Record<string, string[]>}
 */
const LEGACY_SEEN_SKILLS = {
  深度研究员: ["deep-research"], 竞品分析师: ["deep-research"], 数据分析师: ["excel-report"], 数据可视化师: ["data-viz"],
  文案写手: ["docx"], 公众号编辑: ["wechat-article"], 网页设计师: ["web-styles", "html-page"], PPT设计师: ["ppt-design"],
  会议纪要师: ["meeting-minutes"], 周报助手: ["weekly-report", "feishu-doc"], 视频成片师: ["video-compose", "short-drama"],
  短剧导演: ["short-drama"], 角色一致性师: ["short-drama", "character-photo-studio"], 分镜摄影师: ["short-drama"],
  小红书选题策划: ["xiaohongshu-topic"], 封面卡片师: ["xhs-cards"], 飞书助理: ["lark-cli", "feishu-doc"], 技能沉淀师: ["skill-creator"],
  邮件沟通师: ["email-draft"], 招聘专员: ["recruiting"], 客服话术师: ["support-scripts"], 合同审阅员: ["contract-review"],
  项目经理: ["project-plan"], 产品经理: ["prd"],
};

/**
 * 给老用户手里已有的内置专家补绑新技能（「短视频脚本师」新绑了 promo-video 这种）。
 * 上面那段只补「整个没见过的专家」，见过的一个字段都不改——新技能就永远到不了老用户手里。
 * 规则跟上面一样是「只补没见过的」，粒度细到每个专家的每个技能：
 *   - 老文件第一次跑（没有 seen_builtin_skills）：LEGACY_SEEN_SKILLS 里有的专家拿那份当「见过」；
 *     没有的只给技能是空的补，用户自己配过技能的不碰；
 *   - 之后：包里新出现、用户那份还没有、也没见过的才补；用户删掉的不会再塞回来；
 *   - 每次都把包里这一版记成「见过」。刚整个补进来的专家本来就带着全套，直接记见过。
 * 返回补绑了哪些，形如「短视频脚本师:promo-video」，给启动日志留痕用。
 * @param {any} mine @param {any[]} experts @param {any} bundled @param {string[]} justAdded
 * @returns {string[]}
 */
function bindBuiltinSkills(mine, experts, bundled, justAdded) {
  const had = mine.seen_builtin_skills && typeof mine.seen_builtin_skills === "object" && !Array.isArray(mine.seen_builtin_skills);
  /** @type {Record<string, string[]>} */
  const seen = had ? mine.seen_builtin_skills : {};
  const fresh = new Set(justAdded);
  /** @type {string[]} */
  const bound = [];
  for (const e of (bundled && bundled.experts) || []) {
    if (!e || !e.builtin || !e.name) continue;
    const want = (Array.isArray(e.skills) ? e.skills : []).map(String).filter(Boolean);
    const m = experts.find((x) => x && x.builtin && x.name === e.name);
    if (m && !fresh.has(e.name)) {
      const cur = Array.isArray(m.skills) ? m.skills : (m.skills = []);
      const legacy = !had && Object.prototype.hasOwnProperty.call(LEGACY_SEEN_SKILLS, e.name) ? LEGACY_SEEN_SKILLS[e.name] : null;
      const before = legacy || (Array.isArray(seen[e.name]) ? seen[e.name] : []);
      const add = !had && !legacy
        ? (cur.length ? [] : want)
        : want.filter((s) => !before.includes(s) && !cur.includes(s));
      for (const s of add) if (!cur.includes(s)) { cur.push(s); bound.push(`${e.name}:${s}`); }
    }
    seen[e.name] = want.slice();
  }
  mine.seen_builtin_skills = seen;
  return bound;
}

module.exports = { validateExperts, mergeBuiltinExperts };
