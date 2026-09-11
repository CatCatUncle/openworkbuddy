"use strict";
/**
 * 对话模型「渠道共用一把 Key」这一层的测试（chat-models.js）。
 *
 *   node test/chat-models.js
 *
 * 盯的是五件一破就出事的事：
 *
 *   1. 老配置迁移不能把同一把 Key 拆成好几个渠道——拆了，用户换 Key 就得改好几处，
 *      漏一处那条模型在下一次对话时突然 401，而界面上它跟别的条目长得一模一样。
 *   2. 同地址不同 Key 必须是两个渠道。自己的号和同事的号并成一行，
 *      等于在用户不知情的情况下花别人的额度。
 *   3. **压平**：渠道的地址和 Key 每次都要写回模型条目上。这条一破，llm.js、agent.js
 *      那十来处读扁平字段的代码会拿到空地址，表现是「保存后对话就不通了」。
 *   4. 幂等：跑第二遍不许再报「改了」，也不许再多建一个渠道。
 *      不幂等的后果是每次启动都落一次盘，config.json 里的渠道越攒越多。
 *   5. 不删模型。channel 指向一个已经不存在的渠道，条目连同它的地址和 Key 得原样留着。
 *
 * 每条红线后面都跟一个「反向对照」：把该合的换成该分的（或反过来），结论必须跟着变——
 * 只会变绿不会变红的断言不是测试。
 */

const path = require("path");

const ROOT = path.join(__dirname, "..");
const cm = require(path.join(ROOT, "chat-models"));
const mm = require(path.join(ROOT, "media-models"));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });

const OR = "https://openrouter.ai/api/v1";
const ARK = "https://ark.cn-beijing.volces.com/api/v3";
const K_OR = "sk-or-test-key";
const K_OR2 = "sk-or-colleague-key";
const K_ARK = "ark-test-key";
const K_ANT = "sk-ant-test-key";

/** 老结构：每条模型自己抄一份地址和 Key */
const legacy = () => ({
  models: [
    { name: "DeepSeek", provider: "openai", base_url: OR, api_key: K_OR, model: "deepseek/deepseek-chat" },
    { name: "GPT", provider: "openai", base_url: OR, api_key: K_OR, model: "openai/gpt-5.2" },
    { name: "Sonnet", provider: "openai", base_url: OR, api_key: K_OR, model: "anthropic/claude-sonnet-5" },
    { name: "豆包", provider: "openai", base_url: ARK, api_key: K_ARK, model: "doubao-seed-1-6-250615" },
    { name: "Claude官方", provider: "anthropic", base_url: "", api_key: K_ANT, model: "claude-sonnet-5" },
    { name: "还没配的", provider: "openai", base_url: "", api_key: "", model: "填了再说" },
  ],
  active_model: "DeepSeek",
});

// ---------------------------------------------------------------- 1
console.log("\n【1】老配置迁移：一把 Key 只建一个渠道");
{
  const c = legacy();
  const changed = cm.normalize(c);
  eq(changed, true, "第一次 normalize 报告「确实改了」");
  eq(c.providers.length, 3, "三条 OpenRouter + 一条方舟 + 一条 Anthropic 官方 → 3 个渠道");
  eq(c.providers.filter((p) => p.kind === "openrouter").length, 1, "那把 OpenRouter Key 没被抄成三份");
  eq(c.providers.filter((p) => p.kind === "ark").length, 1, "方舟自成一个渠道");
  eq(c.providers.filter((p) => p.kind === "anthropic").length, 1, "Anthropic 官方按协议认，不跟空地址的条目混");
  eq(c.models.length, 6, "一条模型都没少");
  const or = c.providers.find((p) => p.kind === "openrouter");
  eq(cm.modelsOf(c, or.id).length, 3, "OpenRouter 渠道底下挂着 3 个模型");
  eq(or.api_key, K_OR, "渠道把 Key 收上来了");
  eq(or.base_url, OR, "渠道把地址收上来了");
  // 还没配过的那条不该凭空多出一个空壳渠道
  const idle = c.models.find((m) => m.name === "还没配的");
  eq(idle.channel, undefined, "没地址没 Key 的条目不挂渠道（不造空壳）");
  ok(c.providers.every((p) => p.base_url || p.kind === "anthropic"), "没建出地址为空的 OpenAI 兼容渠道");
  // 反向对照：把第三条的 Key 换成同事的号，就必须多出一个渠道
  const d = legacy();
  d.models[2].api_key = K_OR2;
  cm.normalize(d);
  eq(d.providers.filter((p) => p.kind === "openrouter").length, 2,
    "反向对照：同地址不同 Key = 两个渠道（同事的号不许并进来）");
  eq(d.models[0].channel === d.models[2].channel, false, "那两条挂在不同渠道上");
}

