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
 * 顶层还可以写 "name"、"description"（跑的时候面板顶上那两行），每一步可以写 "phase"（面板按阶段分组，
 * 左边一栏列阶段、右边列当前阶段的步骤）和 "title"（面板上那一步叫什么，中文随便写——name 要给 {{…}} 引用，
 * 只能是英文小写）。都不写也行，面板照样画。
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
// 流程文件顶层的 inputs：跑之前要人填的几个空，用 {{input.名字}} 引用。名字不许带 -，
// 因为它最后会变成 -i 名字=值 和 JSON 的键，带 - 的键在两边都容易写错
const INPUT_RE = /^[a-z][a-z0-9_]{0,39}$/;
const INPUT_REF_RE = /\{\{\s*input\.([a-z_][a-z0-9_]*)\s*\}\}/g;
const MAX_INPUTS = 20;
const INPUT_TYPES = ["text", "select", "multi"];
const INPUT_JSON = "__json"; // 保留名：整组值的一行 JSON，配方靠它把表单预填进消息
const EMPTY_INPUT = "（没填）";

/** 解析并校验。返回 { steps } 或 { error }；错误一次全列出来，不让人改一条跑一次 */
function parseSteps(text) {
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
    const phase = s.phase == null ? "" : String(s.phase).trim();
    if (phase.length > 20) problems.push(`${where}：phase「${phase}」太长了，20 个字以内`);
    const title = s.title == null ? "" : String(s.title).trim();
    if (title.length > 24) problems.push(`${where}：title「${title}」太长了，24 个字以内`);
    return { name, title, prompt, mode, phase, continueOnError: s.continue_on_error === true };
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
  const meta = Array.isArray(raw) ? {} : raw;
  return {
    steps,
    name: typeof meta.name === "string" ? meta.name.trim().slice(0, 60) : "",
    description: typeof meta.description === "string" ? meta.description.trim().slice(0, 200) : "",
  };
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

// ── inputs：跑之前要人填的空 ──
//   "inputs": [
//     { "name": "product", "label": "产品", "required": true },
//     { "name": "duration", "type": "select", "options": ["15", "30"], "default": "15" },
//     { "name": "platforms", "type": "multi", "options": ["抖音", "小红书"], "default": ["抖音"] }
//   ]
// 步骤里写 {{input.product}}；命令行 -i product=智能水杯，多选写 -i platforms=抖音,小红书。
// 先填 inputs 再贴前面几步的结果：贴进来的回复里就算出现 {{input.x}} 也只是原文，不会被当成空再填一次

/** @typedef {{ name: string, label: string, type: string, options?: string[], default?: string|string[], required: boolean }} Input */

// 校验用的宽松版：{{input.Foo}}、{{input.a-b}} 这种写错名字的也要逮到，严格版会直接当它不存在
const LOOSE_INPUT_REF_RE = /\{\{\s*input\.([^{}\s]*)\s*\}\}/g;
const MULTI_SPLIT_RE = /[,，、]/;

/**
 * 解析并校验整份流程：步骤那一套之外，再核顶层 inputs 和每一步里的 {{input.名字}}，错误跟步骤的一起列。
 * @param {string} text
 * @returns {{ error: string } | { steps: any[], name: string, description: string, inputs: Input[] }}
 */
function parse(text) {
  const base = /** @type {any} */ (parseSteps(text));
  /** @type {any} */
  let raw;
  try { raw = JSON.parse(text); } catch { return base; }
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.steps) ? raw.steps : null;
  // 骨架都不对（没有 steps、空的、太长）：先把那条改了再说，这时候报 inputs 的细账只是噪音
  if (!list || !list.length || list.length > MAX_STEPS) return base;
  /** @type {string[]} */
  const problems = base.error ? [base.error] : [];
  const inputs = parseInputs(Array.isArray(raw) ? undefined : raw.inputs, problems);
  if (inputs) {
    const known = new Set(inputs.map((x) => x.name));
    list.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
      const prompt = typeof s === "string" ? s : s && typeof s === "object" ? String(s.prompt || "") : "";
      const told = new Set();
      prompt.replace(LOOSE_INPUT_REF_RE, (m, n) => {
        if (told.has(n) || n === INPUT_JSON) return m;
        told.add(n);
        if (!INPUT_RE.test(n)) problems.push(`第 ${i + 1} 步：{{input.${n}}} 名字只能是小写字母开头的字母、数字和 _`);
        else if (!known.has(n)) problems.push(`第 ${i + 1} 步用了 {{input.${n}}}，inputs 里没有 ${n}`);
        return m;
      });
    });
  }
  if (problems.length) return { error: problems.join("\n") };
  return { ...base, inputs: inputs || [] };
}

