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

  // 引用了一个不存在的渠道：挂回第一个渠道，而不是留一条永远跑不起来的配置
  c.media_models.find((m) => m.cap === "image").provider = "provider-does-not-exist";
  mm.normalize(c);
  ok(c.providers.some((p) => p.id === c.media_models.find((m) => m.cap === "image").provider), "引用不存在的渠道会被挂回去");
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

function done() {
  asrChecks().then(rest, (e) => {
    fail++;
    console.log("  ✗ 转写那组炸了：" + ((e && e.stack) || e));
    rest();
  });
}