// ---------------------------------------------------------------- 2
console.log("\n【2】压平：地址和 Key 照旧写在模型条目上（下游一个字都不用改）");
{
  const c = legacy();
  cm.normalize(c);
  for (const m of c.models.filter((x) => x.channel)) {
    const p = c.providers.find((x) => x.id === m.channel);
    eq(m.base_url, p.base_url, `「${m.name}」的 base_url 跟渠道一致`);
    eq(m.api_key, p.api_key, `「${m.name}」的 api_key 跟渠道一致`);
  }
  eq(c.models.find((m) => m.name === "Claude官方").base_url, "",
    "Anthropic 官方仍然是空地址——llm.js 认空串走官方域名，改了反而绕路");
  // 改渠道的 Key，再规整一次：挂在它底下的三条全跟着换
  const or = c.providers.find((p) => p.kind === "openrouter");
  or.api_key = "sk-or-rotated";
  eq(cm.normalize(c), true, "改了渠道 Key，normalize 报告「确实改了」");
  eq(c.models.filter((m) => m.api_key === "sk-or-rotated").length, 3, "三条模型的 Key 一次性全换了");
  eq(c.models.find((m) => m.name === "豆包").api_key, K_ARK, "反向对照：别的渠道那条没被顺手改掉");
  // 换地址也一样。这一条专盯「压平」那两行：模型条目上留着旧地址，下游就会照着旧地址去打
  or.base_url = "https://openrouter.example.net/api/v1";
  eq(cm.normalize(c), true, "改了渠道地址，normalize 报告「确实改了」");
  eq(c.models.filter((m) => m.base_url === "https://openrouter.example.net/api/v1").length, 3, "三条模型的地址一次性全换了");
  eq(c.models.find((m) => m.name === "豆包").base_url, ARK, "反向对照：别的渠道那条地址没被顺手改掉");
  // 模型条目上带着一份过期的地址和 Key（升级途中、或者手改过 config.json），以渠道为准
  const stale = {
    providers: [{ id: "or", name: "OpenRouter", kind: "openrouter", base_url: OR, api_key: K_OR }],
    models: [{ name: "过期的", provider: "openai", channel: "or", base_url: "https://old.example.com/v1", api_key: "早就换掉的 Key", model: "x" }],
  };
  cm.normalize(stale);
  eq(stale.models[0].base_url, OR, "模型条目上的旧地址被渠道那份盖掉");
  eq(stale.models[0].api_key, K_OR, "模型条目上的旧 Key 被渠道那份盖掉");
  eq(stale.providers.length, 1, "没因为地址对不上而多建一个渠道");
}

