// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 用户自己的评测集：上传 CSV / Excel / TXT / JSON，或者在评测页里直接建。
 *
 * 内置题写在 tasks.js 里，判分是 JS 函数，只有写代码的人改得了。可评测最有价值的题是用户自己的活：
 * 他们公司的周报格式、他们客户的合同条款。所以这里把一道题写成纯数据：
 *
 *   prompt    题面
 *   files     开跑前放进工作目录的输入文件（文本）
 *   expect    机器判分：声明式规则，不跑用户写的代码
 *   criteria  质量标准：评委和人工都按这份逐条判
 *
 * 标准的打分照 HealthBench：每条独立判「是 / 否」，带权重，得分 = 拿到的分 ÷ 正分总和。
 *   权重为正   做到了得分，重要的给高分（1-10）
 *   权重为负   是毛病，出现了扣分（-1 到 -10）
 *   必须项     没做到整题不及格，分再高也不算过。事实错误、漏掉硬性要求就该这样，
 *              不能让十条好看的格式分盖过一条错的金额
 * 逐条二元比打总分可靠：不同人心里的「4 分」不一样，「结论写在第一段了吗」大家判得差不多，
 * 而且每个 ✗ 直接就是改进项。
 */
const fs = require("fs");
const path = require("path");
const { dataPath } = require("../src/platform/paths");
const store = require("../src/platform/store");
const { readZip } = require("../src/domains/library/zip-reader");

const MAX_TASKS = 200;
const MAX_PROMPT = 8000;
const MAX_FILE = 200 * 1024;
const MAX_CRITERIA = 20;
const EXPECT_TYPES = ["file", "contains", "not_contains", "regex", "reply_contains", "pages"];

const setsDir = () => dataPath("eval", "sets");
const fileOf = (id) => path.join(setsDir(), `${id}.json`);
const safeId = (s) => /^[\w-]{1,64}$/.test(String(s || ""));
const slug = (s, i) => String(s || "").normalize("NFKC").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || `t${i + 1}`;

// ---------- 标准和规则的简写 ----------

/** 「结论先行:3；金额算对:!；有废话:-2」：表格里一格写得下。没写权重算 1，`!` 是必须项 */
function parseCriteria(cell) {
  return String(cell || "").split(/[;；\n]+/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^(.*?)\s*[:：]\s*(!|！|必须|[-+]?\d+)\s*$/.exec(x);
    if (!m) return { text: x, weight: 1, must: false };
    if (/^(!|！|必须)$/.test(m[2])) return { text: m[1].trim(), weight: 5, must: true };
    return { text: m[1].trim(), weight: Math.max(-10, Math.min(10, +m[2])) || 1, must: false };
  });
}

/** 一格里多个值用 ; 或换行隔开 */
const listOf = (cell) => String(cell || "").split(/[;；\n]+/).map((x) => x.trim()).filter(Boolean);

function expectFrom({ outputs, contains, notContains, replyContains }) {
  const out = [];
  for (const name of listOf(outputs)) out.push({ type: "file", name });
  const file = listOf(outputs)[0] || "";
  for (const text of listOf(contains)) out.push({ type: "contains", text, file });
  for (const text of listOf(notContains)) out.push({ type: "not_contains", text, file });
  for (const text of listOf(replyContains)) out.push({ type: "reply_contains", text });
  return out;
}

// ---------- 文件格式 ----------

