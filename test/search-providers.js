"use strict";
/**
 * 联网搜索的八家服务商 —— 请求发得对不对、回来的东西认不认得出来。
 *
 *   node test/search-providers.js
 *
 * 不联网：把 global.fetch 换掉，喂进去的是各家**文档上写的那个**返回体。
 * 所以这套测的不是「对方今天在不在线」，而是我们这边有没有按人家的规矩发、按人家的形状收。
 *
 * 盯的是三种在界面上长得一模一样、原因却完全不同的坏法：
 *
 *   A. **字段名叫错，对方不报错**。七牛的条数字段叫 max_results，写成 count 的话
 *      对方按自己的默认条数回——要 3 条回 10 条，看着像「能用」，参数其实一直没生效。
 *      所以下面每一家都断言**发出去的那个请求**长什么样，不只看收回来的。
 *
 *   B. **HTTP 200，但里面写着错**。国内这几家 Key 填错时照样回 200，错情在 body 的
 *      code/msg 里。不认这一层的话，界面上只显示「返回 0 条结果」——
 *      人会以为是没搜到，去换关键词，换到天亮还是 0 条。
 *
 *   C. **状态码甩人脸上**。「搜索失败（402）」对屏幕前的人等于没说。
 *      401 是去换 Key、402 是去充值、429 是等一会儿，三件事差得远。
 *
 * 每条正向断言后面都跟反向对照：把那一条的依据抽掉，它必须变红。
 */

const tools = require("../tools");
const { SEARCH_PROVIDERS, searchProviderKey, searchProviderReady } = tools;
const { searchBodyError, toItems, pickHits, SEARCH_HTTP_HINT } = tools._internals;
const fs = require("fs");
const path = require("path");
const { src } = require("./lib/src"); // server / tools / canvas 三组源码的唯一读法，见 test/lib/src.js

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  ← " + String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 300) : "")); }
}

