"use strict";
/**
 * 连不通的渠道熔断 —— media-health.js
 *
 *
 * 这套测试守的是三件事，缺哪件都会变回原样：
 *   ① 硬错（没余额/Key 不对/型号不存在）见一次就断，第二次连请求都不发；
 *   ② 软错（限流/5xx/超时）不能见一次就断——那会把一次抖动变成五分钟不可用；
 *   ③ 自愈的三条路都得真通：改配置、按保存、熬过冷却。
 *
 * 另外还有一条**结构性**断言（【6】）：tools.js 里五路媒体工具报错的措辞是
 * statusOf() 唯一的信息来源。谁把那句 `视觉模型错误 ${r.status}` 改成别的写法，
 * 熔断就会悄悄失灵——那种失灵没有任何报错，只会让用户回到「一直卡住」。
 * 所以这里直接去扒 tools.js 的源码对一遍。
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const mh = require("../media-health");

let pass = 0, fail = 0;
const eq = (a, b, m) => { try { assert.deepStrictEqual(a, b, m); pass++; } catch (e) { fail++; console.error("  ❌", m, "\n     实际:", JSON.stringify(a), "期望:", JSON.stringify(b)); } };
const ok = (v, m) => { if (v) pass++; else { fail++; console.error("  ❌", m); } };

const CFG = { base_url: "https://openrouter.ai/api/v1", model: "z-ai/glm-5.3-flash", api_key: "sk-test-aaa" };
const err = (content) => ({ content, isError: true });
const fresh = () => mh.reset();

console.log("【1】硬错：见一次就断，第二次连请求都不发");
{
  fresh();
  ok(!mh.gate("vision", CFG, "看图模型"), "干净状态下必须放行");
  mh.record("vision", CFG, err("视觉模型这条渠道没余额了（HTTP 402）：{\"error\":\"insufficient credits\"}"));
  const g = mh.gate("vision", CFG, "看图模型");
  ok(!!g, "402 撞过一次之后，下一次必须被拦下来");
  ok(g.isError === true, "拦下来这件事要以「工具报错」的形式交给模型，不能装作成功");
  ok(g.mediaBreaker === true, "得带上 mediaBreaker 标记：agent.js 靠它认出「这是本地闸拦的，不是上游返回的」");
  ok(/没余额/.test(g.content), "拦截语要把上次的真实原因说清楚，不能只说「已暂停」");
  ok(/别再调|别再/.test(g.content) || /如实说/.test(g.content), "必须明说别再调了，也别把没拿到的当拿到过");
}

console.log("\n【2】401 / 403 / 404 同样是硬错");
for (const [http, text] of [[401, "视觉模型错误 401: {\"error\":\"invalid api key\"}"],
                            [403, "图像接口错误 403: {\"error\":\"forbidden\"}"],
                            [404, "视频接口错误 404: {\"error\":\"model not found\"}"]]) {
  fresh();
  mh.record("vision", CFG, err(text));
  ok(!!mh.gate("vision", CFG, "看图模型"), `HTTP ${http} 撞一次就该断`);
}

console.log("\n【3】★反向对照★ 软错不许一次就断，但连着三次要断");
{
  fresh();
  mh.record("vision", CFG, err("视觉模型错误 500: {\"error\":\"upstream hiccup\"}"));
  ok(!mh.gate("vision", CFG), "★反向对照★ 一次 5xx 就断掉的话，上游抖一下用户就白等五分钟");
  mh.record("vision", CFG, err("视觉模型错误 500: {\"error\":\"upstream hiccup\"}"));
  ok(!mh.gate("vision", CFG), "两次还不该断");
  mh.record("vision", CFG, err("视觉模型错误 500: {\"error\":\"upstream hiccup\"}"));
  ok(!!mh.gate("vision", CFG), "连着三次 5xx 就得断了——再撞下去就是在烧用户的时间");

  fresh();
  for (let i = 0; i < 3; i++) mh.record("vision", CFG, err("视觉模型请求失败：fetch failed"));
  ok(!!mh.gate("vision", CFG), "连不上（根本没走到 HTTP）连着三次同样要断");
}

console.log("\n【4】★反向对照★ 400 / 422 一次都不许计入渠道健康");
{
  fresh();
  // 内容策略拦下来的生图请求就是 400。把它算进去，等于一张图违规就把整条生图渠道关了
  for (let i = 0; i < 6; i++) mh.record("image", CFG, err("图像接口错误 400: {\"error\":\"prompt violates content policy\"}"));
  ok(!mh.gate("image", CFG), "★反向对照★ 400 是这一次提示词的事，换个提示词就过——不许因此关掉整条渠道");
  fresh();
  for (let i = 0; i < 6; i++) mh.record("image", CFG, err("图像接口错误 422: 尺寸不合法"));
  ok(!mh.gate("image", CFG), "★反向对照★ 422 同理");
  // 认不出来的错（空正文、没返回图片）也不算渠道的账
  fresh();
  for (let i = 0; i < 6; i++) mh.record("image", CFG, err("图像接口没有返回图片：{}"));
  ok(!mh.gate("image", CFG), "★反向对照★ 「接口通了但内容不对」是内容层面的事，跟渠道通不通无关");
}

console.log("\n【4-bis】状态码撒谎时看正文：「没余额」「没这个型号」不管几百都是硬错");
{
  // OpenRouter 把「型号 ID 不存在」报成 400。用户的看图模型挂错了渠道（火山的型号名挂在 OpenRouter 上），
  // 每次看图都是这句 400，以前一次都不计，agent 一趟任务里能撞几十次
  fresh();
  const b1 = mh.record("vision", CFG, err("视觉模型错误 400: {\"error\":{\"message\":\"doubao-seed-1-6-250615 is not a valid model ID\",\"code\":400}}"));
  ok(!!b1 && b1.hard && !!mh.gate("vision", CFG), "400 但正文说「不是合法型号 ID」→ 硬错，见一次就断");
  ok(/型号/.test((mh.gate("vision", CFG) || {}).content || ""), "拦下来那句话得说清是型号的事，不是让人去换问法", (mh.gate("vision", CFG) || {}).content);
  // 火山欠费：400/403 + AccountOverdueError
  fresh();
  const b2 = mh.record("image", CFG, err("图像接口错误 403: {\"error\":{\"code\":\"AccountOverdueError\",\"message\":\"The account is in arrears\"}}"));
  ok(!!b2 && b2.hard && /没余额/.test(b2.why), "403 + AccountOverdue → 按「没余额」断", b2 && b2.why);
  fresh();
  mh.record("image", CFG, err("图像接口错误 400: {\"message\":\"Insufficient balance, please recharge\"}"));
  ok(!!mh.gate("image", CFG), "400 + Insufficient balance → 同样断");
  // 没带状态码的那种（tools.js 自己拼的那句「没余额了」）也认
  fresh();
  mh.record("vision", CFG, err("视觉模型这条渠道没余额了：余额不足"));
  ok(!!mh.gate("vision", CFG), "正文只有中文「没余额」、没状态码 → 也断");
  // ★反向对照★ 400 正文是内容策略 / 参数不合法：照旧一次都不计
  fresh();
  for (let i = 0; i < 6; i++) mh.record("image", CFG, err("图像接口错误 400: {\"error\":\"prompt violates content policy\"}"));
  ok(!mh.gate("image", CFG), "★反向对照★ 400 + 内容策略还是不计");
  fresh();
  for (let i = 0; i < 6; i++) mh.record("image", CFG, err("图像接口错误 400: {\"error\":\"invalid size 123x456\"}"));
  ok(!mh.gate("image", CFG), "★反向对照★ 400 + 尺寸不合法还是不计（正文里没说型号也没说余额）");
  ok(!mh.looksNoModel("图像接口错误 400: model returned empty image"), "★反向对照★ 「model」这个词本身不算「没这个型号」");
  ok(!mh.looksBroke("图像接口错误 500: internal server error, billing service unavailable"), "★反向对照★ 「billing」一个词不算没余额，得是「余额不足 / 欠费 / 超出配额」那类整句");
  ok(mh.looksBroke("视觉模型错误 429: You exceeded your current quota, please check your plan and billing details."), "OpenAI 那句「exceeded your current quota」是没余额，不是限流");

  // 阿里云百炼的欠费：HTTP 400，正文里一个「余额 / quota / overdue」都没有，只有 code=Arrearage
  // 和一句「make sure your account is in good standing」。400 不在硬错表里，这串词以前也接不住，
  // 于是欠费被当成「这次不巧」，每次调用都白等一个超时，充值之前天天如此。
  const ARREARAGE = '{"error":{"message":"Access denied, please make sure your account is in good standing. ' +
    'For details, see: https://help.aliyun.com/zh/model-studio/error-code#overdue-payment","type":"Arrearage","param":null,"code":"Arrearage"}}';
  ok(mh.looksBroke(ARREARAGE), "百炼欠费那条真实报文，得认出来是没余额");
  fresh();
  mh.record("video", CFG, err("视频接口错误 400: " + ARREARAGE));
  const arrGate = mh.gate("video", CFG, "视频");
  ok(!!arrGate, "所以一次就断，不再往这条渠道上撞");
  ok(/没余额/.test((arrGate && arrGate.content) || ""), "拦住时要说「没余额」，人才知道该去充值而不是去改配置");
  ok(/设置 → 模型/.test((arrGate && arrGate.content) || ""), "而且是硬错的措辞：让人去改，不是「等几分钟自动再试」");
  // ★反向对照★ 同样是 400、同样来自百炼，说的不是欠费就一次都不许断
  fresh();
  for (let i = 0; i < 6; i++) mh.record("video", CFG, err('视频接口错误 400: {"code":"InvalidParameter","message":"size must be one of 1280*720, 720*1280"}'));
  ok(!mh.gate("video", CFG), "★反向对照★ 参数填错是这次的问题，改一下就好，不许断");
  // ★反向对照★ 限流是会过去的，断半小时等于把能用的渠道关掉
  ok(!mh.looksBroke("视频接口错误 429: Requests rate limit exceeded, please try again later"),
     "★反向对照★ 限流不是欠费");
}

console.log("\n【5】三条自愈的路都得真通");
{
  // ① 改配置：换个型号 / 换个 Key，就是另一格
  fresh();
  mh.record("vision", CFG, err("视觉模型错误 402: 没余额"));
  ok(!!mh.gate("vision", CFG), "先确认它确实断了");
  ok(!mh.gate("vision", { ...CFG, model: "换一个型号" }), "换了型号就是另一条路，必须放行");
  ok(!mh.gate("vision", { ...CFG, api_key: "sk-test-bbb" }), "把敲错的 Key 改对了也得马上放行，不能让人干等半小时");
  ok(!mh.gate("image", CFG), "断的是看图这一路，不许连坐生图");

  // ② 用户在设置页按了保存
  fresh();
  mh.record("vision", CFG, err("视觉模型错误 402: 没余额"));
  mh.reset();
  ok(!mh.gate("vision", CFG), "设置页按过保存就当他已经去处理了，必须全部放行");

  // ③ 熬过冷却期
  fresh();
  const b = mh.record("vision", CFG, err("视觉模型错误 402: 没余额"));
  ok(!!b && b.until > Date.now(), "硬错要记一个到期时间，不能永远断着——充值不改配置的那种情况只能靠它");
  b.until = Date.now() - 1;
  ok(!mh.gate("vision", CFG), "到期之后必须自动放行，让它再去试一次");

  // ④ 成功一次，前面的账一笔勾销
  fresh();
  mh.record("vision", CFG, err("视觉模型错误 500: x"));
  mh.record("vision", CFG, err("视觉模型错误 500: x"));
  mh.record("vision", CFG, { content: "【看图】…", isError: false });
  mh.record("vision", CFG, err("视觉模型错误 500: x"));
  ok(!mh.gate("vision", CFG), "中间成功过一次，之前攒的两次软错就该清零，不能接着数到三");
}

console.log("\n【6】statusOf 必须认得 tools.js 里真实的那些措辞");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "tools.js"), "utf8");
  // 把源码里所有「…错误 ${r.status}」「…错误 ${out.http}」这类模板抠出来，
  // 换成一个真状态码，喂给 statusOf 看认不认得
  const tpl = [...src.matchAll(/`([^`]{0,40}(?:错误|HTTP)\s*[（(]?\$\{[^}]{0,40}(?:status|http)[^}]{0,20}\}[^`]{0,20})`/gi)].map((m) => m[1]);
  ok(tpl.length >= 4, `tools.js 里应当能扒出至少 4 处带状态码的报错模板，实际 ${tpl.length} 处——扒不到多半是措辞改了，statusOf 的正则要跟着改`);
  for (const t of tpl) {
    const sample = t.replace(/\$\{[^}]*\}/g, "402");
    eq(mh.statusOf(sample), 402, `statusOf 认不出 tools.js 里这句真实报错：${sample.slice(0, 60)}`);
  }
  // 反过来：正常的成功文案不许被误读成状态码
  eq(mh.statusOf("【看图】海报.png\n问：报错写的什么\n答：404 Not Found"), 0,
    "★反向对照★ 正文里出现的 404 是图片内容，不是渠道状态——误读它会把好好的渠道关掉");
}

console.log("\n【7】list() 不许把 API Key 的指纹带出门");
{
  fresh();
  mh.record("vision", CFG, err("视觉模型错误 402: 没余额"));
  const l = mh.list();
  eq(l.length, 1, "断掉的渠道要能被界面列出来，否则用户只知道「不动了」不知道为什么");
  eq(l[0].cap, "vision", "要说清是哪一路");
  ok(/没余额/.test(l[0].why), "要说清为什么");
  const dumped = JSON.stringify(l);
  ok(!dumped.includes(CFG.api_key), "★安全★ 列表里绝不许出现 API Key 原文");
  const fp = mh.fingerprint("vision", CFG).split("|").pop();
  ok(!dumped.includes(fp), "★安全★ 连 Key 的哈希片段也不出门——这张表是要经 /api 发给浏览器的");
}

console.log("\n【8】tools.js 与 agent.js 的接线还在");
{
  const t = fs.readFileSync(path.join(__dirname, "..", "tools.js"), "utf8");
  ok(/require\("\.\/media-health"\)/.test(t), "tools.js 得引着 media-health");
  ok(/async function viaMedia\(/.test(t), "五路媒体工具统一穿过 viaMedia，这个口子不能没了");
  for (const [tool, cap] of [["look_at_image", "vision"], ["generate_image", "image"], ["generate_video", "video"], ["text_to_speech", "tts"], ["transcribe_audio", "asr"]]) {
    const at = t.indexOf(`case "${tool}"`);
    ok(at > 0 && /viaMedia\("([a-z]+)"/.test(t.slice(at, at + 600)) && t.slice(at, at + 600).includes(`viaMedia("${cap}"`),
      `${tool} 这一路没穿过熔断闸（应当是 viaMedia("${cap}", …)）——漏一路，用户就会在那一路上继续撞`);
  }
  const a = fs.readFileSync(path.join(__dirname, "..", "agent.js"), "utf8");
  ok(/deadMedia/.test(a) && /r\.mediaBreaker/.test(a),
    "agent.js 要认 mediaBreaker 标记并在本轮停用那个工具，否则 trace 里还是四十条一模一样的失败");
  const s = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  ok(/mediaHealth\.reset\(\)/.test(s), "设置页保存之后要清空熔断表，不然用户改好了还得干等半小时");
}

console.log(`\n${fail ? "❌" : "✅"} media-health：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
