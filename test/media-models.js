"use strict";
/**
 * 多模型配置的测试 —— 「一把 Key 挂多个型号，每一路都能点名用哪个」这条链路。
 *
 *   node test/media-models.js
 *
 * 盯的是四件一破就出事的事：
 *
 *   1. 老配置迁移不能把同一把 Key 拆成好几个渠道，也不能把 voice 这种字段迁丢。
 *      迁错了用户什么都看不见——界面照样能用，只是他那把 Key 被抄了四份，改一处忘三处。
 *   2. 每一路恰好一个默认。默认漂了，用户点名要 A、实际跑 B，账单和成片都对不上。
 *   3. 点名点不着必须当场报错并列出可选项，绝不悄悄退回默认那条。
 *      这是「不静默降级用户配置的模型」那条铁律在这一层的落点。
 *   4. 点名点着了，请求真得打到那个渠道的地址、带那个渠道的 Key。
 *      前三条都在纯数据层，第四条才是真正证明「选了有用」的那条。
 *
 * 每条红线后面都跟一个「反向对照」：把该拒的换成该放的，必须放行——不然测的就不是它。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const mm = require(path.join(ROOT, "media-models"));
const prefs = require(path.join(ROOT, "prefs"));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });

const ARK = "https://ark.cn-beijing.volces.com/api/v3";
const DASH = "https://dashscope.aliyuncs.com/api/v1";
const K1 = "ark-key-for-test";
const K2 = "dashscope-key-for-test";
const K3 = "another-ark-key";

// 老结构：一路一份扁平配置，Key 抄好几份
const legacy = () => ({
  media: {
    vision: { base_url: ARK, api_key: K1, model: "doubao-seed-1-6-250615" },
    image: { base_url: ARK, api_key: K1, model: "doubao-seedream-4-0-250828" },
    video: { base_url: ARK, api_key: K1, model: "doubao-seedance-1-0-pro-250528" },
    tts: { base_url: DASH, api_key: K2, model: "qwen3-tts-flash", voice: "Cherry" },
  },
});

// ---------------------------------------------------------------- 1
console.log("\n【1】老配置迁移：同一把 Key 只建一个渠道");
{
  const c = legacy();
  const changed = mm.normalize(c);
  eq(changed, true, "第一次 normalize 报告「确实改了」");
  eq(c.providers.length, 2, "三路共用一把 ARK Key + 一路百炼 → 只建 2 个渠道");
  eq(c.media_models.length, 4, "四路各迁出一条模型");
  eq(c.providers.filter((p) => p.kind === "ark").length, 1, "ARK 那把 Key 没被抄成三份");
  eq((c.media_models.find((m) => m.cap === "tts") || {}).voice, "Cherry", "tts 的音色没在迁移里丢掉");
  eq(c.media.tts.voice, "Cherry", "压平回 config.media 时音色也还在");
  eq(c.media.image.model, "doubao-seedream-4-0-250828", "config.media 仍是老形状，tools.js 不用改");
  eq(c.media.image.api_key, K1, "压平那份带着真 Key（工具链直接读它）");
  ok(!c.media_models.some((m) => "api_key" in m), "模型表只引用渠道，自己不抄 Key");
  eq(mm.normalize(c), false, "再 normalize 一次没有任何变化（幂等）");

  // 反向对照：真的是两把不同的 Key，就该老老实实建两个渠道
  const d = legacy();
  d.media.video.api_key = K3;
  mm.normalize(d);
  eq(d.providers.length, 3, "反向对照：video 换一把 Key → 渠道数变 3");
}

// ---------------------------------------------------------------- 2
console.log("\n【2】每一路恰好一个默认，默认换人 config.media 跟着换");
{
  const c = legacy();
  mm.normalize(c);
  const ark = c.providers.find((p) => p.kind === "ark").id;
  c.media_models.push({ cap: "image", name: "备用画师", provider: ark, model: "doubao-seedream-3-0-t2i-250415" });
  mm.normalize(c);
  eq(c.media_models.filter((m) => m.cap === "image").length, 2, "image 这一路现在两条");
  eq(c.media_models.filter((m) => m.cap === "image" && m.default).length, 1, "默认仍然只有一个");
  eq(c.media.image.model, "doubao-seedream-4-0-250828", "新加的不抢默认");

  // 把默认改投给第二条
  for (const m of c.media_models.filter((x) => x.cap === "image")) m.default = m.name === "备用画师";
  mm.normalize(c);
  eq(c.media.image.model, "doubao-seedream-3-0-t2i-250415", "换默认后 config.media 跟着换");

  // 反向对照：换回去也得跟着换回来（不是单向粘住）
  for (const m of c.media_models.filter((x) => x.cap === "image")) m.default = m.name !== "备用画师";
  mm.normalize(c);
  eq(c.media.image.model, "doubao-seedream-4-0-250828", "反向对照：换回第一条，config.media 也换回来");

  // 一路上的默认全被抹掉：得自愈成第一条，而不是变成「没有默认」
  for (const m of c.media_models.filter((x) => x.cap === "image")) m.default = false;
  eq(mm.normalize(c), true, "默认被抹光 → normalize 报告改了东西");
  eq(c.media_models.filter((m) => m.cap === "image" && m.default).length, 1, "自愈出一个默认");

  // 引用了一个不存在的渠道：这条跟着没（设置页删渠道时承诺的就是「挂在它下面的模型一起删」）。
  // 以前是改挂到第一个渠道上——拿另一家的 Key 调这家的型号，必然 401，而且没人知道是谁改的
  const before = c.media_models.length;
  const orphan = c.media_models.find((m) => m.cap === "image");
  orphan.provider = "provider-does-not-exist";
  const warned = [];
  const origWarn = console.warn;
  console.warn = (s) => warned.push(String(s));
  try { mm.normalize(c); } finally { console.warn = origWarn; }
  eq(c.media_models.length, before - 1, "引用不存在渠道的那条被去掉，不再改挂到别家");
  ok(!c.media_models.some((m) => m.name === orphan.name && m.cap === "image"), "去掉的正是那条孤儿");
  ok(c.media_models.filter((m) => m.cap === "image").some((m) => m.default), "剩下的图像模型里自愈出一个默认");
  ok(warned.some((s) => s.includes(orphan.name)), "去掉时在日志里点了名，不是悄悄消失", warned);
  ok(c.media_models.every((m) => c.providers.some((p) => p.id === m.provider)), "反向对照：剩下的每条都挂在真实存在的渠道上");
}

// ---------------------------------------------------------------- 3
console.log("\n【3】点名：点不着当场报错并列出可选项，绝不悄悄换成别的");
{
  const c = legacy();
  mm.normalize(c);
  const ark = c.providers.find((p) => p.kind === "ark").id;
  c.media_models.push({ cap: "image", name: "备用画师", provider: ark, model: "doubao-seedream-3-0-t2i-250415" });
  mm.normalize(c);
  const media = mm.resolve(c);

  eq(mm.pick(media, "image", "").model, "doubao-seedream-4-0-250828", "不写 model 用默认那条");
  eq(mm.pick(media, "image", "备用画师").model, "doubao-seedream-3-0-t2i-250415", "按名称点名");
  eq(mm.pick(media, "image", "doubao-seedream-3-0-t2i-250415").model, "doubao-seedream-3-0-t2i-250415", "按模型 id 点名");
  eq(mm.pick(media, "image", "  备用画师 ").model, "doubao-seedream-3-0-t2i-250415", "名字前后有空格也认");
  eq(mm.pick(media, "image", "DOUBAO-SEEDREAM-3-0-T2I-250415").model, "doubao-seedream-3-0-t2i-250415", "模型 id 大小写不敏感");
  eq(mm.pick(media, "image", "备用画师").api_key, K1, "点名拿到的是那条所属渠道的真 Key");

  let err = null;
  try { mm.pick(media, "image", "根本没有这个"); } catch (e) { err = e; }
  ok(err instanceof mm.MediaPickError, "点不着的名字会抛 MediaPickError（不是返回默认）");
  ok(err && err.message.includes("备用画师"), "报错里列出了可选项，agent 下一轮自己就能改对", err && err.message);
  ok(err && err.message.includes("doubao-seedream-4-0-250828"), "可选项里也带着模型 id");

  // 一路一个都没配：错误话术要指路，而不是干巴巴说找不到
  let err2 = null;
  try { mm.pick({ list: [] }, "video", "随便写的"); } catch (e) { err2 = e; }
  ok(err2 && /一个都没配/.test(err2.message), "一路都没配时提示去设置里配", err2 && err2.message);

  // 反向对照：名字写对了必须不抛
  let threw = false;
  try { mm.pick(media, "image", "备用画师"); } catch { threw = true; }
  eq(threw, false, "反向对照：名字写对了不抛");
}

// ---------------------------------------------------------------- 4
console.log("\n【4】resolve 给工具链的那张表");
{
  const c = legacy();
  mm.normalize(c);
  const media = mm.resolve(c);
  eq(Array.isArray(media.list), true, "resolve 带出一张可选清单");
  eq(media.list.length, 4, "清单条数 = 模型表条数");
  eq(media.image.model, c.media.image.model, "四路默认配置原样带出（老调用方无感）");
  ok(media.list.every((m) => m.base_url), "清单每一条都补上了所属渠道的地址");
  eq(media.list.find((m) => m.cap === "tts").voice, "Cherry", "清单里带着音色");
}

// ---------------------------------------------------------------- 5
console.log("\n【5】工具派发：点名真的打到那个渠道");
{
  const c = legacy();
  mm.normalize(c);
  // 第二个渠道：换一把 Key、换一个地址，才看得出请求到底打到谁
  const alt = { id: "alt-openai", name: "备用聚合网关", kind: "custom", base_url: "https://alt.example.test/v1", api_key: "alt-key-9" };
  c.providers.push(alt);
  c.media_models.push({ cap: "image", name: "备用画师", provider: alt.id, model: "flux-pro-1.1" });
  mm.normalize(c);
  const media = mm.resolve(c);

  const tools = require(path.join(ROOT, "tools"));
  const { generateImage, generateVideo } = tools._internals;
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-media-"));
  const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");

  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: ((init || {}).headers || {}).Authorization, body: JSON.parse((init || {}).body || "{}") });
    return {
      ok: true, status: 200,
      json: async () => ({ data: [{ b64_json: PNG_B64 }] }),
      text: async () => "",
    };
  };

  (async () => {
    try {
      // 点名写错：当场报错并列出可选项，一个请求都不该发出去
      seen.length = 0;
      let r = await generateImage(media, { prompt: "一只猫", model: "并不存在的画师" }, 1000, saveDir);
      eq(r.isError, true, "点名写错 → 工具直接报错");
      ok(/备用画师/.test(r.content), "报错里带可选项", r.content);
      eq(seen.length, 0, "报错时一个请求都没发（不会白花钱）");

      // 点名写对：打到备用渠道的地址、带备用渠道的 Key
      seen.length = 0;
      r = await generateImage(media, { prompt: "一只猫", model: "备用画师", filename: "t1.png" }, 1000, saveDir);
      eq(r.isError, false, "点名写对 → 出图成功", r.content);
      eq(seen.length >= 1, true, "确实发了请求");
      eq(seen[0].url, "https://alt.example.test/v1/images/generations", "请求打到备用渠道的地址");
      eq(seen[0].auth, "Bearer alt-key-9", "带的是备用渠道的 Key");
      eq(seen[0].body.model, "flux-pro-1.1", "用的是那条点名的模型");

      // 反向对照：不写 model 就该走默认渠道，而不是粘在刚才那个上
      seen.length = 0;
      r = await generateImage(media, { prompt: "一只猫", filename: "t2.png" }, 1000, saveDir);
      eq(r.isError, false, "反向对照：不写 model 也能出图", r.content);
      eq(seen[0].url, ARK + "/images/generations", "反向对照：走默认渠道的地址");
      eq(seen[0].auth, "Bearer " + K1, "反向对照：带默认渠道的 Key");

      // 视频这一路同样的规矩
      seen.length = 0;
      r = await generateVideo(media, { prompt: "一只猫跑过", model: "并不存在的摄影师" }, { saveDir });
      eq(r.isError, true, "视频点名写错也当场报错");
      ok(/视频模型/.test(r.content), "报错话术说清是哪一路", r.content);
      eq(seen.length, 0, "视频报错时也没发请求");
    } finally {
      global.fetch = realFetch;
      try { fs.rmSync(saveDir, { recursive: true, force: true }); } catch {}
      done();
    }
  })();
}

function rest() {
  // ---------------------------------------------------------------- 6
  console.log("\n【6】从模型名猜能力：给「现拉回来的模型列表」分类用");
  {
    eq(mm.guessCap("doubao-seedance-1-0-pro-250528"), "video", "seedance → 视频");
    eq(mm.guessCap("doubao-seedream-4-0-250828"), "image", "seedream → 图像");
    eq(mm.guessCap("qwen3-tts-flash"), "tts", "tts → 语音");
    eq(mm.guessCap("doubao-seed-1-6-250615"), "vision", "seed-1 → 视觉");
    // 转写这一路：名字里带 whisper / transcribe / asr / stt 的都归它
    eq(mm.guessCap("gpt-4o-transcribe"), "asr", "transcribe → 转写");
    eq(mm.guessCap("whisper-1"), "asr", "whisper → 转写");
    eq(mm.guessCap("qwen3-asr-flash"), "asr", "asr → 转写");
    // asr 必须排在 tts 前面判：这两个名字里都蹭着配音的关键词（voice / speech），
    // 顺序一反就会被认成配音模型，用户配好了一调直接吃 404。这四条是那个顺序的闸门。
    eq(mm.guessCap("FunAudioLLM/SenseVoiceSmall"), "asr", "SenseVoice 带 voice，仍要判成转写（顺序闸门）");
    eq(mm.guessCap("speech-to-text-v2"), "asr", "speech-to-text 带 speech，仍要判成转写（顺序闸门）");
    // 反向对照：真正的配音模型不许被转写那条规则抢走
    eq(mm.guessCap("FunAudioLLM/CosyVoice2-0.5B"), "tts", "反向对照：CosyVoice 还是配音");
    eq(mm.guessCap("tts-1-hd"), "tts", "反向对照：tts-1-hd 还是配音");
    // 反向对照：asr / stt 这三个字母太短，不许在别的词里蹭上就误伤
    eq(mm.guessCap("mistral-small"), "", "反向对照：mistral 里的 str 不算 stt");
    // 反向对照：猜不出来就留空，不硬塞进某一路
    eq(mm.guessCap("text-embedding-v3"), "", "反向对照：认不出的模型留空，不硬塞");
    // ---- 渠道自己报的模态，比猜名字准。
    // ／
    // 拿当天 OpenRouter 那 446 个型号实测：真能接图的 263 个，按名字只认得出 134 个。
    const co = (o) => mm.capOfModel(o);
    // 出图的：既能接图又能出图，正业是画图，不许排进「看图」那一组
    eq(co({ id: "google/gemini-3-pro-image", architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] } }).cap,
       "image", "出图的模型判成画图（哪怕它也能接图）");
    ok(co({ id: "openai/gpt-5-image", architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] } }).sure,
       "渠道自己标了模态，这条是「确定」，前端才敢照它分组");
    // 用户自己配的那条：名字里一个 vl / vision 都没有，只有模态认得出来
    eq(co({ id: "z-ai/glm-5.3-flash", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } }).cap,
       "vision", "名字看不出来、但渠道说能接图的，就是看图模型");
    eq(mm.guessCap("z-ai/glm-5.3-flash"), "", "★对照★ 同一条只按名字猜是猜不出来的（这正是要读模态的理由）");
    // 进出都只有文字 = 确定哪一路都不是。说死了才拦得住 codex 这类混进看图那一组
    const codex = co({ id: "openai/gpt-5.3-codex", architecture: { input_modalities: ["text"], output_modalities: ["text"] } });
    eq(codex.cap, "", "纯文字模型不归任何一路");
    ok(codex.sure, "而且是「确定」不归——按名字猜的话 gpt-5 会被当成看图模型");
    eq(mm.guessCap("openai/gpt-5.3-codex"), "vision", "★对照★ 只看名字的话它真的会掉进看图那一组");
    // 听声的和出声的分得开
    eq(co({ id: "x/whatever-1", architecture: { input_modalities: ["audio"], output_modalities: ["text"] } }).cap, "asr", "进音频出文字 → 转写");
    eq(co({ id: "x/whatever-2", architecture: { input_modalities: ["text"], output_modalities: ["audio"] } }).cap, "tts", "进文字出音频 → 配音");
    eq(co({ id: "x/whatever-3", architecture: { output_modalities: ["video"] } }).cap, "video", "出视频 → 视频");
    // 反向对照：渠道什么都没报（国产渠道大半如此），照旧按名字猜，且标明是猜的
    const bare = co({ id: "doubao-seedream-4-0-250828" });
    eq(bare.cap, "image", "反向对照：渠道没报模态时，退回按名字猜");
    ok(!bare.sure, "反向对照：猜出来的不许冒充「渠道自己标的」");
    eq(co("qwen-vl-max").cap, "vision", "反向对照：只给一个字符串（老式 /models）也认");
    eq(mm.guessKind(ARK), "ark", "ARK 地址认得出渠道类型");
    eq(mm.guessKind(DASH), "dashscope", "百炼地址认得出渠道类型");
    eq(mm.guessKind("https://whatever.example.test/v1"), "custom", "反向对照：认不出的地址归到自定义");
    eq(mm.baseOfKind("ark"), ARK, "按渠道类型能取回默认地址");
    ok(mm.catalogFor("tts", "dashscope").every((m) => m.kind === "dashscope"), "精选目录按渠道过滤得干净");
    ok(mm.catalogFor("image", "ark").length > 0, "ARK 这一路的图像目录不是空的");
    ok(mm.catalogFor("asr", "openai").length > 0, "转写这一路的精选目录不是空的");
    // 通义百炼的转写是异步任务接口，tools.js 那边没实现。目录里摆上去 = 让人选一个必然报错的选项
    eq(mm.catalogFor("asr", "dashscope").length, 0, "百炼没接转写，目录里一条都不许摆");
    ok(mm.CAPS.includes("asr") && mm.CAP_CN.asr, "asr 在 CAPS 里，且有中文名");
  }

  // ---------------------------------------------------------------- 7
  console.log("\n【7】这几张表是服务器级的，不能顺着「个人偏好」那条路被改掉");
  {
    // 个人偏好白名单是闸门（admin.platformGuard）和处理器共用的同一张表。
    // 这几项一旦被误判成「个人项」，普通成员一条 curl 就能把整台机器的渠道和 Key 换掉。
    for (const k of ["providers", "media_models", "media", "models", "security", "workspace_dir", "im"]) {
      eq(prefs.isPersonalPatch({ [k]: [] }), false, `${k} 不算个人偏好`);
    }
    // 反向对照：真正的个人项必须放行，否则用户会看到「切换失败」
    eq(prefs.isPersonalPatch({ pet: { enabled: true } }), true, "反向对照：宠物开关算个人偏好");
    eq(prefs.isPersonalPatch({ agent: { engine: "builtin", thinking: "auto" } }), true, "反向对照：引擎和思考档算个人偏好");

    // 处理器里的兜底 403 靠的就是这条不变式：判定为「整单都是个人项」时，
    // split 出来的服务器级剩余必须是空的。谁哪天放宽了白名单却忘了同步 split，这里先红。
    const bodies = [
      { pet: { enabled: true } },
      { agent: { engine: "builtin" } },
      { shortcuts: { toggle: "Alt+Space" } },
      { model_follow_last: true, last_picked_model: "x" },
      { agent: { engine_options: { codex: { model: "gpt-5" } } } },
    ];
    for (const b of bodies) {
      if (!prefs.isPersonalPatch(b)) continue;
      eq(Object.keys(prefs.split(b).rest).length, 0, "判成个人单 → 服务器级剩余为空：" + JSON.stringify(b));
    }
    // 反向对照：混单里的服务器级项必须真的被 split 分出来（分不出来才是危险的那种绿）
    const mixed = prefs.split({ pet: { enabled: true }, providers: [{ id: "x" }] });
    eq(Object.keys(mixed.personal).length, 1, "反向对照：混单里的个人项被分出来");
    eq(Object.keys(mixed.rest).length, 1, "反向对照：混单里的服务器级项也被分出来（处理器据此 403）");
  }

  // ----------------------------------------------------------------
  // 删掉的模型不许自己长回来。
  // 真事：把「看图」那一路的模型全删了，刷新一下，两条又原样躺在那儿；再删，再回来。
  // 没设置就是没设置，不该有什么默认模型自己长回来。
  //
  // 死循环由两段代码合谋而成，单看哪一段都像是好心：
  //   flatten 那条兜底：media_models 里没有 vision 了，就把上一版 config.media.vision 留着，
  //                     免得抹掉用户手填的地址；
  //   normalize 顶上的迁移循环：看见 config.media.vision 有地址有模型，就建回一条 vision 模型。
  // 于是「删」这个动作被完整地撤销，而且每存一次撤销一次。
  // 所以这一组钉的是：迁移只认一次（从老版本升上来的那一次），兜底只留没有模型名的那种。
  console.log("\n【10】删掉的模型不许自己长回来");
  {
    const one = () => ({
      providers: [{ id: "openrouter", name: "OpenRouter", kind: "openrouter", base_url: "https://openrouter.ai/api/v1", api_key: "k" }],
      media_models: [{ id: "vision-glm", cap: "vision", name: "z-ai/glm-5.3-flash", provider: "openrouter", model: "z-ai/glm-5.3-flash", default: true }],
      media: {},
    });
    const c = one();
    mm.normalize(c);
    eq(c.media.vision.model, "z-ai/glm-5.3-flash", "先确认压平这一步是好的：默认那条落到了 config.media.vision");

    // 用户在界面上把这一路删光，前端把「剩下的」提交上来
    c.media_models = c.media_models.filter((m) => m.cap !== "vision");
    mm.normalize(c);
    eq(c.media_models.filter((m) => m.cap === "vision").length, 0, "删光之后，vision 一行都不许剩");
    eq(c.media.vision.model, "", "config.media.vision 里也不许偷偷留个副本——留着下一轮就是它把人请回来的");
    mm.normalize(c); mm.normalize(c);
    eq(c.media_models.filter((m) => m.cap === "vision").length, 0, "再规整两轮还是零：这才叫「删掉了」");

    // ★反向对照★ 真·老配置（还没有 media_models 这张表）升上来，迁移必须照做。
    // 少了这条，上面三行完全可能是靠「迁移整个坏掉了」绿的，那是把功能删了，不是把 bug 修了。
    const ancient = { providers: [], media_models: [], media: { image: { base_url: ARK, api_key: K1, model: "doubao-seedream-4-0-250828", } } };
    mm.normalize(ancient);
    eq(ancient.media_models.length, 1, "★反向对照★ 老配置首次升级，那条画图模型还得被搬过来");
    eq(ancient.media_models[0].model, "doubao-seedream-4-0-250828", "★反向对照★ 搬过来的就是他原来那条");

    // ★反向对照★ 老用户升上来的**第一次保存**恰好就是「把这一路删光」：
    // 此时戳还没盖上，但 media_models 里已经有别的行了——那张表只可能是 normalize 自己建的,
    // 所以搬家早就做完了。不认这一条的话，这些人还要被咬最后一口。
    const upgrading = {
      providers: [{ id: "openrouter", name: "OpenRouter", kind: "openrouter", base_url: "https://openrouter.ai/api/v1", api_key: "k" }],
      media_models: [{ id: "image-x", cap: "image", name: "doubao-seedream-5", provider: "openrouter", model: "doubao-seedream-5", default: true }],
      media: { vision: { base_url: "https://openrouter.ai/api/v1", api_key: "k", model: "z-ai/glm-5.3-flash" } },
    };
    mm.normalize(upgrading);
    eq(upgrading.media_models.filter((m) => m.cap === "vision").length, 0, "升级中途删光看图，也不许被迁移请回来");

    // 兜底本来是为谁留的：手改 config.json、填了地址还没想好用哪个型号的人。
    // 这一条必须还在——它跟上面那些不冲突，区别只在「有没有模型名」。
    const halfHand = { providers: [], media_models: [], media_migrated: true, media: { tts: { base_url: "https://gw.example.test/v1", api_key: "k", model: "" } } };
    mm.normalize(halfHand);
    eq(halfHand.media.tts.base_url, "https://gw.example.test/v1", "手填了地址、没填模型名的，保存一次不许被抹掉");
  }

  // ----------------------------------------------------------------
  // 目录里的视频型号，名字得跟 tools.js 里那对判别式对得上。
  // generate_video 是靠模型名判「这是图生还是文生」来决定发请求前拦不拦的：
  // 图生型号没给首帧就拦下、文生型号硬塞首帧也拦下，省的是一次按条计费的异步任务。
  // 这道闸门跨两个文件：目录里加了个 i2v 型号、判别式却认不出来，预检就悄悄失效了，
  // 而失效的样子跟「一切正常」一模一样——用户只会看到上游报个错，钱照扣。
  console.log("\n【9】视频目录的型号名 ↔ 图生/文生判别式");
  {
    const { I2V_RE, T2V_RE } = require(path.join(ROOT, "tools"))._internals;
    // 标签怎么写是给人看的，判别式认的是 id。两边必须是同一个结论
    for (const m of mm.CATALOG.video) {
      const byLabel = /图生视频|首尾帧/.test(m.label);
      eq(I2V_RE.test(m.id), byLabel, `${m.id}：标签说${byLabel ? "要图" : "纯文字"}，判别式也得这么认`, m.label);
      if (byLabel) eq(T2V_RE.test(m.id), false, `${m.id} 不该同时被当成文生型号`);
    }
    ok(mm.CATALOG.video.some((m) => I2V_RE.test(m.id)), "目录里至少摆着一个图生视频型号");
    ok(mm.CATALOG.video.some((m) => T2V_RE.test(m.id)), "目录里至少摆着一个文生视频型号");
    // 反向对照：判别式得真能判死，别是个见谁都点头的正则
    eq(I2V_RE.test("wan2.2-t2v-plus"), false, "反向对照：文生型号不许被当成图生");
    eq(I2V_RE.test("doubao-seedance-1-0-pro-250528"), false, "反向对照：没标 i2v 的型号不许被当成图生");
    eq(T2V_RE.test("wan2.2-i2v-plus"), false, "反向对照：图生型号不许被当成文生");
    // 钉在分隔符上，别让哪个型号名里蹭上三个字母就误伤（跟 asr 那条同一个教训）
    eq(I2V_RE.test("gpt-4o-transcribe"), false, "反向对照：不相干的型号名不许蹭上图生");
    eq(I2V_RE.test("multi2video-x"), false, "反向对照：i2v 得钉在分隔符上，不许在词中间命中");
  }


  // ----------------------------------------------------------------
  // 挂错渠道的型号：认得出来、挪得回去，更要紧的是**不许认错**。
  // 这一层的失败长得跟成功一模一样：用户在设置页把型号填在他知道能跑的那条渠道上，
  // 保存一下，normalize 顺手把它挪到别家去了，下次一调就是「型号不存在」，
  // 而设置页上显示的还是他填的那个名字——他会以为是模型坏了，不会想到是自己这边挪的。
  // 所以每条「该判挂错」后面都压一条「该放行」，判据松一格立刻红。
  console.log("\n【11】挂错渠道的型号：挪得回去，更不许认错");
  {
    // ---- 认门第：目录 > 斜杠 > 方舟日期尾巴 > 前缀
    eq(mm.brandOf("doubao-seedream-4-0-250828"), "ark", "目录里有的，直接认");
    eq(mm.brandOf("glm-4-plus"), "zhipu", "目录里没有的，按前缀认");
    eq(mm.brandOf("z-ai/glm-5.3-flash"), "", "带斜杠的认不出是哪边的（中转和原厂都这么写）");
    eq(mm.brandOf("qwen3:14b"), "", "带冒号的是 Ollama 本地 tag，名字用户随便起");
    eq(mm.brandOf("text-embedding-v3"), "openai", "前缀表里有的照认");
    eq(mm.brandOf("随便起个名"), "", "认不出就回空串——宁可漏判不可误判");

    // ---- 方舟的日期尾巴。它是个转售平台：别家的牌子 + 它自己的上架日期。
    // 用户真配过一条 ark / glm-5-3-flash-260828，实测能调通（HTTP 200）；
    // 只看 `glm-` 前缀会把它判成智谱家的，然后从他填对的渠道上挪走。
    eq(mm.brandOf("glm-5-3-flash-260828"), "ark", "方舟上架的智谱型号，算方舟的");
    eq(mm.mismatch("ark", "glm-5-3-flash-260828"), "", "所以挂在方舟渠道上是对的，不许挪");
    eq(mm.brandOf("kimi-k2-250711"), "ark", "方舟转售的 Kimi 也算方舟的");
    eq(mm.brandOf("deepseek-v3-250324"), "ark", "方舟转售的 DeepSeek 同理");
    // ★反向对照★ 尾巴没了就还是原厂的，别把整条前缀规则废掉
    eq(mm.brandOf("glm-4-plus"), "zhipu", "★对照★ 智谱自家的写法没有日期尾巴，仍判智谱");
    eq(mm.brandOf("cogview-3"), "zhipu", "★对照★ CogView 仍判智谱");
    eq(mm.mismatch("zhipu", "glm-4-plus"), "", "★对照★ 智谱型号挂智谱渠道，放行");
    // ★反向对照★ 尾巴得是真日期，且只认 6 位——别家的日期写法不许被吃掉
    eq(mm.arkDated("x-260828"), true, "YYMMDD 是方舟的写法");
    eq(mm.arkDated("x-269928"), false, "★对照★ 99 月不是日期");
    eq(mm.arkDated("x-260800"), false, "★对照★ 0 日不是日期");
    eq(mm.arkDated("x-2608"), false, "★对照★ 4 位不是 YYMMDD");
    eq(mm.brandOf("claude-sonnet-4-20250514"), "anthropic", "★对照★ Anthropic 的 8 位日期不许被认成方舟");
    eq(mm.brandOf("gpt-4o-2024-08-06"), "openai", "★对照★ OpenAI 的日期写法不许被认成方舟");

    // ---- 什么渠道不判
    eq(mm.mismatch("ollama", "doubao-seedream-4-0-250828"), "", "本机 Ollama 的型号名用户自己起，一律不判");
    for (const k of mm.RELAY_KINDS) {
      eq(mm.mismatch(k, "doubao-seedream-4-0-250828"), "", `中转网关（${k}）后面接谁只有用户知道，不判`);
    }
    eq(mm.mismatch("", "glm-4-plus"), "", "渠道类型都没有的，不判");
    // ★反向对照★ 真该判的那种必须判出来，不然上面几条可能是靠「整个判定废了」绿的
    eq(mm.mismatch("ark", "qwen-max"), "dashscope", "★对照★ 通义的型号挂在方舟渠道上，判挂错");
    eq(mm.mismatch("moonshot", "kimi-k2-250711"), "ark", "★对照★ 方舟上架的那条挂回月之暗面，也判挂错");

    // ---- 真挪：往已有的同家渠道上挪，优先挑填了 Key 的那条
    {
      const providers = [
        { id: "ark-empty", name: "方舟（空壳）", kind: "ark", base_url: ARK, api_key: "" },
        { id: "ark-paid", name: "方舟（付费）", kind: "ark", base_url: ARK, api_key: K1 },
        { id: "dash", name: "百炼", kind: "dashscope", base_url: DASH, api_key: K2 },
      ];
      const models = [{ id: "image-x", cap: "image", name: "画图", provider: "dash", model: "doubao-seedream-4-0-250828" }];
      const moved = mm.rehomeMismatched(providers, models);
      eq(moved.length, 1, "挂错了一条，就该挪一条");
      eq(models[0].provider, "ark-paid", "挪到填了 Key 的那条方舟渠道，不是那个空壳");
      eq(moved[0].from, "dash", "挪动记录里写明从哪儿来");
      eq(moved[0].to, "ark-paid", "也写明到哪儿去（调用方拿去回给前端）");
      eq(moved[0].want, "ark", "以及它本该在的那类渠道");
    }

    // ---- 本机没有同家渠道时：只警告，绝不新建空壳渠道
    // 新建出来的必然没 Key，
    // 挪过去只是把「型号不存在」换成「401」，问题没解决，配置还脏了一条。
    {
      const providers = [{ id: "dash", name: "百炼", kind: "dashscope", base_url: DASH, api_key: K2 }];
      const models = [{ id: "image-x", cap: "image", name: "画图", provider: "dash", model: "doubao-seedream-4-0-250828" }];
      const moved = mm.rehomeMismatched(providers, models);
      eq(moved.length, 0, "没处可挪就不挪");
      eq(providers.length, 1, "更不许为了挪它新建一条没 Key 的方舟渠道");
      eq(models[0].provider, "dash", "原地不动，留给用户自己去开号");
    }

    // ---- ★反向对照★ 没挂错的一条都不许动。这条是整组里最要紧的：
    // rehomeMismatched 跑在每次 normalize 里，误挪一次就改了用户的存盘配置。
    {
      const providers = [
        { id: "ark", name: "方舟", kind: "ark", base_url: ARK, api_key: K1 },
        { id: "dash", name: "百炼", kind: "dashscope", base_url: DASH, api_key: K2 },
      ];
      const models = [
        { id: "image-x", cap: "image", name: "画图", provider: "ark", model: "doubao-seedream-4-0-250828" },
        { id: "video-x", cap: "video", name: "视频", provider: "dash", model: "wanx2.1-t2v-turbo" },
        { id: "vision-x", cap: "vision", name: "看图", provider: "ark", model: "glm-5-3-flash-260828" },
        { id: "tts-x", cap: "tts", name: "配音", provider: "dash", model: "自己起的名字" },
      ];
      const before = models.map((m) => m.provider).join(",");
      const moved = mm.rehomeMismatched(providers, models);
      eq(moved.length, 0, "★对照★ 四条都挂对了，一条都不许挪");
      eq(models.map((m) => m.provider).join(","), before, "★对照★ provider 字段原样不动");
    }

    // ---- 走完整条 normalize：挪完再选默认，顺序反了压平下来的就还是错地址
    {
      const c = {
        providers: [
          { id: "dash", name: "百炼", kind: "dashscope", base_url: DASH, api_key: K2 },
          { id: "ark", name: "方舟", kind: "ark", base_url: ARK, api_key: K1 },
        ],
        media_models: [{ id: "image-x", cap: "image", name: "画图", provider: "dash", model: "doubao-seedream-4-0-250828", default: true }],
        media: {},
      };
      mm.normalize(c);
      eq(c.media_models[0].provider, "ark", "normalize 里也会挪");
      eq(c.media.image.base_url, ARK, "压平下来的是挪之后那条渠道的地址");
      eq(c.media.image.api_key, K1, "Key 也是挪之后那条的——这才是「挪完再压平」的意义");
    }
  }

  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
}

// ---------------------------------------------------------------- 5b
/**
 * 转写这一路（transcribe_audio）。
 *
 * 跟前面几路不一样的地方在于：它是唯一一个**把用户本机的文件传出去**的媒体工具，
 * 所以「什么不发出去」比「发出去长什么样」更要紧——没配、文件不存在、后缀不对、
 * 超 25MB、渠道是百炼（协议根本对不上），这五种都必须在本机就拦住，一个字节都不许上传。
 * 每条拦截后面都跟一条「确实发了请求」的反向对照，不然把 fetch 整个注释掉也能全绿。
 */
