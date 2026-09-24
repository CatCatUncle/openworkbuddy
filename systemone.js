// @ts-check
"use strict";
/**
 * Jev / System One —— 「判断模型」这条调用路的纯逻辑层。
 *
 * 它跟 config.models 里那些对话模型不是一回事，所以没往那张表里塞：
 * 对话模型吃一段话、吐一段话，拿到手的是文字，准不准得自己读；
 * Jev 吃一段**状态**加一道**有类型的问题**，吐回来的是代码能直接用的值——
 * 选中的那个选项、一个分数、或者一个 0~1 的概率，另外附一个「我有多确定」。
 * 它根本不会写字，让它写也写不出来。
 *
 * 为什么值得单开一条路：程序里真正要用到模型的地方，一多半并不需要它写字，
 * 只需要它拿个主意——这条需求归哪一路干？这个文件是最终产物还是中间过程？
 * 动手之前该不该先问用户一声？以前只能让对话模型输出 JSON 再解析，慢、贵，
 * 还得防着它在 JSON 前面多客气两句。这条路一次判断三五百毫秒、两万分之一美金，
 * 而且输出类型是**上游保证**的，不是我们解析出来的。
 *
 * 这一层是纯的：不联网、不读配置、不打日志、不看表。发请求在 jev.js，
 * 这儿只管三件事——请求长什么样、回答怎么读、读不懂的时候怎么说人话。
 * 所以测试能直接拿假数据喂它，不用起服务、不用花钱。
 */

/**
 * 两条上游，**同一套请求体**。
 *
 * 这是接这个模型时最值钱的一条发现：OpenRouter 把判断模型放在
 * /api/alpha/decisions 这条独立的路上，请求体跟 TypeSafe 官方的 /v1/systemone
 * 一模一样，只有地址、Key 和模型名不同。所以下面 buildBody 只有一份，
 * 不需要为两家各写一套适配。
 *
 * 另外记一笔踩过的坑：拿 /chat/completions 打 typesafe/jev-1.13 会被 400 顶回来，
 * 原话是 "is a decisions model and cannot be used with the chat/completions endpoint"。
 * 报错很清楚，但前提是你得先知道有 decisions 这条路——文档里没有，是打出来的。
 */
const ROUTES = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    url: "https://openrouter.ai/api/alpha/decisions",
    base: "https://openrouter.ai/api/v1",  // 渠道里存的是这个（对话接口用的），decisions 不在 /v1 底下
    tail: "/alpha/decisions",
    strip_v1: true,
    model: "typesafe/jev-1.13",
    key_url: "https://openrouter.ai/keys",
    why: "想拿 OpenRouter 的 Key 跑：Jev 渠道的地址填 openrouter.ai（不会自动借聊天那条渠道）",
  },
  typesafe: {
    id: "typesafe",
    label: "TypeSafe 官方",
    url: "https://api.typesafe.ai/v1/systemone",
    base: "https://api.typesafe.ai/v1",
    tail: "/systemone",
    strip_v1: false,
    model: "jev-latest",
    key_url: "https://console.typesafe.ai/settings/keys",
    why: "直连出厂那家，模型名不带厂商前缀（jev-latest / jev-1.13.0）",
  },
};
const ROUTE_IDS = Object.keys(ROUTES);

/**
 * 这个模型名是不是判断模型。
 *
 * 用在「别把它挂进对话模型列表」那道闸上。下拉里按**渠道种类**已经挡住了（decide_only），
 * 可模型名是一个自由输入框——手打一个 `typesafe/jev-latest` 照收，存得下、选得中，
 * 而它没有 /chat/completions，每一趟都是 400。列表里它跟别的条目长得一模一样，
 * 这正是 test/systemone.js 开头列的第一类静默失败。
 *
 * 只认有把握的两种写法，认不准就放行：拦错一个能用的模型，比漏掉一个坏的更惹人。
 * 开头那些 `~` 是粘贴时常带进来的，先削掉再判。
 */
function isDecisionModel(name) {
  const s = String(name == null ? "" : name).trim().toLowerCase().replace(/^[~\s]+/, "");
  if (!s) return false;
  return /^typesafe\//.test(s) || /(^|\/)jev(-[a-z0-9.]+)?$/.test(s);
}