// ---------------------------------------------------------------- 3
console.log("\n【3】协议归渠道管");
{
  const c = legacy();
  cm.normalize(c);
  eq(c.models.find((m) => m.name === "Claude官方").provider, "anthropic", "Anthropic 渠道底下的模型走 anthropic 协议");
  eq(c.models.find((m) => m.name === "DeepSeek").provider, "openai", "OpenRouter 渠道底下的走 openai 兼容");
  // 填了中转地址的 Anthropic 协议：按协议归到 anthropic 渠道，不按域名猜成 OpenAI 兼容
  const d = { models: [{ name: "中转Claude", provider: "anthropic", base_url: "https://gw.example.com/v1", api_key: "k", model: "claude-sonnet-5" }] };
  cm.normalize(d);
  eq(d.providers[0].kind, "anthropic", "中转地址 + anthropic 协议 → 渠道类型是 anthropic");
  eq(d.models[0].base_url, "https://gw.example.com/v1", "中转地址原样留着（不许被官方域名顶掉）");
  eq(cm.normalize(d), false, "再跑一遍不再变——不然每次启动都多建一个渠道");
  // 反向对照：同一个地址改成 openai 协议，就归到 custom 渠道
  const e = { models: [{ name: "中转GPT", provider: "openai", base_url: "https://gw.example.com/v1", api_key: "k", model: "gpt-5.2" }] };
  cm.normalize(e);
  eq(e.providers[0].kind, "custom", "反向对照：同地址 + openai 协议 → 另一类渠道");
  // 两种协议指着同一个地址、同一把 Key：必须是两个渠道。并成一个的话，
  // 其中一半模型会被按错误的协议去打，表现是「某几个模型一用就 400」
  const f = { models: [
    { name: "中转Claude", provider: "anthropic", base_url: "https://gw.example.com/v1", api_key: "k", model: "claude-sonnet-5" },
    { name: "中转GPT", provider: "openai", base_url: "https://gw.example.com/v1", api_key: "k", model: "gpt-5.2" },
  ] };
  cm.normalize(f);
  eq(f.providers.length, 2, "同地址同 Key 但两种协议 → 两个渠道");
  eq(f.models[0].channel === f.models[1].channel, false, "两条模型没被并到同一个渠道");
  eq(f.models[0].provider, "anthropic", "Claude 那条还是 anthropic 协议");
  eq(f.models[1].provider, "openai", "GPT 那条还是 openai 协议");
  // 挂到哪个渠道，就说哪家的话。模型条目上残留的旧协议（老版本手填的、或者换渠道时没跟着改）
  // 必须被渠道那份盖掉——不然 llm.js 会拿 OpenAI 的请求体去打 Anthropic 的接口，当场 400
  const h = {
    providers: [{ id: "ant", name: "Anthropic", kind: "anthropic", base_url: "", api_key: "k" }],
    models: [{ name: "挂错协议的", provider: "openai", channel: "ant", base_url: "", api_key: "k", model: "claude-sonnet-5" }],
  };
  cm.normalize(h);
  eq(h.models[0].provider, "anthropic", "协议按渠道的 kind 写回去");
  const i2 = {
    providers: [{ id: "or", name: "OpenRouter", kind: "openrouter", base_url: OR, api_key: K_OR }],
    models: [{ name: "挂错协议的", provider: "anthropic", channel: "or", base_url: OR, api_key: K_OR, model: "x" }],
  };
  cm.normalize(i2);
  eq(i2.models[0].provider, "openai", "反向对照：挂在 OpenAI 兼容渠道下就写回 openai");
}

// ---------------------------------------------------------------- 4
console.log("\n【4】幂等");
{
  const c = legacy();
  cm.normalize(c);
  const snap = JSON.stringify([c.providers, c.models]);
  eq(cm.normalize(c), false, "第二遍报告「没改」");
  eq(JSON.stringify([c.providers, c.models]), snap, "第二遍一个字节都没动");
  cm.normalize(c); cm.normalize(c);
  eq(c.providers.length, 3, "跑四遍还是 3 个渠道");
}

// ---------------------------------------------------------------- 5
console.log("\n【5】坏数据不许删模型、不许抛");
{
  const c = { models: [{ name: "野的", provider: "openai", base_url: OR, api_key: K_OR, model: "x", channel: "根本不存在的渠道" }] };
  cm.normalize(c);
  eq(c.models.length, 1, "指向不存在的渠道，条目还在");
  eq(c.models[0].base_url, OR, "它的地址原样留着");
  ok(c.models[0].channel && c.providers.some((p) => p.id === c.models[0].channel), "重新认了一个渠道挂上去（自愈）");
  // 认不出渠道的（没地址没 Key）：那个指向空气的 channel 必须清掉，
  // 留着界面会把它折进一个根本不存在的渠道卡里，用户从此再也看不见这条模型
  const g = { models: [{ name: "空的", provider: "openai", base_url: "", api_key: "", model: "x", channel: "早删掉的渠道" }] };
  cm.normalize(g);
  eq(g.models.length, 1, "条目还在");
  eq(g.models[0].channel, undefined, "指向空气的 channel 被清掉了（不留幽灵引用）");
  // 各种脏输入
  for (const bad of [{}, { models: null }, { models: "不是数组" }, { models: [null, 1, "x"] }, { providers: "坏的", models: [] }]) {
    let threw = null;
    try { cm.normalize(bad); } catch (e) { threw = e; }
    ok(!threw, `脏输入不抛：${JSON.stringify(bad).slice(0, 40)}`, threw && String(threw.message));
  }
}

