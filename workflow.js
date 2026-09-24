// @ts-check
"use strict";
/**
 * `openworkbuddy workflow <文件.json>`：把一串任务写成文件，按顺序一步步跑。
 *
 *   {
 *     "steps": [
 *       { "name": "plan",   "mode": "plan",  "prompt": "看一下 src/，想好怎么加导出 CSV" },
 *       { "name": "build",  "prompt": "照这个方案做：\n{{plan}}" },
 *       { "name": "review", "mode": "ask",   "prompt": "审一下刚才的改动" }
 *     ]
 *   }
 *
 * 几步共用一个会话：后一步本来就看得见前面说过什么；{{名字}} 是把某一步的最终回复原样贴进来，
 * 用在「方案要一字不差地交下去」这种地方。
 *
 * 一步失败默认就停——后面几步多半建立在它之上，接着跑只会在错的地基上越盖越高；
 * 确实不相干的那步写 "continue_on_error": true。
 *
 * 这里只做纯的部分（读、校验、填模板），真正跑任务的是 cli.js。
 */
const { MODE_IDS: MODES } = require("./modes"); // 跟 -m 认的是同一份
const NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_STEPS = 50;
const PASTE_MAX = 20000; // 贴进下一步的上限：再长就该让它自己去读文件

/** 解析并校验。返回 { steps } 或 { error }；错误一次全列出来，不让人改一条跑一次 */
function parse(text) {
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { return { error: `不是合法的 JSON：${e.message}` }; }
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.steps) ? raw.steps : null;
  if (!list) return { error: "要有 steps 数组：{ \"steps\": [ { \"prompt\": \"…\" } ] }" };
  if (!list.length) return { error: "steps 是空的" };
  if (list.length > MAX_STEPS) return { error: `最多 ${MAX_STEPS} 步，现在 ${list.length} 步` };
  const problems = [];
  const seen = new Set();
  const steps = list.map((s, i) => {
    const where = `第 ${i + 1} 步`;
    if (typeof s === "string") s = { prompt: s };
    if (!s || typeof s !== "object") { problems.push(`${where}：要么是一句话，要么是 { "prompt": … }`); return null; }
    const prompt = String(s.prompt || "").trim();
    if (!prompt) problems.push(`${where}：没写 prompt`);
    const name = s.name == null ? `step${i + 1}` : String(s.name);
    if (!NAME_RE.test(name)) problems.push(`${where}：名字「${name}」只能用小写字母开头的字母、数字、- 和 _`);
    else if (seen.has(name)) problems.push(`${where}：名字「${name}」跟前面重了`);
    seen.add(name);
    const mode = s.mode == null ? null : String(s.mode); // 没写就跟命令行的 -m 走
    if (mode !== null && !MODES.includes(mode)) problems.push(`${where}：mode「${mode}」不认识，只有 ${MODES.join(" / ")}`);
    return { name, prompt, mode, continueOnError: s.continue_on_error === true };
  });
  // {{名字}} 只能指前面的步骤：指后面的那步还没跑，指不存在的是笔误
  steps.forEach((s, i) => {
    if (!s) return;
    for (const ref of refs(s.prompt)) {
      const at = steps.findIndex((x) => x && x.name === ref);
      if (at < 0) problems.push(`第 ${i + 1} 步：{{${ref}}} 没有这一步`);
      else if (at >= i) problems.push(`第 ${i + 1} 步：{{${ref}}} 指的是它自己或后面的步骤，那时还没结果`);
    }
  });
  if (problems.length) return { error: problems.join("\n") };
  return { steps };
}

function refs(prompt) {
  const out = [];
  String(prompt).replace(/\{\{\s*([a-z][a-z0-9_-]*)\s*\}\}/g, (_, n) => { out.push(n); return _; });
  return out;
}

/** 把 {{名字}} 换成那一步的最终回复。一次替换，贴进来的内容里再有 {{…}} 也不会被二次展开 */
function fill(prompt, results) {
  return String(prompt).replace(/\{\{\s*([a-z][a-z0-9_-]*)\s*\}\}/g, (m, n) => {
    if (!Object.prototype.hasOwnProperty.call(results, n)) return m;
    const t = String(results[n] || "").trim();
    if (!t) return "（这一步没有文字回复）";
    return t.length > PASTE_MAX ? t.slice(0, PASTE_MAX) + `\n…（后面还有 ${t.length - PASTE_MAX} 字，没贴进来）` : t;
  });
}

module.exports = { parse, fill, refs, MODES, MAX_STEPS, PASTE_MAX };