/** 三种问法。加第四种要等上游先支持，这儿写死是故意的——写了上游不认，错要到线上才看得见 */
const KINDS = ["noul", "choice", "score"];
const KIND_CN = { noul: "是非", choice: "单选", score: "打分" };

/**
 * 状态截多长。
 *
 * 上游的账是按 token 算的：一次请求 64k，其中「state ＋ 最长的那道题」不超过 32k。
 * 我们这儿没有它的分词器，只能按字符卡——中文最坏情况一个字顶一个多 token，
 * 两万字符留了足够的余量，又不至于把一份正常的会议纪要拦腰砍断。
 * 真砍了会在返回里说一声（cut: true），不能砍完了装作没砍过：
 * 判断是拿后半段的内容做的，人却以为它看了全文，这种错最难查。
 */
const MAX_STATE = 20000;
/** 一次最多几道题。64k 的预算是 state 加上所有题一起算的，题堆太多会把 state 挤没 */
const MAX_QUESTIONS = 32;
/** 默认的确定度门槛：低于它就别自动照做，回头问人。0.7 是个保守起点，调用方可以自己给 */
const SURE_MIN = 0.7;

function isStr(x) { return typeof x === "string" && x.trim() !== ""; }
function txt(x) { return String(x == null ? "" : x).trim(); }

/** 三个小构造器。手写对象也行，这只是让调用点少几行括号 */
function noul(instructions) { return { type: "noul", instructions: txt(instructions) }; }
function choice(instructions, criteria) { return { type: "choice", instructions: txt(instructions), criteria }; }
function score(instructions, criteria) { return { type: "score", instructions: txt(instructions), criteria }; }

/**
 * 把调用方写的问题规整成上游认的样子，顺带把能提前发现的错挑出来。
 *
 * 为什么要自己先查一遍，而不是直接发过去让上游报错：上游的 400 是一坨 zod 的
 * issue 数组（"invalid_union" / "No matching discriminator"），给程序员看都得愣一下，
 * 落到界面上更是天书。而且发一趟要等几百毫秒、要花钱——类型写错这种事，
 * 本地一眼就能看出来。
 *
 * 顺手做两个宽容：
 *   · choice 的选项给数组也认（["表格","写作"] → {表格:"表格", 写作:"写作"}）。
 *     命令行上让人敲一串 key: value 太难为人了。
 *   · score 的档位给 {0:"…",1:"…"} 这种对象也认，按数字键排好转成数组。
 *     回答里 legend 就是这个形状，照抄回来再问一次是很自然的用法。
 */
function normalizeQuestions(raw) {
  const errs = [];
  const questions = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { questions, errs: ["问题得是一个对象：{ 名字: { type, instructions, … } }"] };
  }
  const keys = Object.keys(raw);
  if (!keys.length) return { questions, errs: ["一道题都没有——Jev 是来回答问题的，光给它状态它不知道你要判断什么"] };
  if (keys.length > MAX_QUESTIONS) {
    errs.push(`一次最多问 ${MAX_QUESTIONS} 道，现在有 ${keys.length} 道。上游 64k 的预算是状态和所有题一起算的，题太多会把状态挤没`);
  }
  for (const k of keys.slice(0, MAX_QUESTIONS)) {
    const q = raw[k] || {};
    const at = `问题「${k}」`;
    if (!isStr(k)) { errs.push("问题的名字不能是空的——回答是按这个名字取回来的"); continue; }
    const type = txt(q.type).toLowerCase();
    if (!KINDS.includes(type)) {
      errs.push(`${at}的 type 是「${type || "空"}」，只能是 noul（是非）/ choice（单选）/ score（打分）`);
      continue;
    }
    const instructions = txt(q.instructions);
    if (!instructions) { errs.push(`${at}没写要判断什么（instructions）`); continue; }
    if (type === "noul") {
      questions[k] = { type, instructions };
      continue;
    }
    if (type === "choice") {
      let crit = q.criteria;
      if (Array.isArray(crit)) {
        const m = {};
        for (const o of crit) if (isStr(o)) m[txt(o)] = txt(o);
        crit = m;
      }
      const names = crit && typeof crit === "object" ? Object.keys(crit).filter((n) => isStr(n)) : [];
      if (names.length < 2) { errs.push(`${at}是单选，至少得给两个选项——只有一个选项不叫选`); continue; }
      const out = {};
      for (const n of names) out[n] = isStr(crit[n]) ? txt(crit[n]) : n;
      questions[k] = { type, instructions, criteria: out };
      continue;
    }
    // score：档位是**有序**的，顺序就是分数 0、1、2…，所以对象形态必须按数字键排
    let lv = q.criteria;
    if (lv && !Array.isArray(lv) && typeof lv === "object") {
      lv = Object.keys(lv)
        .filter((n) => /^\d+$/.test(n))
        .sort((a, b) => Number(a) - Number(b))
        .map((n) => lv[n]);
    }
    const levels = Array.isArray(lv) ? lv.filter((x) => isStr(x)).map(txt) : [];
    if (levels.length < 2) { errs.push(`${at}是打分，至少得给两档，从低到高排——档位的顺序就是分数 0、1、2…`); continue; }
    questions[k] = { type, instructions, criteria: levels };
  }
  return { questions, errs };
}