// ---------- 假的 fetch：记下发出去的请求，回一个我们指定的响应 ----------
const realFetch = global.fetch;
let sent = [];
function stub(status, body, { raw = false } = {}) {
  const text = raw ? String(body) : JSON.stringify(body);
  global.fetch = async (url, init) => {
    sent.push({ url: String(url), init: init || {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  };
}
const lastReq = () => {
  const r = sent[sent.length - 1] || { url: "", init: {} };
  let body = null;
  try { body = r.init.body ? JSON.parse(r.init.body) : null; } catch {}
  const h = {};
  for (const [k, v] of Object.entries(r.init.headers || {})) h[k.toLowerCase()] = v;
  return { url: r.url, method: r.init.method || "GET", headers: h, body };
};
const KEY = "TESTKEY-0000";            // 假的，不碰用户 config.json
const err = async (fn) => { try { await fn(); return ""; } catch (e) { return String(e.message || e); } };

// ---------- 每家的「文档上那个返回体」 + 它该被发成什么样 ----------
// where：Key 应该出现在哪个请求头里（值只比对「带没带这把 Key」，不打印）
const VENDORS = {
  bocha: {
    名: "博查",
    host: "api.bochaai.com", path: "/v1/web-search", method: "POST", keyHeader: "authorization",
    // 博查对齐的是 Bing 的形状：标题在 name 不在 title，摘要在 summary/snippet
    body: { code: 200, log_id: "L1", msg: null, data: { _type: "SearchResponse", queryContext: { originalQuery: "OpenAI" },
      webPages: { webSearchUrl: "", totalEstimatedMatches: 42, value: [
        { id: "1", name: "博查的标题", url: "https://a.example/1", displayUrl: "a.example/1", snippet: "短摘要", summary: "博查的长摘要", siteName: "A站", dateLastCrawled: "2026-09-01" },
        { id: "2", name: "第二条", url: "https://a.example/2", snippet: "第二条摘要", siteName: "A站" },
      ] } } },
    // 错情走 code/msg，HTTP 还是 200
    错body: { code: 401, msg: "Invalid API key", data: null }, 错里有: "Invalid API key",
    条数字段: "count",
    问题字段: "query",
  },
  zhipu: {
    名: "智谱",
    host: "open.bigmodel.cn", path: "/api/paas/v4/web_search", method: "POST", keyHeader: "authorization",
    // 智谱的链接字段叫 link 不叫 url，正文叫 content
    body: { id: "x", created: 1, request_id: "r1", search_intent: [], search_result: [
      { title: "智谱的标题", content: "智谱的正文", link: "https://b.example/1", media: "B媒体", icon: "", refer: "ref_1", publish_date: "2026-09-01" },
      { title: "第二条", content: "第二条正文", link: "https://b.example/2", refer: "ref_2" },
    ] },
    错body: { error: { code: "1002", message: "鉴权失败" } }, 错里有: "鉴权失败",
    条数字段: "count",
    问题字段: "search_query",
  },
  qiniu: {
    名: "七牛云",
    host: "api.qnaigc.com", path: "/v1/search/web", method: "POST", keyHeader: "authorization",
    body: { success: true, data: { query: "OpenAI", results: [
      { id: 1, title: "七牛的标题", url: "https://c.example/1", content: "七牛的正文", date: "2026-09-01", source: "C源", score: 0.9, type: "web" },
      { id: 2, title: "第二条", url: "https://c.example/2", content: "第二条正文", score: 0.8 },
    ] } },
    错body: { success: false, message: "token 无效" }, 错里有: "token 无效",
    条数字段: "max_results",       // ← 这一家不叫 count。叫错了对方不报错，只是默默按自己的默认条数回
    问题字段: "query",
  },
  serper: {
    名: "Serper",
    host: "google.serper.dev", path: "/search", method: "POST", keyHeader: "x-api-key",
    body: { searchParameters: { q: "OpenAI" }, organic: [
      { title: "Serper 的标题", link: "https://d.example/1", snippet: "Serper 的摘要", position: 1 },
      { title: "第二条", link: "https://d.example/2", snippet: "第二条摘要", position: 2 },
    ] },
    错body: { message: "Unauthorized", statusCode: 403 }, 错里有: "Unauthorized",
    条数字段: "num",
    问题字段: "q",
  },
  tavily: {
    名: "Tavily",
    host: "api.tavily.com", path: "/search", method: "POST", keyHeader: "authorization",
    body: { query: "OpenAI", results: [
      { title: "Tavily 的标题", url: "https://e.example/1", content: "Tavily 的正文", score: 0.99 },
      { title: "第二条", url: "https://e.example/2", content: "第二条正文", score: 0.9 },
    ] },
    条数字段: "max_results",
    问题字段: "query",
  },
  jina: {
    名: "Jina",
    host: "s.jina.ai", path: "/", method: "GET", keyHeader: "authorization",
    body: { code: 200, status: 20000, data: [
      { title: "Jina 的标题", url: "https://f.example/1", description: "Jina 的摘要" },
      { title: "第二条", url: "https://f.example/2", description: "第二条摘要" },
    ] },
    查询串: "q",
  },
  brave: {
    名: "Brave",
    host: "api.search.brave.com", path: "/res/v1/web/search", method: "GET", keyHeader: "x-subscription-token",
    body: { web: { results: [
      { title: "Brave 的标题", url: "https://g.example/1", description: "Brave 的摘要" },
      { title: "第二条", url: "https://g.example/2", description: "第二条摘要" },
    ] } },
    查询串: "q",
  },
};

console.log("\n【一】八家各自：请求发得对不对、回来的形状认不认得出来");
(async () => {
  for (const [id, v] of Object.entries(VENDORS)) {
    sent = [];
    stub(200, v.body);
    let items = [];
    const e = await err(async () => { items = await SEARCH_PROVIDERS[id](KEY, "OpenAI", 2, {}); });
    ok(!e, `${v.名}：文档上那个返回体，能正常解析出来`, e);
    ok(items.length === 2, `${v.名}：两条结果都认出来了`, items.length);
    const bad = items.filter((r) => !r.title || !r.url || !r.desc).length;
    ok(items.length === 2 && bad === 0, `${v.名}：标题 / 链接 / 摘要三样都没丢`, items[0]);

    const req = lastReq();
    ok(req.url.includes(v.host) && req.url.includes(v.path), `${v.名}：打的是文档上那个地址`, req.url.slice(0, 80));
    ok(req.method.toUpperCase() === v.method, `${v.名}：用的是 ${v.method}`, req.method);
    const hv = String(req.headers[v.keyHeader] || "");
    ok(hv.includes(KEY), `${v.名}：Key 放在 ${v.keyHeader} 里送出去`, hv ? "这个头有值但不是那把 Key" : "这个头是空的");

    if (v.问题字段) ok(req.body && req.body[v.问题字段] === "OpenAI", `${v.名}：问题放在请求体的 ${v.问题字段} 里`, req.body);
    if (v.条数字段) ok(req.body && req.body[v.条数字段] === 2, `${v.名}：条数字段叫 ${v.条数字段}，值真是 2（叫错名字对方不会报错，只会默默按默认条数回）`, req.body);
    if (v.查询串) ok(new URL(req.url).searchParams.get(v.查询串) === "OpenAI", `${v.名}：问题放在 URL 的 ?${v.查询串}= 里`, req.url.slice(0, 80));
  }

  console.log("\n【二】HTTP 200 但里面写着错 —— 不许翻译成「返回 0 条结果」");
  for (const [id, v] of Object.entries(VENDORS)) {
    if (!v.错body) continue;
    sent = [];
    stub(200, v.错body);
    const e = await err(() => SEARCH_PROVIDERS[id](KEY, "OpenAI", 2, {}));
    ok(e.includes(v.错里有), `${v.名}：把对方的原话「${v.错里有}」带出来了`, e || "（居然没抛，那它这一趟返回的是 0 条结果——界面上会说「没搜到」）");
  }
  // 反向对照：这套「认错」不能见谁都说错。成功体必须一个都不许报错
  for (const [id, v] of Object.entries(VENDORS)) {
    ok(searchBodyError(v.body) === "", `反向对照 · ${v.名}：正常返回体不被误判成出错`, searchBodyError(v.body));
  }
  ok(searchBodyError({ code: 0, data: [] }) === "" && searchBodyError({ code: "200" }) === "" && searchBodyError(null) === "",
    "反向对照：code=0 / code='200' / 空对象都算成功");

  console.log("\n【三】状态码要翻成人话，还要带上对方原文");
  for (const [code, 词] of [[401, "Key"], [402, "余额"], [429, "限流"]]) {
    sent = [];
    stub(code, { message: "对方自己的原话" });
    const e = await err(() => SEARCH_PROVIDERS.bocha(KEY, "OpenAI", 2, {}));
    ok(e.includes(String(code)), `${code}：状态码在错误里`, e);
    ok(e.includes(词), `${code}：翻成了人话（含「${词}」），不是光甩一个数字`, e);
    ok(e.includes("对方自己的原话"), `${code}：对方的原文也带出来了（提示给人看，原文给排查用）`, e);
  }
  // 反向对照：没收录的码不许硬编一个原因出来（乱猜的归因比没有归因还贵）
  sent = [];
  stub(418, { message: "茶壶" });
  const e418 = await err(() => SEARCH_PROVIDERS.bocha(KEY, "OpenAI", 2, {}));
  ok(e418.includes("418") && e418.includes("茶壶") && !/Key|余额|限流/.test(e418),
    "反向对照：没收录的状态码不瞎猜原因，只把原文带出来", e418);
  ok([401, 402, 429].every((c) => SEARCH_HTTP_HINT[c]) && !SEARCH_HTTP_HINT[418],
    "反向对照：提示表里只有认得的那几个码");

  console.log("\n【四】200 却不是 JSON —— 地址填成网页版首页、中间挡了登录页");
  sent = [];
  stub(200, "<!doctype html><title>登录</title>", { raw: true });
  const eHtml = await err(() => SEARCH_PROVIDERS.bocha(KEY, "OpenAI", 2, {}));
  ok(eHtml.includes("不是 JSON") && eHtml.includes("doctype"), "把「回的不是 JSON」和前 120 字一起说清楚", eHtml);

  console.log("\n【五】认结果数组这件事，不能「见数组就认」");
  ok(toItems(VENDORS.bocha.body, 5).length === 2, "博查那层 data.webPages.value 认得出来");
  ok(toItems(VENDORS.zhipu.body, 5).length === 2, "智谱那层 search_result 认得出来");
  ok(toItems(VENDORS.qiniu.body, 5).length === 2, "七牛那层 data.results 认得出来");
  // 反向对照 1：包在一个我们没认过的壳里，必须是 0 条——而不是靠「哪儿有数组就抓哪儿」蒙对
  const 陌生壳 = { payload: { items: VENDORS.bocha.body.data.webPages.value } };
  ok(pickHits(陌生壳).length === 0, "反向对照：换个没见过的壳就认不出来（说明不是见数组就抓）", pickHits(陌生壳).length);
  // 反向对照 2：数组在，但每条都没有链接 —— 没链接的结果拿给模型没有意义，得被滤掉
  ok(toItems({ results: [{ title: "只有标题", snippet: "没链接" }] }, 5).length === 0,
    "反向对照：没有链接的条目不算结果");

  console.log("\n【六】哪家算「配好了」");
  ok(!searchProviderReady({}, "bocha", ""), "没填 Key 的不算配好");
  ok(searchProviderReady({}, "custom", "") === false, "自定义：没填地址也不算配好");
  ok(searchProviderReady({ custom_url: "https://x.example/s" }, "custom", "") === true,
    "自定义：填了地址就算配好（有些自建接口本来就不要鉴权）");
  ok(searchProviderKey({ api_key: "老字段" }, "jina") === "老字段", "jina 认得老的 api_key 字段（升级上来的人不用重填）");
  ok(searchProviderKey({ bocha_key: "B" }, "bocha") === "B" && searchProviderKey({ bocha_key: "B" }, "zhipu") === "",
    "每家的 Key 各认各的，不串台");

  console.log("\n【七】源码闸门：填了一半的 Key 不许因为别的字段不合法被一起丢掉");
  const server = src("server");
  const blk = server.slice(server.indexOf("if (b.search) {"), server.indexOf("if (b.workspace_dir !== undefined"));
  ok(blk.length > 100, "找到了保存搜索设置那一段");
  const iKeys = blk.indexOf('"jina_key", "tavily_key"');
  const iThrow = blk.indexOf("throw new Error");
  // 这一条钉的是真踩过的坑：provider 校验排在写 Key 之前，选了一家这个进程还不认的服务商
  // （程序升级了但一直没重开），那一句先 throw，整个保存回滚——七八把刚敲进去的 Key 一起没了。
  ok(iKeys > 0 && iThrow > 0 && iKeys < iThrow,
    "写 Key 的那个循环排在 provider 校验之前（顺序反了就会把人刚填的 Key 一起丢掉）", { iKeys, iThrow });
  ok(/saveConfig\(\);[^\n]*Key 已经写进 config/.test(blk),
    "provider 不认时先落盘再报错，Key 不白填");
  ok(/退出重开/.test(blk), "那句错误说了该干什么（退出重开），不是只甩一张服务商名单");

  console.log("\n【八】源码闸门：每一家都能单独测");
  ok(/req\.query\.provider/.test(server), "/api/search/test 认 ?provider= ，能指名测某一家");
  const app05 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-05.js"), "utf8");
  ok(/class="btn-plain sr-one" data-p="\$\{id\}"/.test(app05), "设置 → 搜索：每一行后面都有自己的「测这家」按钮");
  ok(/\/api\/search\/test\?provider=/.test(app05), "那颗按钮打的是指名版的测活接口");
  const vendorBlock = app05.slice(app05.indexOf("const SEARCH_VENDORS"), app05.indexOf("const searchKeyField"));
  const uiIds = [...vendorBlock.matchAll(/^\s{2}([a-z]+):\s*\[/gm)].map((m) => m[1]);
  const backIds = Object.keys(SEARCH_PROVIDERS);
  ok(uiIds.length === backIds.length && backIds.every((k) => uiIds.includes(k)),
    "界面上那张表和后端那张表是同一份（少一家 = 那家永远选不着、也测不了）", { uiIds, backIds });

  global.fetch = realFetch;
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
