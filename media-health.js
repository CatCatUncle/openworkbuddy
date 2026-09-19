"use strict";
/**
 * 连不通的那条渠道，别让 agent 一轮一轮去撞。
 *
 * 用户原话：「一些不能用的模型，不要一直去用啊！」「之前一些 trace 出现了一直看图，
 * 看图模型不可用的问题啊」。
 *
 * 病根不在工具的返回文案——tools.js 里早就写着「这不是问法的问题，重试多少次都一样」。
 * 问题是那句话只是**建议**：模型看完照样再调一次，换个措辞再调一次，一趟任务里能撞四十次
 * 402。每一次都是一个真实的网络往返、一次 20 秒超时、一段烧掉的上下文。
 *
 * 所以把「不许重试」从一句话变成一道闸：撞过一次的硬错，下一次连请求都不发，
 * 直接把上次那句原样奉还。模型再固执也只能原地打转半毫秒，而不是半分钟。
 *
 * 什么算硬错，标准只有一条：**换个问法、等一会儿，结果会不会变**。
 *   401/403 钥匙不对、402 没余额、404 型号不存在 —— 不会变，见一次就断。
 *   429 限流、5xx、超时、DNS —— 会变，连着三次才断，断五分钟。
 *   400/422 —— 多半是这次的 prompt 或这张图的事（内容策略、尺寸不合法），
 *              换一次输入就可能过，一次都不计。把它算进去等于因为一张图违规
 *              就把整条生图渠道关了。
 *   **例外看正文**：状态码撒谎的时候正文不撒谎。OpenRouter 把「型号 ID 不存在」报成 400，
 *   火山把「账号欠费」报成 400/403 带 AccountOverdue——这两种换一百次问法结果都一样，
 *   正文里只要说的是「没余额」或「没这个型号」，不管什么状态码都按硬错断。
 *   用户原话：「这个看图模型我现在没有付费用不了的啊，你不要一直给我调用浪费这个 agent 执行时间啊」
 *
 * 自愈的路留了三条，缺一条都会变成「我明明充值了它还是不干活」：
 *   1. 配置动了（地址/型号/Key 任一变了）→ 指纹变了，自然是新的一格；
 *   2. 用户在设置页按了保存 → server.js 调 reset()，当他已经去处理了；
 *   3. 熬过冷却期 → 硬错也有 30 分钟的到期，充值不改配置的那种情况靠它。
 */

const crypto = require("crypto");

const HARD = new Set([401, 402, 403, 404]); // 见一次就断
const IGNORE = new Set([400, 422]);         // 这一次输入的事，不计入渠道健康
const SOFT_LIMIT = 3;                        // 软错连着几次才断
const SOFT_COOL_MS = 5 * 60 * 1000;
const HARD_COOL_MS = 30 * 60 * 1000;

/** cap|渠道指纹 → { until, why, http, hard, soft } */
const bucket = new Map();

/**
 * 一条渠道的身份。Key 要参与——用户把敲错的 Key 改对了，就该是新的一格，
 * 不然他改完还得等半小时。但绝不存原文：只留 sha256 的前 8 位，
 * 这张表会被 /api/media-health 读出去给界面看。
 */
function fingerprint(cap, cfg) {
  const c = cfg || {};
  const key = String(c.api_key || "");
  const fp = key ? crypto.createHash("sha256").update(key).digest("hex").slice(0, 8) : "-";
  return [cap, String(c.base_url || ""), String(c.model || ""), fp].join("|");
}

/** 从工具返回的那句话里认出 HTTP 状态码。tools.js 里五路媒体工具共用同一套措辞：
 *  `视觉模型错误 401: …` / `图像接口错误 402: …` / `视频接口错误 404（base_resp …）: …`
 *  / `视觉模型这条渠道没余额了（HTTP 402）`。test/media-health.js 里有一条结构性断言：
 *  它把 tools.js 源码里所有 `错误 ${r.status}` 模板都扫出来对一遍，谁改了措辞谁的测试会红。 */