/**
 * 状态整理成上游收得下的形状。
 *
 * 上游认三种：一段文字、一个 JSON 对象、一个文字数组。对象和数组不拍平成文字——
 * 字段名本身就是信息（"最近打开": "从没打开过" 比 "最近打开 从没打开过" 好认），
 * 拍平反而是在扔掉结构。只在总长超预算的时候才退回按 JSON 截断。
 */
function stateOf(x, max) {
  const cap = Number(max) > 0 ? Number(max) : MAX_STATE;
  if (x == null) return { state: "", cut: false, chars: 0 };
  if (typeof x === "string") {
    const s = x;
    return s.length > cap ? { state: s.slice(0, cap), cut: true, chars: s.length } : { state: s, cut: false, chars: s.length };
  }
  let json = "";
  try { json = JSON.stringify(x); } catch { json = ""; }
  if (!json) return { state: String(x).slice(0, cap), cut: String(x).length > cap, chars: String(x).length };
  if (json.length <= cap) return { state: x, cut: false, chars: json.length };
  // 超了就退成被截断的文字：截过的 JSON 不再是合法 JSON，硬塞回去上游会 400
  return { state: json.slice(0, cap), cut: true, chars: json.length };
}

/** 请求体。两条上游共用这一份，差别只在 model 和地址 */
function buildBody({ model, state, questions }) {
  return { model: txt(model), state, questions };
}

/** 一条 noul 的「有多拿得准」：0.5 是完全没主意，两头才是有主意。上游不报这个数，是我们算的 */
function sureOfNoul(p) {
  const v = Number(p);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, Math.abs(v - 0.5) * 2));
}

function probsOf(obj) {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj)
    .map((name) => ({ name, p: Number(obj[name]) || 0 }))
    .sort((a, b) => b.p - a.p);
}

function pct(p) {
  const v = Number(p);
  if (!Number.isFinite(v)) return "—";
  return (v >= 0.995 || v <= 0.005 ? Math.round(v * 100) : Math.round(v * 1000) / 10) + "%";
}

/**
 * 回答读成一套固定的形状，界面和命令行都照这份读，不用各认各的字段。
 *
 *   { key, type, value, label, confidence, sure, probs:[{name,p}], legend:[] }
 *
 * confidence 和 sure 分开摆是有意的：confidence 是上游报的，noul 那一类**根本没有**这个字段
 * （回答就只有一个概率）。这时候 confidence 是 null，sure 是我们按概率离 0.5 多远算出来的。
 * 合成一个字段会让人以为 noul 的确定度也是模型给的——它不是，别让人拿我们算的数去做审计。
 */