/** CSV：带引号、引号里换行逗号、BOM、\r\n 都认 */
function parseCsv(text) {
  const s = String(text).replace(/^﻿/, "");
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const HEADERS = {
  id: ["id", "编号", "题号"],
  name: ["name", "名称", "标题", "题名"],
  prompt: ["prompt", "题目", "任务", "题面", "问题"],
  outputs: ["outputs", "output", "产物", "必须有的文件", "输出文件"],
  contains: ["contains", "必须包含", "包含"],
  notContains: ["not_contains", "不能包含", "不许包含", "不包含"],
  replyContains: ["reply_contains", "回复包含", "回复必须包含"],
  criteria: ["criteria", "rubric", "标准", "评分标准", "质量标准"],
  inputName: ["input_file", "输入文件名", "输入文件"],
  inputText: ["input_text", "输入内容", "文件内容"],
};
function headerIndex(row) {
  const idx = {};
  row.forEach((h, i) => {
    const k = String(h || "").trim().toLowerCase();
    for (const [key, names] of Object.entries(HEADERS)) if (names.includes(k)) idx[key] = i;
  });
  return idx;
}

/** 表格行 → 题。CSV 和 Excel 走同一条路 */
function rowsToTasks(rows) {
  if (!rows.length) return { tasks: [], warnings: ["文件是空的"] };
  const idx = headerIndex(rows[0]);
  if (idx.prompt === undefined) return { tasks: [], warnings: ["第一行要有表头，至少得有一列「题目」"] };
  const warnings = [];
  const tasks = [];
  rows.slice(1).forEach((r, i) => {
    const get = (k) => (idx[k] === undefined ? "" : String(r[idx[k]] == null ? "" : r[idx[k]]).trim());
    const prompt = get("prompt");
    if (!prompt) { warnings.push(`第 ${i + 2} 行没写题目，跳过了`); return; }
    const files = {};
    if (get("inputName")) files[get("inputName")] = get("inputText");
    tasks.push({
      id: get("id") || `t${tasks.length + 1}`,
      name: get("name") || prompt.slice(0, 24),
      prompt, files,
      expect: expectFrom({ outputs: get("outputs"), contains: get("contains"), notContains: get("notContains"), replyContains: get("replyContains") }),
      criteria: parseCriteria(get("criteria")),
    });
  });
  return { tasks, warnings };
}

/**
 * TXT：最省事的写法。一段一题，段之间空一行或写一行 ---。
 * 段里可以有「产物：」「必须包含：」「不能包含：」「标准：」这几行，其余都算题面。
 */
function parseTxt(text) {
  const blocks = String(text).replace(/^﻿/, "").split(/\n\s*(?:-{3,}\s*)?\n|\n-{3,}\n/).map((b) => b.trim()).filter(Boolean);
  const tasks = blocks.map((b, i) => {
    const f = { outputs: "", contains: "", notContains: "", replyContains: "", criteria: "", name: "" };
    const body = [];
    for (const line of b.split("\n")) {
      const m = /^(标题|名称|产物|必须包含|不能包含|回复包含|标准|评分标准)[：:]\s*(.*)$/.exec(line.trim());
      if (!m) { body.push(line); continue; }
      const key = { 标题: "name", 名称: "name", 产物: "outputs", 必须包含: "contains", 不能包含: "notContains", 回复包含: "replyContains", 标准: "criteria", 评分标准: "criteria" }[m[1]];
      f[key] = m[2];
    }
    const prompt = body.join("\n").trim();
    return { id: `t${i + 1}`, name: f.name || prompt.slice(0, 24), prompt, files: {}, expect: expectFrom(f), criteria: parseCriteria(f.criteria) };
  }).filter((t) => t.prompt);
  return { tasks, warnings: tasks.length ? [] : ["没读到题目。一段一题，段之间空一行"] };
}

/** Excel：读第一张表。xlsx 就是 zip，不引 exceljs 的流式读，这里只要单元格文字 */
function parseXlsx(buf, tmpFile) {
  fs.writeFileSync(tmpFile, buf);
  try {
    const z = readZip(tmpFile);
    const shared = [...String(z.text("xl/sharedStrings.xml") || "").matchAll(/<si>([\s\S]*?)<\/si>/g)]
      .map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unxml(t[1])).join(""));
    const sheet = z.text("xl/worksheets/sheet1.xml");
    if (!sheet) return [];
    const colOf = (ref) => { let n = 0; for (const c of /^[A-Z]+/.exec(ref)[0]) n = n * 26 + c.charCodeAt(0) - 64; return n - 1; };
    const rows = [];
    for (const rm of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = (/r="([A-Z]+\d+)"/.exec(cm[1]) || [])[1];
        if (!ref) continue;
        const t = (/t="(\w+)"/.exec(cm[1]) || [])[1];
        const body = cm[2] || "";
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        const inline = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unxml(x[1])).join("");
        row[colOf(ref)] = t === "s" ? shared[+v] || "" : t === "inlineStr" ? inline : unxml(v || "");
      }
      rows.push(Array.from(row, (x) => (x === undefined ? "" : x)));
    }
    return rows;
  } finally { fs.rmSync(tmpFile, { force: true }); }
}
const unxml = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/**
 * 上传的文件 → 评测集。按后缀认格式，认不出的当 TXT。
 * @param {string} filename @param {Buffer} buf @param {{ name?: string, tmpDir?: string }} [o]
 */