/**
 * 校验并规整 inputs。名字写对了的项哪怕别处有错也收进来——只拿它去核 {{input.x}}，
 * 免得一项的 options 写错，引用它的每一步都跟着报「inputs 里没有」。
 * @param {unknown} raw @param {string[]} problems
 * @returns {Input[]|null} 整块写坏（不是数组、太多项）返回 null，调用方就别再核引用了
 */
function parseInputs(raw, problems) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) { problems.push("inputs 要写成数组：[ { \"name\": \"product\", \"label\": \"产品\" } ]"); return null; }
  if (raw.length > MAX_INPUTS) { problems.push(`inputs 最多 ${MAX_INPUTS} 项，现在 ${raw.length} 项`); return null; }
  /** @type {Input[]} */
  const out = [];
  const seen = new Set();
  raw.forEach((/** @type {any} */ x, i) => {
    const where = `inputs 第 ${i + 1} 项`;
    if (!x || typeof x !== "object" || Array.isArray(x)) { problems.push(`${where}：要写成 { "name": … }`); return; }
    const name = x.name == null ? "" : String(x.name).trim();
    let nameOk = true;
    if (!name) { problems.push(`${where}：没写 name`); nameOk = false; }
    else if (!INPUT_RE.test(name)) { problems.push(`${where}：名字「${name}」只能用小写字母开头的字母、数字和 _`); nameOk = false; }
    else if (seen.has(name)) { problems.push(`${where}：名字「${name}」跟前面重了`); nameOk = false; }
    seen.add(name);
    const at = nameOk ? `${where}（${name}）` : where;
    const hasOpts = x.options != null;
    const type = x.type == null ? (hasOpts ? "select" : "text") : String(x.type);
    if (!INPUT_TYPES.includes(type)) problems.push(`${at}：type「${type}」不认识，只有 ${INPUT_TYPES.join(" / ")}`);
    /** @type {string[]|undefined} */
    let options;
    if (type === "text" && hasOpts) problems.push(`${at}：写了 options 却是 text，要让人从里面挑就写 "type": "select" 或 "multi"`);
    if (type === "select" || type === "multi") {
      const bad = !Array.isArray(x.options) || !x.options.length
        || x.options.some((/** @type {any} */ o) => (typeof o !== "string" && typeof o !== "number") || !String(o).trim());
      if (bad) problems.push(`${at}：${type} 要给 options，一项一句话，比如 "options": ["15", "30"]`);
      else {
        options = x.options.map((/** @type {any} */ o) => String(o).trim());
        const dup = options.find((o, k) => options.indexOf(o) !== k);
        if (dup) problems.push(`${at}：options 里「${dup}」写了两遍`);
        // 多选在命令行里是 a,b 或 a、b 一口气给，选项自己带逗号就拆不回来了
        const comma = type === "multi" ? options.find((o) => MULTI_SPLIT_RE.test(o)) : undefined;
        if (comma) problems.push(`${at}：多选的选项「${comma}」里不能有逗号或顿号，命令行靠它们分开几个值`);
      }
    }
    const label = x.label == null ? name : String(x.label).trim() || name;
    if (label.length > 24) problems.push(`${at}：label「${label}」太长了，24 个字以内`);
    /** @type {string|string[]|undefined} */
    let def;
    if (x.default != null && x.default !== "") {
      if (type === "multi") {
        const arr = (Array.isArray(x.default) ? x.default : String(x.default).split(MULTI_SPLIT_RE)).map((/** @type {any} */ d) => String(d).trim()).filter(Boolean);
        const off = options ? arr.filter((d) => !options.includes(d)) : [];
        if (off.length) problems.push(`${at}：默认值「${off.join("、")}」不在 options 里`);
        def = arr;
      } else if (typeof x.default !== "string" && typeof x.default !== "number") {
        problems.push(`${at}：默认值要写成一句话`);
      } else {
        def = String(x.default).trim();
        if (type === "select" && options && !options.includes(def)) problems.push(`${at}：默认值「${def}」不在 options 里`);
      }
    }
    if (!nameOk) return;
    /** @type {Input} */
    const item = { name, label, type, required: x.required === true };
    if (options) item.options = options;
    if (def !== undefined) item.default = def;
    out.push(item);
  });
  return out;
}

/** 一段 prompt 里引用了哪些 {{input.名字}}，按出现顺序去重；__json 也算 @param {string} prompt */
function inputRefs(prompt) {
  /** @type {string[]} */
  const out = [];
  String(prompt).replace(INPUT_REF_RE, (m, n) => { if (!out.includes(n)) out.push(n); return m; });
  return out;
}

/** 报错时怎么称呼这一项：有中文 label 就带上，名字是给 -i 用的，也得让人看见 @param {Input} inp */
function who(inp) {
  return inp.label && inp.label !== inp.name ? `${inp.label}（${inp.name}）` : inp.name;
}

/**
 * 把 -i 那几条 名字=值 收成 { 名字: 值 }；同一个名字给了几次就收成数组，留给 resolveInputs 判能不能多给。
 * @param {string[]} list
 * @returns {{ given: Record<string, string|string[]>, errors: string[] }}
 */