function readAnswers(json) {
  const j = json || {};
  const src = j.answers && typeof j.answers === "object" ? j.answers : {};
  const answers = [];
  for (const key of Object.keys(src)) {
    const a = src[key] || {};
    const type = txt(a.type).toLowerCase();
    const conf = Number.isFinite(Number(a.confidence)) ? Number(a.confidence) : null;
    if (type === "noul") {
      const p = Number(a.noul);
      answers.push({
        key, type, value: Number.isFinite(p) ? p : null,
        label: !Number.isFinite(p) ? "没读懂" : (p >= 0.5 ? "是" : "否"),
        confidence: null, sure: sureOfNoul(p), probs: [], legend: [],
      });
      continue;
    }
    if (type === "choice") {
      const v = txt(a.choice);
      answers.push({
        key, type, value: v || null, label: v || "没读懂",
        confidence: conf, sure: conf == null ? 0 : conf, probs: probsOf(a.probabilities), legend: [],
      });
      continue;
    }
    if (type === "score") {
      const v = Number(a.score);
      const legend = a.legend && typeof a.legend === "object"
        ? Object.keys(a.legend).filter((n) => /^\d+$/.test(n)).sort((x, y) => Number(x) - Number(y)).map((n) => txt(a.legend[n]))
        : [];
      const near = Number.isFinite(v) ? legend[Math.min(legend.length - 1, Math.max(0, Math.round(v)))] : "";
      answers.push({
        key, type, value: Number.isFinite(v) ? v : null,
        label: Number.isFinite(v) ? (near || String(Math.round(v * 100) / 100)) : "没读懂",
        confidence: conf, sure: conf == null ? 0 : conf, probs: probsOf(a.probabilities), legend,
      });
      continue;
    }
    // 上游哪天加了第四种问法：原样留着，别假装读懂了
    answers.push({ key, type: type || "未知", value: null, label: "这一类我还不认识（" + (type || "没写 type") + "）", confidence: conf, sure: 0, probs: [], legend: [] });
  }
  const u = j.usage || {};
  return {
    model: txt(j.model),
    id: txt(j.id),
    answers,
    usage: {
      input_tokens: Number(u.input_tokens) || 0,
      output_tokens: Number(u.output_tokens) || 0,
      cost: Number.isFinite(Number(u.cost)) ? Number(u.cost) : null,
    },
  };
}

/** 一条回答印成一行。命令行和界面共用这句话，省得两边各编一套说法 */
function lineOf(a) {
  if (!a) return "";
  if (a.type === "noul") {
    if (a.value == null) return `${a.key}：没读懂`;
    const hedge = a.sure < 0.3 ? "（拿不准）" : "";
    return `${a.key}：${a.label} · ${pct(a.value)}${hedge}`;
  }
  if (a.type === "choice") {
    const rest = a.probs.slice(1, 3).filter((x) => x.p >= 0.01).map((x) => `${x.name} ${pct(x.p)}`).join("、");
    return `${a.key}：${a.label} · ${pct((a.probs[0] || {}).p)}　确定度 ${pct(a.confidence)}${rest ? "　其次：" + rest : ""}`;
  }
  if (a.type === "score") {
    const n = a.value == null ? "—" : Math.round(a.value * 100) / 100;
    return `${a.key}：${n} ${a.label}　确定度 ${pct(a.confidence)}`;
  }
  return `${a.key}：${a.label}`;
}

/**
 * 确定度闸门：这条回答能不能直接照做。
 *
 * 判断模型最值钱的地方不是「它答得准」，是「它知道自己什么时候不准」。
 * 所以调用点的正确写法是两层：先看答案是什么，再看敢不敢照着办——
 * 不敢就回退到问人、或者退回原来那条老路，而不是硬着头皮往下走。
 */
function gate(a, min) {
  const bar = Number.isFinite(Number(min)) ? Number(min) : SURE_MIN;
  if (!a || a.value == null) return { act: false, why: "这道题没答上来" };
  const s = Number(a.sure) || 0;
  if (s < bar) return { act: false, why: `确定度 ${pct(s)} 不到 ${pct(bar)}，这一条别自动照做，回头问一声` };
  return { act: true, why: `确定度 ${pct(s)}` };
}

/**
 * 上游的错翻成人话。
 *
 * 400 单独挑出来说：判断模型的 400 几乎全是请求体写错了（type 拼错、选项少于两个），
 * 上游回的是一串 zod issue，里头的 path 恰恰指着是哪道题的哪个字段错了——
 * 把那一条捞出来，比把整坨 JSON 摔给用户有用得多。
 */
