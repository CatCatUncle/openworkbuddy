"use strict";
/**
 * Jev（判断模型）的调用层：挑渠道、取 Key、发请求、把错翻成人话。
 *
 * 纯逻辑在 systemone.js，这儿只管「联网」这件带副作用的事。分两个文件是为了
 * 测试能把请求体和回答解析测透而一分钱不花——判断本身是纯函数，网络不是。
 *
 * 渠道怎么挑：**先用用户已经有的那把 Key**。
 * 绝大多数人不会为了试一个模型专门再去办一个号，而 OpenRouter 上就有这个模型
 * （走 /api/alpha/decisions 那条路，不是 /chat/completions）。所以配过 OpenRouter 的人
 * 什么都不用填就能用；真办了 TypeSafe 官方号的人，加一条 typesafe 渠道会优先走官方。
 *
 * 一条规矩跟 llm.js 一样：**不猜别家的 Key**。环境变量里的 TYPESAFE_API_KEY 只喂官方那条路，
 * OPENROUTER_API_KEY 只喂 OpenRouter 那条路，按渠道点名的 OPENWORKBUDDY_KEY_<渠道id> 最优先——
 * 那是用户自己指的。把 A 家的 Key 发给 B 家，轻则 401，重则把 Key 交到了不该去的地方。
 */

const so = require("./systemone");
const { cleanKey, _internals } = require("./llm");
const channelEnvName = _internals.channelEnvName;

/** 这个渠道类型能不能干判断这活儿。目录里加一家新的，改这儿一处 */
const ROUTE_OF_KIND = { typesafe: "typesafe", openrouter: "openrouter" };

function trim(x) { return String(x == null ? "" : x).trim(); }

/** 渠道行上的 Key：自己填的 → 按渠道点名的环境变量。到此为止，不往通用环境变量上退 */
function keyOfProvider(p) {
  const own = trim(p && p.api_key);
  if (own) return own;
  const named = channelEnvName(p && p.id);
  return named ? trim(process.env[named]) : "";
}

/**
 * 这台机器上，判断模型走哪条路。
 *
 * 返回 ok:false 的时候一定带 how——「没配」这种话本身没用，得说清下一步去哪儿点。
 */
function pickRoute(config) {
  const cfg = config || {};
  const d = cfg.decide || {};
  if (d.off === true) return { ok: false, why: "判断模型被关掉了（config.decide.off）", how: "把 config.decide.off 去掉就能再用" };

  // ① 明写的最大：地址和模型名都能自己指，接自建网关的人要的就是这个
  const want = trim(d.route).toLowerCase();
  if (trim(d.api_key) || trim(d.base_url) || (want && so.ROUTES[want])) {
    const base = so.ROUTES[want] || so.ROUTES.typesafe;
    const key = trim(d.api_key) || (d.channel ? keyOfProvider((cfg.providers || []).find((p) => p.id === d.channel) || {}) : "");
    const url = trim(d.base_url) || base.url;
    const model = trim(d.model) || base.model;
    if (!key && !/localhost|127\.0\.0\.1/.test(url)) {
      return { ok: false, why: "config.decide 指了渠道但没有 Key", how: "在 config.decide.api_key 填上，或者把 channel 指到一条填了 Key 的渠道" };
    }
    return { ok: true, route: base.id, label: trim(d.name) || base.label, url, model, key, from: "config.decide" };
  }

  // ② 配过的渠道。官方排在 OpenRouter 前面：专门去办了号的人，意思就是想走官方
  const provs = Array.isArray(cfg.providers) ? cfg.providers : [];
  for (const kind of ["typesafe", "openrouter"]) {
    const hit = provs.filter((p) => trim(p.kind) === kind).map((p) => ({ p, key: keyOfProvider(p) })).find((x) => x.key);
    if (hit) {
      const base = so.ROUTES[ROUTE_OF_KIND[kind]];
      // 他在渠道里填的地址说了算：填的是官方那个就还是官方，填的是自建网关就发去自建网关
      const url = so.urlFromBase(base.id, hit.p.base_url);
      return { ok: true, route: base.id, label: trim(hit.p.name) || base.label, url, model: trim(d.model) || base.model, key: hit.key, from: "渠道「" + (trim(hit.p.name) || hit.p.id) + "」" };
    }
  }

  // ③ 通用环境变量兜底。各认各家，不串
  const ts = trim(process.env.TYPESAFE_API_KEY);
  if (ts) return { ok: true, route: "typesafe", label: so.ROUTES.typesafe.label, url: so.ROUTES.typesafe.url, model: trim(d.model) || so.ROUTES.typesafe.model, key: ts, from: "环境变量 TYPESAFE_API_KEY" };
  const or = trim(process.env.OPENROUTER_API_KEY);
  if (or) return { ok: true, route: "openrouter", label: so.ROUTES.openrouter.label, url: so.ROUTES.openrouter.url, model: trim(d.model) || so.ROUTES.openrouter.model, key: or, from: "环境变量 OPENROUTER_API_KEY" };

  return {
    ok: false,
    why: "还没有能用的渠道",
    how: "两条路随便挑一条：① 设置 → 模型 里已经有 OpenRouter 渠道的话，填上 Key 就能用，判断模型跟对话模型共用同一把；② 去 " + so.ROUTES.typesafe.key_url + " 办一把 TypeSafe 的 Key，加一条「TypeSafe」渠道",
  };
}