function inputArgs(list) {
  /** @type {Record<string, string|string[]>} */
  const given = {};
  /** @type {string[]} */
  const errors = [];
  for (const s of list || []) {
    const eq = String(s).indexOf("=");
    const k = eq > 0 ? String(s).slice(0, eq).trim() : "";
    if (!k) { errors.push(`-i 要写成 名字=值，你写的是 ${s}`); continue; }
    const v = String(s).slice(eq + 1).trim();
    const had = given[k];
    given[k] = had === undefined ? v : [].concat(had, v);
  }
  return { given, errors };
}

/**
 * 把给的值对上声明的 inputs：选项核对（大小写不敏感兜一次）、多选拆 a,b / a、b、没给的补默认。
 * 给了空值等于没给；必填又没默认的进 missing，由调用方去问人或者报错。
 * @param {Input[]} inputs @param {Record<string, unknown>} given
 * @returns {{ values: Record<string, string|string[]>, missing: string[], errors: string[] }}
 */
function resolveInputs(inputs, given) {
  const list = inputs || [];
  const g = given || {};
  /** @type {Record<string, string|string[]>} */
  const values = {};
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const errors = [];
  for (const k of Object.keys(g)) {
    if (list.some((x) => x.name === k)) continue;
    errors.push(list.length
      ? `没有叫「${k}」的输入项，能填的是 ${list.map((x) => x.name).join(" / ")}`
      : `给了「${k}」，可这个流程没有要填的项`);
  }
  const pick = (/** @type {string[]} */ opts, /** @type {string} */ v) =>
    opts.includes(v) ? v : opts.find((o) => o.toLowerCase() === v.toLowerCase());
  for (const inp of list) {
    const raw = Object.prototype.hasOwnProperty.call(g, inp.name) ? g[inp.name] : undefined;
    const parts = (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map((x) => String(x).trim()).filter(Boolean);
    const opts = inp.options || [];
    if (parts.length) {
      if (inp.type === "multi") {
        const want = [...new Set(parts.flatMap((p) => p.split(MULTI_SPLIT_RE)).map((p) => p.trim()).filter(Boolean))];
        const off = want.filter((w) => !pick(opts, w));
        if (off.length) errors.push(`${who(inp)}：只能从 ${opts.join(" / ")} 里选，「${off.join("、")}」不在里面`);
        else {
          const got = want.map((w) => pick(opts, w));
          values[inp.name] = opts.filter((o) => got.includes(o)); // 按 options 的顺序，跟表单里看到的一样
          continue;
        }
      } else if (parts.length > 1) {
        errors.push(`${who(inp)}：给了 ${parts.length} 次，只能给一个`);
      } else if (inp.type === "select") {
        const hit = pick(opts, parts[0]);
        if (hit) { values[inp.name] = hit; continue; }
        errors.push(`${who(inp)}：只能是 ${opts.join(" / ")}，给的是「${parts[0]}」`);
      } else if (parts[0].length > PASTE_MAX) {
        errors.push(`${who(inp)}：太长了（${parts[0].length} 字），最多 ${PASTE_MAX} 字；长内容存成文件，让它自己去读`);
      } else { values[inp.name] = parts[0]; continue; }
    }
    // 没给、给错了（已记一条错）：都先落默认值，给错的那条会让调用方整体停下
    if (inp.default !== undefined && (Array.isArray(inp.default) ? inp.default.length : inp.default !== "")) {
      values[inp.name] = Array.isArray(inp.default) ? inp.default.slice() : inp.default;
      continue;
    }
    values[inp.name] = inp.type === "multi" ? [] : "";
    if (inp.required && !parts.length) missing.push(inp.name);
  }
  return { values, missing, errors };
}

/**
 * 把 {{input.名字}} 换成填好的值：多选用顿号连起来，空的写「（没填）」，免得模型对着一个空洞瞎猜；
 * {{input.__json}} 换成整组值的一行 JSON（配方靠它把表单预填进第一条消息，必须一行）。
 * 一次替换；values 里没有的名字原样留着。
 * @param {string} prompt @param {Record<string, unknown>} values
 */
function fillInputs(prompt, values) {
  const v = values || {};
  return String(prompt).replace(INPUT_REF_RE, (m, n) => {
    if (n === INPUT_JSON) return JSON.stringify(v);
    if (!Object.prototype.hasOwnProperty.call(v, n)) return m;
    const x = v[n];
    const t = Array.isArray(x) ? x.map((y) => String(y).trim()).filter(Boolean).join("、") : String(x == null ? "" : x).trim();
    return t || EMPTY_INPUT;
  });
}

module.exports = {
  parse, fill, refs, MODES, MAX_STEPS, PASTE_MAX,
  inputRefs, resolveInputs, fillInputs, inputArgs, INPUT_RE, MAX_INPUTS,
};