function importFile(filename, buf, o = {}) {
  const ext = path.extname(String(filename)).toLowerCase();
  let parsed;
  if (ext === ".xlsx") {
    const tmp = path.join(o.tmpDir || require("os").tmpdir(), `owb-evalset-${process.pid}-${Date.now()}.xlsx`);
    parsed = rowsToTasks(parseXlsx(buf, tmp));
  } else if (ext === ".csv" || ext === ".tsv") {
    const text = buf.toString("utf8");
    parsed = rowsToTasks(ext === ".tsv" ? text.split(/\r?\n/).filter(Boolean).map((l) => l.split("\t")) : parseCsv(text));
  } else if (ext === ".json") {
    let j;
    try { j = JSON.parse(buf.toString("utf8")); } catch { return { error: "JSON 解析不了" }; }
    parsed = { tasks: Array.isArray(j) ? j : Array.isArray(j.tasks) ? j.tasks : [], warnings: [] };
  } else parsed = parseTxt(buf.toString("utf8"));
  const name = String(o.name || path.basename(String(filename), ext) || "评测集").slice(0, 60);
  const set = normalize({ name, tasks: parsed.tasks });
  const problem = validate(set);
  return problem ? { error: problem, warnings: parsed.warnings } : { set, warnings: parsed.warnings };
}

// ---------- 规整和校验 ----------

function normalize(input) {
  const seen = new Set();
  const tasks = (Array.isArray(input.tasks) ? input.tasks : []).map((t, i) => {
    let id = slug(t.id || t.name, i);
    while (seen.has(id)) id += "_";
    seen.add(id);
    return {
      id,
      name: String(t.name || t.prompt || id).slice(0, 80),
      prompt: String(t.prompt || ""),
      files: t.files && typeof t.files === "object" && !Array.isArray(t.files) ? t.files : {},
      expect: (Array.isArray(t.expect) ? t.expect : []).filter((e) => e && EXPECT_TYPES.includes(e.type)),
      criteria: (Array.isArray(t.criteria) ? t.criteria : []).map((c) => (typeof c === "string" ? parseCriteria(c)[0] : c)).filter((c) => c && c.text)
        .map((c) => ({ text: String(c.text).slice(0, 300), weight: Math.max(-10, Math.min(10, Math.round(+c.weight) || 1)), must: !!c.must })),
    };
  });
  return { id: safeId(input.id) ? input.id : `set_${Date.now().toString(36)}`, name: String(input.name || "评测集").slice(0, 60), tasks };
}