/** 判断模型现在能不能用，给界面和 doctor 看的一张小卡片（**不含 Key**） */
function status(config) {
  const r = pickRoute(config);
  if (!r.ok) return { ready: false, why: r.why, how: r.how };
  return { ready: true, route: r.route, label: r.label, model: r.model, url: r.url, from: r.from };
}

/**
 * 问一趟。
 *
 * 超时给 20 秒：这个模型正常三五百毫秒就回来了，20 秒还没动静一定是网络层面的事，
 * 再等下去只是让调用点白挂着。判断是用来「省时间」的，等它等出等待感就本末倒置了。
 */
async function ask(config, { state, questions, model, timeoutMs, signal } = {}) {
  const r = pickRoute(config);
  if (!r.ok) return { ok: false, error: r.why + "。" + r.how, notReady: true };

  const { questions: qs, errs } = so.normalizeQuestions(questions);
  if (errs.length) return { ok: false, error: errs.join("；"), badRequest: true };
  const st = so.stateOf(state);
  if (!st.state || (typeof st.state === "string" && !st.state.trim())) {
    return { ok: false, error: "没给它要判断的东西（state）——问题问得再清楚，没有材料它也判断不了", badRequest: true };
  }

  let key = "";
  try { key = cleanKey(r.key, { name: r.label }); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }

  const body = so.buildBody({ model: trim(model) || r.model, state: st.state, questions: qs });
  const ms0 = Date.now();
  let res, text;
  try {
    res = await fetch(r.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(Number(timeoutMs) > 0 ? Number(timeoutMs) : 20000),
    });
    text = await res.text();
  } catch (e) {
    const msg = String((e && e.message) || e);
    const why = /timeout|abort/i.test(msg) ? "超时了，这台机器到 " + r.url.replace(/^https?:\/\//, "").split("/")[0] + " 的网不通（挂代理再试）" : "连不上：" + msg.slice(0, 200);
    return { ok: false, error: why, ms: Date.now() - ms0, route: r.route };
  }
  if (!res.ok) return { ok: false, error: so.errorOf(res.status, text), status: res.status, ms: Date.now() - ms0, route: r.route };

  let json;
  try { json = JSON.parse(text); } catch { return { ok: false, error: "上游回的不是 JSON：" + trim(text).slice(0, 200), ms: Date.now() - ms0, route: r.route }; }
  const out = so.readAnswers(json);
  return {
    ok: true, ...out,
    ms: Date.now() - ms0, route: r.route, label: r.label, asked: trim(model) || r.model,
    // 截过就说，别让人以为它看了全文——判断是拿前半段做的，这种错事后最难查
    truncated: st.cut, state_chars: st.chars,
  };
}

/** 按名字取一条回答，取不到返回 null（而不是抛）——调用点大多是「取到就用，取不到走老路」 */
function pick(out, key) {
  if (!out || !out.ok || !Array.isArray(out.answers)) return null;
  return out.answers.find((a) => a.key === key) || null;
}

/**
 * 测活：拿一段固定的材料真问一趟，把「通不通、多快、多少钱」一次说清。
 *
 * 为什么用固定材料而不是 "ping"：判断模型对着一个没有信息的字符串也会给出答案，
 * 那种答案看不出它到底有没有在读材料。这段客服工单里「三天了、在丢单、ASAP」是明写的，
 * 分流和紧急度都该压得很高——答出来的数不对劲，一眼就看得见，不用再去猜是不是接错了。
 */
async function selftest(config, opts) {
  const state = "客服工单：我的 Stripe 收款账号连了三天都连不上，一直失败，现在订单都在丢，麻烦尽快。";
  const out = await ask(config, {
    state,
    questions: {
      归谁处理: so.choice("这条工单该交给哪个组", { 支付: "收款、账单、订阅相关", 技术: "程序出错、对接不上", 销售: "问价格、问方案" }),
      有多急: so.score("这位客户有多着急", ["不急，只是问一声", "希望尽快", "已经在造成损失了"]),
      要不要升级: so.noul("这条工单该升级给主管跟进"),
    },
    ...(opts || {}),
  });
  return { ...out, state };
}

module.exports = { pickRoute, status, ask, pick, selftest, ROUTE_OF_KIND, keyOfProvider };