function statusOf(text) {
  const m = String(text || "").match(/(?:错误|HTTP)\s*[（(]?\s*(\d{3})/);
  return m ? Number(m[1]) : 0;
}

/** 网络层没走到 HTTP 就挂了的那些（超时、DNS、连接被拒）——算软错 */
function looksNetwork(text) {
  return /请求失败|timeout|超时|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(String(text || ""));
}
/** 正文说的是「没余额」：状态码不管是 402 还是 400/403，充值之前都不会变 */
function looksBroke(text) {
  return /没余额|余额不足|欠费|insufficient[_ ](credit|balance|quota|funds)|out of credits|AccountOverdue|account (is )?overdue|in arrears|payment required|quota (has been )?exhausted|exceeded your current quota|check your plan and billing|billing hard limit/i.test(String(text || ""));
}
/** 正文说的是「没这个型号」：OpenRouter 报 400「is not a valid model ID」，火山报 404 ModelNotOpen——换问法不会变 */
function looksNoModel(text) {
  return /not a valid model|invalid model|model[_ ]not[_ ]found|no such model|unknown model|model .{0,60}(does not exist|doesn't exist|not exist)|ModelNotOpen|ModelNotFound|模型不存在|不存在的模型|型号不存在|未开通/i.test(String(text || ""));
}

function now() { return Date.now(); }

/**
 * 发请求之前问一句：这条渠道现在还值不值得撞？
 * 返回 null 表示放行；返回 {content, isError} 表示别发了，把这个原样交回给 agent。
 */
function gate(cap, cfg, capCn) {
  const b = bucket.get(fingerprint(cap, cfg));
  if (!b || b.until <= now()) return null;
  const mins = Math.max(1, Math.ceil((b.until - now()) / 60000));
  const what = capCn || cap;
  return {
    content:
      `【${what}这条渠道已暂停】上一次调用是 ${b.why}。\n` +
      `这不是这次问法/提示词的问题，重试还是同一个结果，所以这一次连请求都没发出去（省下的是你的时间和用户的钱）。\n` +
      `${b.hard ? "请用户去 设置 → 模型 里换一条渠道或把这条修好" : `等 ${mins} 分钟后会自动再试一次`}` +
      `，改完设置按一下保存即刻恢复。\n` +
      `现在别再调这个工具了，也不许把没拿到的结果当拿到过写进结论——如实说这一步没做成。`,
    isError: true,
    mediaBreaker: true, // 给 agent.js / 测试认的标记：这条不是上游返回的，是本地闸拦的
  };
}

/**
 * 一次调用的结果记一笔。成功就把这条渠道的账清了。
 * res 是媒体工具的返回值 {content, isError}。
 */
function record(cap, cfg, res) {
  const id = fingerprint(cap, cfg);
  if (!res || !res.isError) { bucket.delete(id); return null; } // 成功过一次，前面的账一笔勾销
  if (res.mediaBreaker) return bucket.get(id) || null;          // 本地闸自己拦的，不算新账

  const text = res.content || "";
  const http = statusOf(text);
  const broke = looksBroke(text);
  const noModel = !broke && looksNoModel(text);
  if (IGNORE.has(http) && !broke && !noModel) return null;

  const b = bucket.get(id) || { until: 0, why: "", http: 0, hard: false, soft: 0 };
  if (HARD.has(http) || broke || noModel) {
    b.hard = true; b.http = http; b.soft = 0;
    const why = broke ? "这条渠道没余额了" : noModel ? "这条渠道上没有这个型号（型号名写错、没开通，或者挂错了渠道）"
      : { 401: "Key 不对或没权限", 402: "这条渠道没余额了", 403: "被拒绝访问", 404: "地址或型号不存在" }[http];
    b.why = http ? `HTTP ${http}（${why}）` : why;
    b.until = now() + HARD_COOL_MS;
  } else if (http >= 500 || http === 429 || http === 408 || looksNetwork(text)) {
    b.soft += 1; b.http = http;
    if (b.soft < SOFT_LIMIT) { bucket.set(id, b); return null; } // 还没到三次，先记着不断
    b.why = http ? `连着 ${b.soft} 次 HTTP ${http}` : `连着 ${b.soft} 次连不上`;
    b.until = now() + SOFT_COOL_MS;
  } else {
    return null; // 认不出来的错（空正文、没返回图片…）不动渠道健康：那是内容层面的事
  }
  bucket.set(id, b);
  return b;
}

/** 用户在设置页按了保存：当他已经去处理了，全部放行重来 */
function reset(cap) {
  if (!cap) { bucket.clear(); return; }
  for (const k of [...bucket.keys()]) if (k.startsWith(cap + "|")) bucket.delete(k);
}

/** 界面要显示「哪条渠道现在是停的」。只回 cap 和原因，指纹里那 8 位哈希不出门。 */
function list() {
  const out = [];
  for (const [k, b] of bucket) {
    if (b.until <= now()) continue;
    const [cap, base, model] = k.split("|");
    out.push({ cap, base_url: base, model, why: b.why, http: b.http, hard: !!b.hard, until: b.until });
  }
  return out;
}

module.exports = { gate, record, reset, list, statusOf, looksBroke, looksNoModel, fingerprint, HARD, IGNORE, SOFT_LIMIT, SOFT_COOL_MS, HARD_COOL_MS, _bucket: bucket };