/** 有问题回一句人话，没问题回空串 */
function validate(set) {
  if (!set.tasks.length) return "一道题都没有";
  if (set.tasks.length > MAX_TASKS) return `最多 ${MAX_TASKS} 道题，这份有 ${set.tasks.length} 道`;
  for (const t of set.tasks) {
    if (!t.prompt.trim()) return `「${t.name}」没写题目`;
    if (t.prompt.length > MAX_PROMPT) return `「${t.name}」题目太长（上限 ${MAX_PROMPT} 字）`;
    if (t.criteria.length > MAX_CRITERIA) return `「${t.name}」标准太多（上限 ${MAX_CRITERIA} 条）`;
    if (!t.expect.length && !t.criteria.length) return `「${t.name}」既没有机器规则也没有标准，判不了分`;
    for (const [n, v] of Object.entries(t.files)) {
      // 输入文件要落进这道题的工作目录，名字带路径就能写到别处去
      if (!n || n.length > 120 || /[\\/]|^\.+$|[\u0000-\u001f]/.test(n)) return `「${t.name}」的输入文件名不合法：${n}`;
      if (Buffer.byteLength(String(v)) > MAX_FILE) return `「${t.name}」的输入文件 ${n} 太大（上限 200KB）`;
    }
    for (const e of t.expect) {
      if (e.file && /[\\]|\.\.|^\//.test(e.file)) return `「${t.name}」的文件路径不合法：${e.file}`;
      if (e.name && /[\\]|\.\.|^\//.test(e.name)) return `「${t.name}」的文件路径不合法：${e.name}`;
      if (e.type === "regex") {
        if (String(e.pattern || "").length > 200) return `「${t.name}」的正则太长`;
        try { new RegExp(e.pattern); } catch { return `「${t.name}」的正则写错了：${e.pattern}`; }
      }
    }
  }
  return "";
}

// ---------- 判分 ----------

/** 文件的文字。Office 解开包读正文，别的按文本读 */
function textOf(dir, name) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return "";
  if (/\.(docx|pptx|xlsx)$/i.test(name)) {
    try {
      const z = readZip(p);
      return z.entries.filter((e) => !e.dir && /\.xml$/.test(e.name) && /(document|slide\d+|sheet\d+|sharedStrings)\.xml$/.test(e.name))
        .map((e) => z.text(e.name)).join("\n").replace(/<[^>]+>/g, "");
    } catch { return ""; }
  }
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

/** 没点名文件就在工作目录里全找：用户写「必须包含」时多半没想过落到哪个文件 */
function allText(dir) {
  try { return fs.readdirSync(dir).filter((n) => !n.startsWith(".")).map((n) => textOf(dir, n)).join("\n"); } catch { return ""; }
}

function runExpect(e, dir, reply) {
  const ck = (name, ok, note) => ({ name, ok: !!ok, note: note || "" });
  const body = () => (e.file ? textOf(dir, e.file) : allText(dir));
  switch (e.type) {
    case "file": return ck(`${e.name} 存在`, fs.existsSync(path.join(dir, e.name)));
    case "contains": return ck(`包含「${e.text}」`, body().includes(e.text));
    // 先钉一句「真交了东西」：空目录上这条不能白绿（负对照的规矩，见 docs/评测方法论.md 第八节）
    case "not_contains": { const t = body(); return ck(`不含「${e.text}」`, !!t.trim() && !t.includes(e.text)); }
    case "regex": return ck(`匹配 ${e.pattern}`, new RegExp(e.pattern).test(body()));
    case "reply_contains": return ck(`回复包含「${e.text}」`, String(reply || "").includes(e.text));
    case "pages": {
      let n = 0;
      try { n = readZip(path.join(dir, e.file)).entries.filter((x) => /^ppt\/slides\/slide\d+\.xml$/.test(x.name)).length; } catch {}
      return ck(`${e.file} 有 ${e.count} 页`, n === +e.count, `实际 ${n} 页`);
    }
    default: return ck(`不认识的规则 ${e.type}`, false);
  }
}

/** 负分标准要改写成问句：评委的 true 永远是「这句话成立」，分数在这边按权重算 */
const dimText = (c) => (c.weight < 0 ? `是否出现这个毛病：${c.text}` : c.text);

/** 评测集 → 跑批认识的题目形状 */
function toTasks(set) {
  return set.tasks.map((t) => ({
    id: t.id, name: t.name, level: 2, kind: "自定义",
    prompt: t.prompt,
    inputs: t.files,
    rubric: t.criteria.map(dimText),
    criteria: t.criteria,
    checks(dir, reply) {
      // 只有质量标准的题，机器这条线没东西判：算过，好坏交给评委和人工
      if (!t.expect.length) return [{ name: "这道题只按标准打分", ok: true, note: "" }];
      return t.expect.map((e) => runExpect(e, dir, reply));
    },
  }));
}

/**
 * 按权重算分（HealthBench 的算法）。dims 跟 criteria 一一对应，pass 是「这句话成立」。
 * 得分 = 拿到的分 ÷ 正分总和，扣到负数按 0 算。必须项没过，gate_failed，这道题不及格。
 * 没判出来的（评委没答、人工没标）不算分，也不进分母：不知道不等于没做到。
 * @param {Array<{weight: number, must?: boolean}>} criteria
 * @param {Array<{pass?: boolean} | null | undefined>} dims
 */
function weightedScore(criteria, dims) {
  let earned = 0, max = 0, judged = 0, gate = false;
  (criteria || []).forEach((c, i) => {
    const d = dims && dims[i];
    if (!d || typeof d.pass !== "boolean") return;
    judged++;
    if (c.weight > 0) max += c.weight;
    if (d.pass) earned += c.weight;
    if (c.must && !d.pass) gate = true;
  });
  if (!judged) return null;
  const pct = max > 0 ? Math.round(Math.max(0, Math.min(1, earned / max)) * 100) : (earned < 0 ? 0 : 100);
  return { pct, earned, max, judged, total: (criteria || []).length, gate_failed: gate, pass: !gate };
}

/**
 * 两个判分人的一致程度，扣掉「蒙也能对」的那部分（Cohen's kappa）。
 * 光看一致率会骗人：九成都是「达标」时，闭眼全判达标也有九成。
 * @param {Array<[boolean, boolean]>} pairs
 * @returns {number | null} -1 到 1；样本太少或全是一种答案时回 null
 */
function cohenKappa(pairs) {
  const n = (pairs || []).length;
  if (n < 2) return null;
  let agree = 0, aYes = 0, bYes = 0;
  for (const [a, b] of pairs) { if (a === b) agree++; if (a) aYes++; if (b) bYes++; }
  const po = agree / n;
  const pe = (aYes / n) * (bYes / n) + (1 - aYes / n) * (1 - bYes / n);
  if (pe >= 1) return null;
  return +((po - pe) / (1 - pe)).toFixed(2);
}

// ---------- 存取 ----------

function list() {
  let names = [];
  try { names = fs.readdirSync(setsDir()).filter((n) => n.endsWith(".json")); } catch { return []; }
  return names.map((n) => store.readJson(path.join(setsDir(), n), null)).filter(Boolean)
    .map((s) => ({ id: s.id, name: s.name, tasks: (s.tasks || []).length, updated_at: s.updated_at || "" }))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}
function load(id) { return safeId(id) ? store.readJson(fileOf(id), null) : null; }
function save(input) {
  const set = normalize(input);
  const problem = validate(set);
  if (problem) return { error: problem };
  fs.mkdirSync(setsDir(), { recursive: true });
  const now = new Date().toISOString();
  const prev = load(set.id);
  const out = { ...set, created_at: (prev && prev.created_at) || now, updated_at: now };
  store.writeJsonAtomic(fileOf(set.id), out, { pretty: true });
  return { set: out };
}
function remove(id) {
  if (!safeId(id)) return false;
  fs.rmSync(fileOf(id), { force: true });
  return true;
}

/** 下载用的模板：列名、简写都在这一份里示范 */
function templateCsv() {
  return "﻿" + [
    "编号,名称,题目,产物,必须包含,不能包含,标准,输入文件名,输入内容",
    `周报,销售周报,"把 data.csv 整理成 周报.md，写清最高的是哪天",周报.md,2050,,"结论写在第一段:3；日期和数字都对:!；有套话开场:-2",data.csv,"日期,销售额\n2026-09-18,1910\n2026-09-19,2050"`,
    `邮件,客户回复,"写一封婉拒延期的邮件，存成 回复.txt",回复.txt,,保证,"语气礼貌:2；给了替代方案:3",,`,
  ].join("\n") + "\n";
}

module.exports = {
  EXPECT_TYPES, MAX_TASKS, parseCriteria, parseCsv, parseTxt, rowsToTasks, importFile, normalize, validate, toTasks, runExpect, weightedScore, cohenKappa,
  list, load, save, remove, templateCsv,
};