// ---------------------------------------------------------------- 6
console.log("\n【6】跟四路媒体共用同一张渠道表");
{
  // 先有一条媒体渠道（方舟），再迁对话模型：同地址同 Key 必须复用，不另起一行
  const c = {
    media: { image: { base_url: ARK, api_key: K_ARK, model: "doubao-seedream-4-0-250828" } },
    models: [{ name: "豆包", provider: "openai", base_url: ARK, api_key: K_ARK, model: "doubao-seed-1-6-250615" }],
  };
  mm.normalize(c);
  const n0 = c.providers.length;
  cm.normalize(c);
  eq(c.providers.length, n0, "对话模型复用了画图那条渠道，没另起一行");
  eq(c.models[0].channel, c.media_models[0].provider, "两边指的是同一个渠道 id");
  // 反向对照：换一把 Key 就该多一行
  const d = {
    media: { image: { base_url: ARK, api_key: K_ARK, model: "doubao-seedream-4-0-250828" } },
    models: [{ name: "豆包", provider: "openai", base_url: ARK, api_key: "别人的方舟号", model: "doubao-seed-1-6-250615" }],
  };
  mm.normalize(d);
  cm.normalize(d);
  eq(d.providers.length, 2, "反向对照：同地址不同 Key → 两行渠道");
  // 媒体那边再规整一次，不许把对话建的渠道冲掉
  mm.normalize(c);
  eq(c.providers.length, n0, "媒体侧再规整一遍，渠道数没变");
  eq(c.models[0].channel && c.providers.some((p) => p.id === c.models[0].channel), true, "对话模型的渠道引用还在");
}

// ---------------------------------------------------------------- 7
console.log("\n【7】渠道类型认得出这几家（界面靠它给「去拿 Key」的链接）");
{
  for (const [url, kind] of [
    [OR, "openrouter"], [ARK, "ark"],
    ["https://api.anthropic.com", "anthropic"],
    ["https://api.deepseek.com/v1", "deepseek"],
    ["https://api.moonshot.cn/v1", "moonshot"],
    ["http://localhost:11434/v1", "ollama"],
    ["http://127.0.0.1:11434/v1", "ollama"],
    ["https://open.bigmodel.cn/api/paas/v4", "zhipu"],
    ["https://api.openai.com/v1", "openai"],
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", "dashscope"],
  ]) eq(mm.guessKind(url), kind, `${url} → ${kind}`);
  eq(mm.guessKind("https://gw.example.com/v1"), "custom", "反向对照：认不出来的归 custom，不瞎猜一家");
  for (const k of ["anthropic", "deepseek", "moonshot", "ollama"]) {
    ok(mm.PROVIDER_KINDS.some((x) => x.kind === k), `PROVIDER_KINDS 里有 ${k}`);
  }
  // 有 key_url 才能在渠道那一层给出「去拿 Key ↗」，缺了用户就只能自己搜
  for (const k of mm.PROVIDER_KINDS) {
    if (k.kind === "custom" || k.kind === "newapi") continue;
    ok(!!k.key_url, `渠道类型「${k.label}」有拿 Key 的地址`);
  }
  eq(mm.protoOfKind("anthropic"), "anthropic", "anthropic 渠道说 anthropic 协议");
  eq(mm.protoOfKind("openrouter"), "openai", "其余都按 OpenAI 兼容");
}