async function asrChecks() {
  console.log("\n【5b】转写：该拦的在本机就拦住，该发的打到对的渠道");
  const tools = require(path.join(ROOT, "tools"));
  const { transcribeAudio, srtTime } = tools._internals;

  // 时间轴格式先单独钉住：它决定字幕文件对不对得上，错了肉眼看不出来
  eq(srtTime(0), "00:00:00,000", "srt 时间轴：0 秒");
  eq(srtTime(58.999), "00:00:58,999", "srt 时间轴：58.999 秒还留在第 0 分钟（不许进位成 59.000 却跨分钟）");
  eq(srtTime(61.2), "00:01:01,200", "srt 时间轴：61.2 秒 → 1 分 1 秒 200 毫秒");
  eq(srtTime(3661.5), "01:01:01,500", "srt 时间轴：跨小时");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-asr-"));
  const rel = "会议.mp3";
  fs.writeFileSync(path.join(dir, rel), Buffer.alloc(4096, 7));
  fs.writeFileSync(path.join(dir, "笔记.txt"), "这不是音频");
  const resolveFile = (r) => path.join(dir, String(r));

  const seen = [];
  const realFetch = global.fetch;
  let reply = { text: "第一句。第二句。" };
  global.fetch = async (url, init) => {
    const b = (init || {}).body;
    seen.push({
      url: String(url), auth: ((init || {}).headers || {}).Authorization,
      model: b && b.get ? b.get("model") : "", fmt: b && b.get ? b.get("response_format") : "",
      lang: b && b.get ? b.get("language") : null, filename: b && b.get && b.get("file") ? b.get("file").name : "",
    });
    return { ok: true, status: 200, json: async () => reply, text: async () => "" };
  };

  try {
    // ① 一路都没配：报错要说清去哪儿配，且别让模型重试
    const nil = mm.resolve({ providers: [], media_models: [] });
    seen.length = 0;
    let r = await transcribeAudio(nil, { path: rel }, 1000, resolveFile, dir);
    eq(r.isError, true, "没配转写模型 → 报错");
    ok(/设置/.test(r.content) && /不用重试/.test(r.content), "报错指路去设置里配，并明说别重试", r.content);
    eq(seen.length, 0, "没配的时候一个请求都没发");

    // 正常配置：一把 Key 的自有网关
    const cfg = {
      providers: [{ id: "asr-gw", name: "转写网关", kind: "custom", base_url: "https://asr.example.test/v1", api_key: "asr-key-1" }],
      media_models: [{ cap: "asr", name: "会议转写", provider: "asr-gw", model: "gpt-4o-transcribe" }],
    };
    mm.normalize(cfg);
    const media = mm.resolve(cfg);

    // ② 文件不存在 / ③ 后缀不是音频 / ④ 超 25MB —— 三条都不许发请求
    seen.length = 0;
    r = await transcribeAudio(media, { path: "不存在的录音.mp3" }, 1000, resolveFile, dir);
    eq(r.isError, true, "文件不存在 → 报错");
    eq(seen.length, 0, "文件不存在时没发请求");

    r = await transcribeAudio(media, { path: "笔记.txt" }, 1000, resolveFile, dir);
    eq(r.isError, true, "后缀不是音频 → 报错");
    ok(/read_file/.test(r.content), "报错顺手指出文本该用 read_file", r.content);
    eq(seen.length, 0, "后缀不对时没发请求");

    const big = "超长会议.mp3";
    fs.writeFileSync(path.join(dir, big), Buffer.alloc(1024, 7));
    fs.truncateSync(path.join(dir, big), 26 * 1048576); // 稀疏文件，不真占 26MB
    r = await transcribeAudio(media, { path: big }, 1000, resolveFile, dir);
    eq(r.isError, true, "超 25MB → 报错");
    ok(/ffmpeg/.test(r.content) && /26\.0MB/.test(r.content), "报错给出能照抄的 ffmpeg 压缩命令和真实体积", r.content);
    eq(seen.length, 0, "超限时没把 26MB 传出去");

    // ⑤ 百炼：协议根本不是一套，宁可拒绝也不发一个必然 404 的请求
    const dashCfg = {
      providers: [{ id: "dash", name: "百炼", kind: "dashscope", base_url: DASH, api_key: K2 }],
      media_models: [{ cap: "asr", name: "百炼转写", provider: "dash", model: "paraformer-v2" }],
    };
    mm.normalize(dashCfg);
    r = await transcribeAudio(mm.resolve(dashCfg), { path: rel }, 1000, resolveFile, dir);
    eq(r.isError, true, "渠道是百炼 → 直接说没接，不硬发");
    ok(/异步/.test(r.content), "报错说清为什么没接（异步任务接口）", r.content);
    eq(seen.length, 0, "百炼那一路一个请求都没发");

    // 反向对照：前面拦了五次，这一次必须真的发出去，而且打到对的地方
    seen.length = 0;
    r = await transcribeAudio(media, { path: rel, language: "zh", filename: "会议纪要.txt" }, 1000, resolveFile, dir);
    eq(r.isError, false, "反向对照：配好了、文件对了 → 转写成功", r.content);
    eq(seen.length, 1, "反向对照：确实发了一个请求");
    eq(seen[0].url, "https://asr.example.test/v1/audio/transcriptions", "打到 OpenAI 兼容的转写接口");
    eq(seen[0].auth, "Bearer asr-key-1", "带的是这个渠道的 Key");
    eq(seen[0].model, "gpt-4o-transcribe", "用的是这一路点名的模型");
    eq(seen[0].fmt, "json", "不要时间轴时只要 json");
    eq(seen[0].lang, "zh", "语言提示传了过去");
    eq(seen[0].filename, rel, "上传时带上原始文件名（上游按后缀判格式）");
    eq(fs.readFileSync(path.join(dir, "会议纪要.txt"), "utf8"), "第一句。第二句。", "转写稿按 filename 存盘");
    ok(/会议纪要\.txt/.test(r.content) && /第一句/.test(r.content), "回给模型的话里既有路径也有正文开头", r.content);

    // 要时间轴：多存一份同名 .srt
    reply = { text: "你好。再见。", segments: [{ start: 0, end: 2.5, text: " 你好。" }, { start: 58.999, end: 61.2, text: "再见。" }] };
    seen.length = 0;
    r = await transcribeAudio(media, { path: rel, with_timestamps: true, filename: "带轴.txt" }, 1000, resolveFile, dir);
    eq(r.isError, false, "要时间轴也能转写成功", r.content);
    eq(seen[0].fmt, "verbose_json", "要时间轴时改要 verbose_json");
    const srt = fs.readFileSync(path.join(dir, "带轴.srt"), "utf8");
    ok(srt.startsWith("1\n00:00:00,000 --> 00:00:02,500\n你好。"), "srt 第一段格式对（序号 / 时间轴 / 去掉前后空格的正文）", srt.slice(0, 60));
    ok(srt.includes("2\n00:00:58,999 --> 00:01:01,200\n再见。"), "srt 第二段的时间轴也对", srt.slice(-60));

    // 反向对照：模型不给分段时，不许假装字幕已经出好了
    reply = { text: "只有正文。" };
    r = await transcribeAudio(media, { path: rel, with_timestamps: true, filename: "没轴.txt" }, 1000, resolveFile, dir);
    eq(r.isError, false, "反向对照：没有分段也算转写成功", r.content);
    eq(fs.existsSync(path.join(dir, "没轴.srt")), false, "反向对照：没分段就不该凭空冒出 .srt");
    ok(/没给分段/.test(r.content), "反向对照：照实说一句「.srt 没生成」", r.content);

    // 长稿不整篇塞回对话：上下文是有限的，全文留在文件里
    reply = { text: "长".repeat(5000) };
    r = await transcribeAudio(media, { path: rel, filename: "长稿.txt" }, 1000, resolveFile, dir);
    eq(r.isError, false, "长稿也转写成功", r.content);
    ok(r.content.length < 3000, "长稿只贴开头，不把 5000 字整篇塞回上下文", r.content.length);
    ok(/全文 5000 字/.test(r.content) && /read_file/.test(r.content), "明说全文多少字、去哪儿读", r.content.slice(-120));
    eq(fs.readFileSync(path.join(dir, "长稿.txt"), "utf8").length, 5000, "文件里是完整的 5000 字");
  } finally {
    global.fetch = realFetch;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 生视频的时长 / 画幅 / 分辨率（任务 2.3）。
 *
 * 三件一错就花冤枉钱的事：
 *   1. 夹紧——型号出不了的时长不许原样发（整单 400 或上游按默认出、钱照扣），夹了必须在回执里说；
 *   2. 计价——按夹完之后真出片的秒数记，要 10 秒只出 5 秒，账上就是 5 秒；
 *   3. 映射——同一个 duration，五家字段各不相同，发错字段等于没发。
 * 反向对照：一个参数都不传时，五家的请求体里一个新字段都不许多出来（老调用逐字节不变）。
 */
async function videoParamChecks() {
  console.log("\n【5c】生视频参数：按型号表夹紧、按实际秒数计价、五家字段各自映射");
  const tools = require(path.join(ROOT, "tools"));
  const { generateVideo, unitsFor, videoPlan } = tools._internals;
  const pricing = require(path.join(ROOT, "pricing"));

  const ZP = "https://open.bigmodel.cn/api/paas/v4";
  const MX = "https://api.minimax.chat/v1";
  const SF = "https://api.siliconflow.cn/v1";
  const cfgOf = (kind, base_url, model) => ({ kind, base_url, model, api_key: "k-" + kind });
  const WAN = cfgOf("dashscope", DASH, "wan2.2-t2v-plus");
  const WAN_I2V = cfgOf("dashscope", DASH, "wan2.2-i2v-plus");
  const TURBO = cfgOf("dashscope", DASH, "wanx2.1-t2v-turbo");
  const SEED = cfgOf("ark", ARK, "doubao-seedance-1-0-pro-250528");
  const SEED_NEW = cfgOf("ark", ARK, "doubao-seedance-9-9-pro");      // 表里没有的新型号
  const COG = cfgOf("zhipu", ZP, "cogvideox-3");
  const HAILUO = cfgOf("minimax", MX, "MiniMax-Hailuo-02");
  const SFWAN = cfgOf("siliconflow", SF, "Wan-AI/Wan2.2-T2V-A14B");

  // ── ① 夹紧 ──────────────────────────────────────────────
  let p = videoPlan(WAN, { duration: 10 });
  eq(p.seconds, 5, "万相 2.2 要 10 秒 → 按 5 秒出（它只出得了 5 秒）");
  eq(p.send.duration, undefined, "只有一档的型号不发 duration（那一档就是它的默认，多发只多一个被拒的机会）");
  ok(p.notes.includes("该模型只支持 5 秒，已按 5 秒生成。"), "回执里明说「只支持 5 秒，已按 5 秒生成」——夹了不说就是静默降级", p.notes);

  p = videoPlan(SEED, { duration: 7 });
  eq(p.seconds, 5, "Seedance 要 7 秒 → 就近取 5 秒");
  eq(p.send.duration, 5, "Seedance 有 5/10 两档，夹完的值要发出去");
  ok(p.notes.some((n) => /只收 5\/10 秒，已按 5 秒生成/.test(n)), "多档型号夹了也要说，并列出它收哪几档", p.notes);
  eq(videoPlan(SEED, { duration: 8 }).seconds, 10, "Seedance 要 8 秒 → 取离得近的 10 秒");
  eq(videoPlan(SEED, { duration: "10秒" }).seconds, 10, "「10秒」「10s」这种写法也认");
  p = videoPlan(SEED, { duration: 10 });
  eq(p.notes.length, 0, "反向对照：要的正好是它收的那档，一句多余的话都没有", p.notes);
  eq(p.send.duration, 10, "反向对照：原样发 10");

  p = videoPlan(SEED, { duration: "五秒" });
  ok(/正整数秒/.test(p.err), "「五秒」这种写坏的值在发之前就退回", p.err);

  p = videoPlan(HAILUO, {});
  eq(p.seconds, 6, "海螺不传时长 → 按它的默认 6 秒记（不是别家的 5 秒）");
  p = videoPlan(HAILUO, { duration: 10, resolution: "1080p" });
  eq(p.seconds, 10, "海螺 10 秒 + 1080p：时长保住（片长是分镜定死的）");
  eq(p.send.resolution, 768, "……分辨率降到 768（它 1080P 只出 6 秒）");
  ok(p.notes.some((n) => /出 10 秒时不收 1080p，已按 768p 生成/.test(n)), "降档的原因说清楚", p.notes);
  ok(videoPlan(HAILUO, { aspect_ratio: "9:16" }).notes.some((n) => /没有画幅参数/.test(n)), "海螺没有画幅参数：不发，并说一声");

  p = videoPlan(WAN, { aspect_ratio: "21:9" });
  eq(p.send.size, "1920*1080", "万相文生不收 21:9 → 就近取 16:9，按默认 1080 档合成 size");
  ok(p.notes.some((n) => /不收 21:9，已按 16:9 生成/.test(n)), "画幅夹了也说，而且说的是人写的「21:9」（不是约分后的 7:3）", p.notes);
  p = videoPlan(SEED, { aspect_ratio: "21:9" });
  eq(p.send.aspect, "21:9", "Seedance 收 21:9：原样发");
  eq(p.notes.length, 0, "反向对照：收的画幅不加说明", p.notes);
  eq(videoPlan(SEED, { aspect_ratio: "1920x1080" }).send.aspect, "16:9", "「1920x1080」这种写法约成 16:9");
  p = videoPlan(WAN_I2V, { aspect_ratio: "9:16", resolution: "720p" }, { firstFrame: true });
  eq(p.send.aspect, undefined, "图生视频：画幅跟着首帧走，aspect_ratio 不发");
  eq(p.send.resolution, 480, "图生视频的分辨率照表夹紧（720 离 480 更近）");

  p = videoPlan(SEED_NEW, { duration: 12 });
  eq(p.send.duration, 12, "表里没有的型号：不拿老型号的表去夹，原样发");
  ok(p.notes.some((n) => /不在内置参数表里/.test(n)), "……并在回执里写明「没校验」", p.notes);

  p = videoPlan(SEED, { prompt: "猫 --duration 10", duration: 5 });
  eq(p.seconds, 10, "方舟提示词里自己写了 --duration 10：上游认的是它，计价也跟它走");
  ok(p.notes.some((n) => /提示词里写了 --duration 10/.test(n)), "跟 duration 参数打架时说一声", p.notes);

  for (const c of [WAN, SEED, COG, HAILUO, SFWAN]) {
    const q = videoPlan(c, {});
    ok(Object.keys(q.send).length === 0 && q.notes.length === 0, `反向对照：${c.kind} 不传参数 → 什么都不多发、什么都不多说`, q);
  }

  // 精选目录上挂了可选值，界面按它出下拉
  const seedCat = mm.CATALOG.video.find((m) => m.id === "doubao-seedance-1-0-pro-250528") || {};
  ok(JSON.stringify(seedCat.durations) === "[5,10]" && (seedCat.resolutions || []).includes("1080p"),
    "精选目录里 Seedance pro 带着能选的时长和档位", seedCat);

  // ── ② 计价：按实际秒数 ─────────────────────────────────────
  eq(unitsFor("video", { duration: 10 }, null, WAN), 5, "★计价：万相要 10 秒只出 5 秒 → 记 5 秒★");
  eq(unitsFor("video", { duration: 10 }, null, SEED), 10, "计价：Seedance 要 10 秒出 10 秒 → 记 10 秒");
  eq(unitsFor("video", { duration: 7 }, null, SEED), 5, "计价：Seedance 要 7 秒夹成 5 秒 → 记 5 秒");
  eq(unitsFor("video", {}, null, HAILUO), 6, "计价：海螺不传时长 → 记它默认的 6 秒（以前一律按 5 秒，少记了）");
  const hm = mm.resolve((() => {
    const c = { providers: [{ id: "mx", name: "海螺", kind: "minimax", base_url: MX, api_key: "k" }],
      media_models: [{ cap: "video", name: "海螺02", provider: "mx", model: "MiniMax-Hailuo-02" }] };
    mm.normalize(c);
    return c;
  })());
  eq(unitsFor("video", { duration: 7 }, null, hm), 6, "计价：传整份 media 也行（按默认那一路认型号），海螺 7 秒夹成 6 秒");
  eq(unitsFor("video", { duration: 10 }), 10, "反向对照：认不出型号（没给配置）时只能按人要的秒数估");
  eq(unitsFor("video", {}), 5, "反向对照：什么都没有 → 按 5 秒估");
  const yuan = pricing.costOfUnits({ cap: "video", model: TURBO.model, units: unitsFor("video", { duration: 10 }, null, TURBO) });
  eq(yuan.yuan, 1.2, "★账单：万相 turbo 要 10 秒，按实际 5 秒 × 0.24 = 1.2 元，不是 2.4 元★");

  // ── ③ 请求体：五家各自的字段 ──────────────────────────────
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-vparam-"));
  const CDN = "https://cdn.example.test/v.mp4";
  const js = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  const submits = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    const body = () => { const b = JSON.parse((init || {}).body || "{}"); submits.push({ u, b }); return b; };
    if (/\/video-synthesis$/.test(u)) { body(); return js({ output: { task_id: "w1" } }); }
    if (/\/tasks\/w1$/.test(u)) return js({ output: { task_status: "SUCCEEDED", video_url: CDN } });
    if (/\/contents\/generations\/tasks$/.test(u)) { body(); return js({ id: "a1" }); }
    if (/\/contents\/generations\/tasks\/a1$/.test(u)) return js({ status: "succeeded", content: { video_url: CDN } });
    if (/\/videos\/generations$/.test(u)) { body(); return js({ id: "z1" }); }
    if (/\/async-result\/z1$/.test(u)) return js({ task_status: "SUCCESS", video_result: [{ url: CDN }] });
    if (/\/video_generation$/.test(u)) { body(); return js({ task_id: "m1", base_resp: { status_code: 0 } }); }
    if (/\/query\/video_generation\?task_id=m1$/.test(u)) return js({ status: "Success", file_id: "f1" });
    if (/\/files\/retrieve\?file_id=f1$/.test(u)) return js({ file: { download_url: CDN } });
    if (/\/video\/submit$/.test(u)) { body(); return js({ requestId: "s1" }); }
    if (/\/video\/status$/.test(u)) return js({ status: "Succeed", results: { videos: [{ url: CDN }] } });
    if (u === CDN) return { ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(64, 9), json: async () => ({}), text: async () => "" };
    throw new Error("测试里没准备这个地址：" + u);
  };
  const run = async (cfg, input) => {
    submits.length = 0;
    const r = await generateVideo({ video: cfg, list: [] }, { prompt: "一只猫跑过草地", ...input }, { saveDir });
    return { r, b: (submits[0] || {}).b || {} };
  };

  try {
    let { r, b } = await run(WAN, { duration: 10, aspect_ratio: "9:16", resolution: "480p", filename: "w.mp4" });
    eq(r.isError, false, "万相：带参数也能出片", r.content);
    eq(b.parameters.size, "480*832", "万相文生：9:16 + 480p → parameters.size 是「480*832」");
    eq(b.parameters.duration, undefined, "万相 2.2 只出 5 秒：duration 不发");
    ok(/该模型只支持 5 秒，已按 5 秒生成/.test(r.content), "★回执里写着「该模型只支持 5 秒，已按 5 秒生成」★", r.content.slice(-120));
    ({ r, b } = await run(WAN, { filename: "w0.mp4" }));
    ok(b.parameters && !("size" in b.parameters) && !("duration" in b.parameters) && !("resolution" in b.parameters),
      "反向对照：万相不传参数 → parameters 里一个新字段都没有", b.parameters);
    ok(!/该模型|没发|没校验/.test(r.content), "反向对照：没夹、没丢参数就一句参数说明都不加", r.content.slice(-80));

    ({ r, b } = await run(SEED, { duration: 7, aspect_ratio: "9:16", resolution: "1080p", filename: "a.mp4" }));
    const text = ((b.content || [])[0] || {}).text || "";
    ok(/ --duration 5 --ratio 9:16 --resolution 1080p$/.test(text), "方舟：三个参数写成提示词里的文本指令，时长是夹过的 5", text);
    ok(text.indexOf("--watermark false") > 0, "方舟：去水印那条指令还在", text);
    eq(unitsFor("video", { duration: 7 }, null, SEED), +((text.match(/--duration (\d+)/) || [])[1]), "★同一趟：发出去的秒数 = 计价的秒数★");
    ({ b } = await run(SEED, { filename: "a0.mp4" }));
    eq(((b.content || [])[0] || {}).text, "一只猫跑过草地 --watermark false", "反向对照：方舟不传参数 → 提示词跟以前逐字一样");

    ({ r, b } = await run(COG, { duration: 10, aspect_ratio: "16:9", filename: "z.mp4" }));
    eq(b.size, "1920x1080", "智谱：size 写成「宽x高」");
    eq(b.duration, 10, "智谱 3 代：duration 10 原样发");
    ({ b } = await run(COG, { filename: "z0.mp4" }));
    ok(!("size" in b) && !("duration" in b), "反向对照：智谱不传参数 → 请求体里没有 size / duration", b);

    ({ r, b } = await run(HAILUO, { duration: 10, resolution: "1080p", filename: "m.mp4" }));
    eq(b.duration, 10, "海螺：duration 10");
    eq(b.resolution, "768P", "海螺：分辨率写成「768P」，而且是降过档的");
    ok(/已按 768p 生成/.test(r.content), "海螺降档写进回执", r.content.slice(-120));
    ({ b } = await run(HAILUO, { filename: "m0.mp4" }));
    ok(!("duration" in b) && !("resolution" in b), "反向对照：海螺不传参数 → 请求体里没有 duration / resolution", b);

    ({ r, b } = await run(SFWAN, { duration: 10, aspect_ratio: "9:16", filename: "s.mp4" }));
    eq(b.image_size, "720x1280", "硅基流动：尺寸走 image_size");
    ok(!("duration" in b), "硅基流动接口里没有时长字段：不发", b);
    ok(/只支持 5 秒/.test(r.content), "……并在回执里说只出 5 秒", r.content.slice(-120));
    ({ b } = await run(SFWAN, { filename: "s0.mp4" }));
    ok(!("image_size" in b), "反向对照：硅基流动不传参数 → 没有 image_size", b);

    submits.length = 0;
    r = await generateVideo({ video: SEED, list: [] }, { prompt: "猫", duration: "五秒", filename: "bad.mp4" }, { saveDir });
    eq(r.isError, true, "duration 写坏 → 工具直接报错");
    eq(submits.length, 0, "……一个请求都没发（不花钱）");
    eq(fs.existsSync(path.join(saveDir, "bad.mp4")), false, "……也没落盘");
  } finally {
    global.fetch = realFetch;
    try { fs.rmSync(saveDir, { recursive: true, force: true }); } catch {}
  }
}

function done() {
  asrChecks().then(videoParamChecks).then(rest, (e) => {
    fail++;
    console.log("  ✗ 转写 / 生视频参数那组炸了：" + ((e && e.stack) || e));
    rest();
  });
}