function errorOf(status, text) {
  const s = Number(status) || 0;
  const body = txt(text).slice(0, 600);
  if (s === 401 || s === 403) return "这把 Key 上游不认（HTTP " + s + "）。判断模型跟对话模型是同一把 Key，先确认这个渠道本身是通的";
  if (s === 402) return "Key 有效但余额不够了，去服务商后台充值再试";
  if (s === 404) return "地址或模型名不对（404）。OpenRouter 那条路是 /api/alpha/decisions，模型名要写 typesafe/jev-1.13；官方那条是 /v1/systemone，模型名写 jev-latest";
  if (s === 429) return "被限流了（429），歇一会儿再来";
  if (s === 400) {
    const spot = zodSpot(body);
    if (spot) return "问题写得上游不认：" + spot;
    const m = body.match(/"message"\s*:\s*"([^"]{2,200})"/);
    if (m) return "上游说这个请求不对：" + m[1];
    return "上游说这个请求不对（400）：" + body.slice(0, 200);
  }
  if (!s) return "连不上：" + (body || "没拿到回应");
  return `上游返回 HTTP ${s}：${body.slice(0, 200)}`;
}

/**
 * 渠道里填的是 base_url（对话接口那个），判断接口得自己接上后半截。
 *
 * 这一步不接的话会出一件很难查的事：有人把渠道指到自建网关，我们却照旧发去官方那台，
 * 等于把他网关的 Key 送到了另一家门口。宁可打不通，也不能发错地方。
 *
 * OpenRouter 要先把尾巴上的 /v1 摘掉——它的 decisions 不在 /v1 底下，而人填渠道时填的一定是带 /v1 的那个。
 */
function urlFromBase(routeId, base) {
  const r = ROUTES[routeId] || ROUTES.typesafe;
  let b = txt(base).replace(/\/+$/, "");
  if (!b) return r.url;
  if (r.strip_v1) b = b.replace(/\/v1$/, "");
  return b + r.tail;
}

/** 从 zod 的 issue 串里捞出「哪一道题的哪个字段」。捞不出来就别硬编，返回空让调用方退回原文 */
function zodSpot(raw) {
  // 那一坨 issue 常常是被塞进 error.message 里的**字符串**，整个转义过一道（\" \n）。
  // 先把转义抹平再捞，不然同一个错在两家上游身上一个捞得出一个捞不出。
  const body = String(raw || "").replace(/\\"/g, '"').replace(/\\n/g, "\n");
  const path = body.match(/"path"\s*:\s*\[([^\]]*)\]/);
  const msg = body.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
  if (!path) return "";
  const parts = path[1].split(",").map((x) => txt(x).replace(/^"|"$/g, "")).filter(Boolean);
  if (!parts.length) return "";
  const where = parts.join(".");
  const last = msg && msg.length ? txt(msg[msg.length - 1]).replace(/^"message"\s*:\s*"/, "").replace(/"$/, "") : "";
  return where + (last ? "：" + last.replace(/\\n/g, " ").slice(0, 160) : " 这个字段不对");
}

/** 这一趟花了多少。上游给了 cost 就用它的（它自己才知道折扣），没给就按输入 token 估——输出 token 是免费的 */
const PRICE_PER_MTOK = 0.042;
function costOf(usage) {
  const u = usage || {};
  if (Number.isFinite(Number(u.cost))) return { usd: Number(u.cost), estimated: false };
  const t = Number(u.input_tokens) || 0;
  return { usd: (t / 1e6) * PRICE_PER_MTOK, estimated: true };
}

/** 钱少到用美分说都嫌大，专门印一行给人看 */
function costText(usage) {
  const c = costOf(usage);
  const u = usage || {};
  const n = c.usd >= 0.01 ? "$" + c.usd.toFixed(4) : "$" + c.usd.toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
  return `${Number(u.input_tokens) || 0} 进 / ${Number(u.output_tokens) || 0} 出 token，${n}${c.estimated ? "（估的）" : ""}　—— 输出 token 不要钱`;
}

module.exports = {
  ROUTES, ROUTE_IDS, KINDS, KIND_CN, MAX_STATE, MAX_QUESTIONS, SURE_MIN, PRICE_PER_MTOK,
  isDecisionModel,
  noul, choice, score,
  normalizeQuestions, stateOf, buildBody, urlFromBase, readAnswers, lineOf, gate, errorOf, zodSpot,
  costOf, costText, probsOf, pct, sureOfNoul,
};