// ---------------------------------------------------------------- 8
console.log("\n【8】通义那家两个地址，只算一个渠道");
{
  const DASH_CHAT = "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const DASH_NATIVE = "https://dashscope.aliyuncs.com/api/v1";
  const K_DASH = "sk-bailian-test-key";

  eq(mm.baseForUse(DASH_NATIVE, "chat"), DASH_CHAT, "对话要的是兼容层地址");
  eq(mm.baseForUse(DASH_CHAT, "media"), DASH_NATIVE, "画图 / 配音要的是原生地址");
  eq(mm.baseForUse(DASH_CHAT, "chat"), DASH_CHAT, "已经是对的就别再改（幂等）");
  eq(mm.baseForUse(DASH_NATIVE, "media"), DASH_NATIVE, "反方向同理");
  eq(mm.baseForUse(OR, "chat"), OR, "别家原样不动——这是通义一家的历史包袱，不是通用改写");
  eq(mm.baseForUse(OR, "media"), OR, "别家原样不动（媒体方向）");
  eq(mm.baseForUse("", "chat"), "", "空地址不炸");

  // 老配置：对话填的是兼容层，配音填的是原生层，同一把 Key。这是同一个百炼账号，该并成一行
  const c = {
    media: { tts: { base_url: DASH_NATIVE, api_key: K_DASH, model: "qwen3-tts-flash", voice: "Cherry" } },
    models: [{ name: "通义", provider: "openai", base_url: DASH_CHAT, api_key: K_DASH, model: "qwen-max" }],
  };
  mm.normalize(c);
  cm.normalize(c);
  eq(c.providers.length, 1, "一个百炼账号一行渠道，不因为两个地址变成两行");
  eq(c.models[0].channel, c.media_models[0].provider, "对话和配音指的是同一个渠道");
  eq(c.models[0].base_url, DASH_CHAT, "压平给对话的是兼容层地址");
  eq(c.media.tts.base_url, DASH_NATIVE, "压平给配音的是原生地址");

  // 反过来也一样：渠道行上存的是兼容层，画图照样拿得到原生地址
  const d = {
    providers: [{ id: "bl", name: "百炼", kind: "dashscope", base_url: DASH_CHAT, api_key: K_DASH }],
    media_models: [{ cap: "image", name: "万相", provider: "bl", model: "wan2.2-t2i-flash" }],
    models: [{ name: "通义", channel: "bl", model: "qwen-plus" }],
  };
  mm.normalize(d);
  cm.normalize(d);
  eq(d.media.image.base_url, DASH_NATIVE, "渠道存的是兼容层，画图压平时换回原生");
  // resolve 是「点名某个非默认模型」那条路，跟压平是两段代码，得各钉一次
  eq(mm.resolve(d).list[0].base_url, DASH_NATIVE, "resolve 给工具的也是原生地址");
  eq(d.models[0].base_url, DASH_CHAT, "同一个渠道，对话压平出来是兼容层");
  eq(cm.normalize(d), false, "再跑一遍不再变（改写必须幂等）");
  eq(mm.normalize(d), false, "媒体侧同理");

  // 反向对照：换一把 Key 就是另一个账号，照样两行
  const e = {
    media: { tts: { base_url: DASH_NATIVE, api_key: K_DASH, model: "qwen3-tts-flash" } },
    models: [{ name: "同事的通义", provider: "openai", base_url: DASH_CHAT, api_key: "同事的百炼号", model: "qwen-max" }],
  };
  mm.normalize(e);
  cm.normalize(e);
  eq(e.providers.length, 2, "反向对照：同一家不同 Key 还是两行渠道");
}

// ---------------------------------------------------------------- 9
console.log("\n【9】对话模型的精选目录（下拉框第一段）");
{
  ok(Array.isArray(mm.CATALOG.chat) && mm.CATALOG.chat.length >= 10, `目录里有 ${(mm.CATALOG.chat || []).length} 条对话模型`);
  const kinds = new Set(mm.PROVIDER_KINDS.map((k) => k.kind));
  for (const m of mm.CATALOG.chat) {
    ok(kinds.has(m.kind), `目录条目「${m.label}」挂的渠道类型 ${m.kind} 是真存在的`);
    ok(!!m.id && !!m.label, `目录条目 ${m.id} 有 id 和中文说明`);
  }
  // 每个主流渠道都得有几条，不然选了渠道下拉框是空的，人又得回去手打模型名
  for (const k of ["openai", "anthropic", "openrouter", "ark", "dashscope", "deepseek", "zhipu", "moonshot", "ollama"]) {
    ok(mm.catalogFor("chat", k).length > 0, `渠道 ${k} 底下有对话模型可选`);
  }
  eq(mm.catalogFor("chat", "newapi").length, 0, "反向对照：自建网关没有精选条目（型号由用户自己的网关决定）");
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
