"use strict";
/**
 * 内容配方：开头一张表单定岔路、按配方放宽上限、答案钉住不丢。
 *
 * 一条宣传片要定时长、画幅、画面、声音、封面、平台。以前这些是模型想起来才问，
 * 常常做到第 20 步才问「横版还是竖版」——人早走开了，任务卡在那一问上；
 * 问过的答案还会被历史压缩压没，下一轮又问一遍。这套测试钉住：
 *   ① 配方表本身：字段、默认值、岔路正则、跟技能说明书对得上；
 *   ② 表单怎么摆：用不了的选项标灰写原因、花钱的不悄悄当默认、单价不知道写「单价未知」不写 0 元；
 *   ③ 真跑一趟 agent：表单弹出去、答案钉进系统提示词、后面再问同一个岔路被挡、上限按配方放宽；
 *   ④ askForm / applyLimits / restore 的边角；
 *   ⑤ 前端表单卡：在一个假 DOM 里点一遍，交回去的 JSON 服务端能原样收；
 *   ⑥ 老用户升级时内置专家补绑新技能，用户删过的不塞回来；
 *   ⑦ 接线检查（别的文件里那几处）。
 *
 * 一个字节不出网：模型是按脚本回话的假模型，媒体渠道地址是 127.0.0.1:9、Key 是假的，只用来判「配没配」。
 * OWB_RECIPES_PREWIRE=1：接线还没合进来时，③⑦ 里没接上的打「跳过（等接线）」而不是红。
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const vm = require("vm");
const { execFileSync } = require("child_process");

// 技能目录跟着数据目录走（skills.js 在 require 时就算好了），所以得在 require 之前把家搬到临时目录
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-recipes-home-"));
process.env.OPENWORKBUDDY_HOME = HOME;
process.env.OPENWORKBUDDY_DATA_DIR = path.join(HOME, "data");
const ROOT = path.join(__dirname, "..");
const RECIPE_SKILLS = ["promo-video", "xhs-carousel", "multi-post"];
for (const n of RECIPE_SKILLS) {
  const src = path.join(ROOT, "skills", n);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(HOME, "skills", n), { recursive: true });
}

const R = require(path.join(ROOT, "recipes"));
const wf = require(path.join(ROOT, "workflow"));
const mm = require(path.join(ROOT, "media-models"));
const guard = require(path.join(ROOT, "skill-guard"));
const { validateExperts, mergeBuiltinExperts } = require(path.join(ROOT, "experts-lib"));
const tools = require(path.join(ROOT, "tools"));
const { createAgentRuntime } = require(path.join(ROOT, "agent"));
const { McpManager } = require(path.join(ROOT, "mcp"));

const PREWIRE = process.env.OWB_RECIPES_PREWIRE === "1";
const cleanup = [HOME];
let pass = 0, fail = 0, skipped = 0, finished = false;
process.on("exit", (code) => {
  for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`);
  process.exitCode = 1;
});
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra).slice(0, 600) : ""}`); }
}
function eq(got, want, name) {
  const same = typeof want === "object" && want !== null ? JSON.stringify(got) === JSON.stringify(want) : Object.is(got, want);
  ok(same, name, same ? undefined : { got, want });
}
/** 别的文件里的接线：接上了就测；没接上时，PREWIRE 打跳过，否则红 */
function wired(present, what) {
  if (present) return true;
  if (PREWIRE) { skipped++; console.log(`  - 跳过（等接线）：${what}`); return false; }
  fail++;
  console.log(`  ✗ 没接线：${what}（照 recipes-2 报告里的 WIRING NEEDED 补上）`);
  return false;
}
// 前缀写成字面量：仓库卫生那道闸按字面量认前缀，拼出来的它看不见，e2e 的扫帚也就不一定收得到
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "owb-recipes-")); cleanup.push(d); return d; };
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; } };
const cjkLen = (s) => [...String(s)].length;

/** 假的媒体渠道：只为让「配没配」判成配了，地址是个连不上的本机端口 */
function mediaCfg(caps, extra = {}) {
  const c = {
    providers: [{ id: "p1", kind: "openai", base_url: "http://127.0.0.1:9/v1", api_key: "sk-fake" }],
    media_models: caps.map((cap) => ({ cap, name: cap, provider: "p1", model: `fake-${cap}-1` })),
    ...extra,
  };
  mm.normalize(c);
  return c;
}

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log("\n① 配方表：字段、默认值、岔路正则、跟技能说明书对得上");
  {
    eq(R.list().map((r) => r.id), RECIPE_SKILLS, "三个内置配方：宣传片 / 小红书图文 / 一稿多投");
    eq(R.get("PROMO-VIDEO ") && R.get("PROMO-VIDEO ").id, "promo-video", "get 认大小写和空白");
    eq(R.get("nope"), null, "不认识的配方 → null，不抛");
    const tracked = (() => {
      try { return new Set(execFileSync("git", ["ls-files", "skills"], { cwd: ROOT, encoding: "utf8" }).split("\n").map((l) => l.split("/")[1]).filter(Boolean)); }
      catch { return null; }
    })();
    for (const r of R.BUILTIN) {
      const at = `「${r.id}」`;
      ok(r.fields.length >= 3 && r.fields.length <= 8, `${at}字段 3–8 项（多了人不填）`, r.fields.length);
      ok(r.limits.max_steps <= R.HARD.steps && r.limits.max_runtime_min <= R.HARD.runtimeMin, `${at}上限不超过硬顶`);
      const bad = [];
      const names = new Set();
      for (const f of r.fields) {
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(f.name)) bad.push(`${f.name} 名字不合规`);
        if (names.has(f.name)) bad.push(`${f.name} 重名`);
        names.add(f.name);
        if (!f.label || cjkLen(f.label) > 40) bad.push(`${f.name} 标签空或太长`);
        if (!["select", "multi", "text"].includes(f.type)) bad.push(`${f.name} 类型不认识`);
        const vs = (f.options || []).map((o) => o.v);
        if (new Set(vs).size !== vs.length) bad.push(`${f.name} 选项值重复`);
        if (f.type === "select" && !vs.includes(f.default)) bad.push(`${f.name} 默认值不在选项里`);
        if (f.type === "multi" && !(Array.isArray(f.default) && f.default.length >= (f.min || 1) && f.default.every((v) => vs.includes(v)))) bad.push(`${f.name} 多选默认值不对`);
        if (f.type === "text" && !(f.max > 0)) bad.push(`${f.name} 文本没写上限`);
        for (const o of f.options || []) if (o.needs && !["video", "image", "tts", "renderer"].includes(o.needs)) bad.push(`${f.name}.${o.v} needs 不认识`);
        for (const src of f.covers || []) { try { new RegExp(src, "i"); } catch (e) { bad.push(`${f.name} 岔路正则编不过：${e.message}`); } }
      }
      eq(bad, [], `${at}字段规格全合规（名字、默认值在选项里、文本有上限、正则编得过）`);

      // 流程文件：cli 的 `openworkbuddy workflow <配方>` 就跑它
      const flow = R.workflowOf(r.id);
      const parsed = wf.parse(JSON.stringify(flow));
      ok(!parsed.error, `${at}生成的流程文件过得了 workflow.parse`, parsed.error);
      eq(flow.inputs.map((i) => i.name), r.fields.map((f) => f.name), `${at}流程的 inputs 跟表单字段一一对应`);
      if (parsed.inputs) eq(parsed.inputs.map((i) => i.name), r.fields.map((f) => f.name), `${at}  └ parse 收下的 inputs 也一样`);
      ok(flow.steps.every((s) => s.prompt.startsWith(`【使用技能：${r.skill}】【配方表单已填：${r.id}】{{input.__json}}\n`)), `${at}每一步开头都带技能标记和表单预填`);
      const pre = R.PRESET_RE.exec(flow.steps[0].prompt.replace("{{input.__json}}", JSON.stringify({ a: 1 })));
      ok(pre && pre[1] === r.id && pre[2] === '{"a":1}', `${at}  └ 预填标记能被 PRESET_RE 认回来`);

      // 技能说明书：跟代码里的表对得上
      const dir = path.join(ROOT, "skills", r.skill);
      const md = read(path.join("skills", r.skill, "skill.md"));
      ok(!!md, `${at}技能目录 skills/${r.skill}/skill.md 在`);
      if (!md) continue;
      const fm = /^---\n([\s\S]*?)\n---/.exec(md);
      const name = fm && (/^name:\s*(.+)$/m.exec(fm[1]) || [])[1];
      const desc = fm && (/^description:\s*(.+)$/m.exec(fm[1]) || [])[1];
      eq(name && name.trim(), r.skill, `${at}  └ frontmatter 的 name 跟目录一致`);
      ok(desc && cjkLen(desc.trim()) <= 60, `${at}  └ description 60 字以内（每次都进系统提示词）`, desc && cjkLen(desc));
      eq(guard.scanDir(dir).level, "ok", `${at}  └ 过得了技能安检，一条提示都没有`);
      ok(md.includes(`form: "${r.id}"`), `${at}  └ 说明书第 0 步让模型带 form: "${r.id}" 调 ask_user`);
      ok(md.includes(`${r.limits.max_steps} 步 / ${r.limits.max_runtime_min} 分钟`), `${at}  └ 说明书里写的上限跟代码一致（${r.limits.max_steps} 步 / ${r.limits.max_runtime_min} 分钟）`);
      const nums = new Set();
      for (const s of R._internals.STEPS[r.id]) {
        for (const m of s.text.matchAll(/第 (\d)(?:–(\d))? 步/g)) for (let i = +m[1]; i <= +(m[2] || m[1]); i++) nums.add(i);
      }
      const miss = [...nums].filter((n) => !md.includes(`## 第 ${n} 步`));
      eq(miss, [], `${at}  └ 流程每步引用的「第 N 步」在说明书里都有这一节`);
      ok(!/\bsay\b/.test(md), `${at}  └ 说明书里没有拿系统朗读（say）凑配音的路`);
      ok(!/水印/.test(md) || /不加任何「AI 生成」水印/.test(md), `${at}  └ 提到水印只说「不加」`);
      // 引用的别的技能必须是随包发的：gitignore 掉的那几个，用户机器上根本没有
      const refs = [...new Set([...md.matchAll(/\b([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/g)].map((m) => m[1]))]
        .filter((n) => n !== r.skill && fs.existsSync(path.join(ROOT, "skills", n)));
      if (tracked) eq(refs.filter((n) => !tracked.has(n) && !RECIPE_SKILLS.includes(n)), [], `${at}  └ 引用的别的技能（${refs.join("、") || "无"}）都随包发`);
    }
    if (tracked) {
      for (const n of RECIPE_SKILLS) if (wired(tracked.has(n), `skills/${n} 还没进 git（git add -N，不然打包带不上）`)) ok(true, `skills/${n} 已进 git，打包带得上`);
    }

    // 宣传片导演身上同时挂着 promo-video 和 video-compose：配音、拼片的做法两边不能打架
    const pv = read(path.join("skills", "promo-video", "skill.md")) || "", vc = read(path.join("skills", "video-compose", "skill.md")) || "";
    const oneShot = /一次 `text_to_speech`，传 `segments`/;
    ok(oneShot.test(pv) && /`compose_video`/.test(pv) && /dry_run: true/.test(pv), "promo-video：配音一次 segments 出整轨、拼片走 compose_video");
    ok(!/voice_\d|ffprobe|每个镜头一段 `text_to_speech`/.test(pv), "  └ 没有「每镜一段配音、ffprobe 量时长、concat」那套老路（video-compose 明说别这么做）");
    ok(oneShot.test(vc), "  └ video-compose 那边也是这个做法（两边对得上）");
    ok(/「这次不做」[^\n]*不改用 AI 生图/.test(pv) && /「这次不做」[^\n]*不改用 AI 生图/.test(read(path.join("skills", "xhs-carousel", "skill.md")) || ""), "封面、出图方式是「这次不做」时说明书写了怎么办，不改用 AI 生图");
    // 本机 ffmpeg 常常没编 drawtext（没带 libfreetype）：命令行里截不了图时卡片先走 HTML 渲染，drawtext 要先查有没有才用
    const dtLines = pv.split("\n").filter((l) => /drawtext/.test(l));
    ok(/"kind": ?"html"/.test(pv) && /render_motion[^\n]*html_files/.test(pv), "promo-video：命令行截不了图 → 卡片照样写 HTML，走 compose_video 的 kind html 或 render_motion");
    ok(dtLines.length > 0 && dtLines.every((l) => l.includes("ffmpeg -hide_banner -filters") && l.indexOf("-filters") < l.indexOf("drawtext") && /fontfile/.test(l) && /missing/.test(l)),
      "  └ 提到 drawtext 的地方都先查 ffmpeg 有没有它，中文写字体，没有就交 HTML、记进 missing", dtLines);

    // 岔路正则：成对的问法拦，擦边的不拦
    const pinOf = (id, values, notes = []) => ({ id, title: "", values: { ...R.defaultValues(R.get(id)), ...values }, notes, at: "" });
    const P = pinOf("promo-video", { product: "云朵枕", points: "透气" });
    const hits = [
      ["成片要横版还是竖版？", "画幅"], ["要 9:16 还是 16:9？", "画幅"], ["做方版 1:1 还是竖版？", "画幅"],
      ["15 秒还是 30 秒？", "时长"], ["视频要多长？", "时长"],
      ["用图文卡片还是 AI 生成画面？", "画面"], ["用我的素材还是另外做？", "画面"],
      ["要不要配音？", "声音"], ["配音还是只要字幕和音乐？", "声音"],
      ["封面用 AI 生图还是 HTML 排版截图？", "封面"],
      ["发哪些平台？", "发哪些平台"], ["发抖音还是视频号？", "发哪些平台"],
      ["是哪个产品？", "产品"], ["主打哪个卖点？", "主打卖点"],
      ["做哪个产品的宣传片？", "产品"], ["产品叫什么？", "产品"],
      ["画面用图文卡片还是 AI 生成？", "画面"], ["画面用图文卡片还是AI生成？", "画面"], ["这条是讲道理还是讲故事？", "画面"],
    ];
    for (const [q, label] of hits) {
      const got = R.coveredAsk(P, q);
      ok(got && got.includes(`「${label}：`), `宣传片表单定过了 → 「${q}」被挡回去（${label}）`, got);
    }
    ok(/画幅/.test(R.coveredAsk(P, "画幅选哪个？", [{ label: "横版 16:9", detail: "" }, { label: "竖版 9:16", detail: "" }]) || ""), "  └ 岔路写在选项里（问句只说「选哪个」）也认");
    for (const q of ["封面上放哪句话？", "30 秒的片子前 15 秒放什么？", "小红书的标题要带表情吗？", "片尾放品牌 logo 还是二维码？", "字幕用什么字体？",
      "产品名字要不要放封面上？", "产品名要不要放在片尾？", "产品叫什么要不要在开头就说？", "用哪个产品图当封面？"]) {
      eq(R.coveredAsk(P, q), null, `擦边的「${q}」不拦（只有一个词沾边不算在问这个岔路）`);
    }
    ok(!/「画面：/.test(R.coveredAsk(P, "封面用图文卡片还是 AI 生成？") || ""), "问的是封面「图文卡片还是 AI 生成」→ 不拿「画面」那项答它");
    eq(R.coveredAsk(pinOf("promo-video", { product: "" }), "是哪个产品？"), null, "产品没填时问「是哪个产品」是正当的，不拦");
    const said = R.coveredAsk(pinOf("promo-video", {}, ["用户补充：只要竖版，别做横版"]), "横版还是竖版？");
    ok(said && /用户另外说过「只要竖版，别做横版」/.test(said), "用户补充过一句的，挡回去时把那句一起带上（冲突以那句为准）", said);
    eq(R.coveredAsk(null, "横版还是竖版？"), null, "没填过表单 → 一律不拦");
    const X = pinOf("xhs-carousel", { topic: "露营" });
    for (const [q, label] of [["做几张？", "张数"], ["浅色还是深色？", "风格"], ["干货还是种草？", "语气"], ["用 AI 生图还是排版截图？", "怎么出图"]]) {
      ok((R.coveredAsk(X, q) || "").includes(`「${label}：`), `小红书表单定过了 → 「${q}」被挡回去（${label}）`);
    }
    eq(R.coveredAsk(X, "第 3 张放什么？"), null, "小红书：「第 3 张放什么」不拦");
    for (const q of ["要做几张封面？", "封面候选出几张？"]) eq(R.coveredAsk(X, q), null, `小红书：「${q}」问的是封面张数，不拿卡片张数答它`);
    const M = pinOf("multi-post", { source: "稿子.docx" });
    for (const [q, label] of [["要不要配图？", "配图"], ["公众号还是小红书？", "发哪些平台"], ["保留原文还是重写？", "改多少"]]) {
      ok((R.coveredAsk(M, q) || "").includes(`「${label}：`), `一稿多投表单定过了 → 「${q}」被挡回去（${label}）`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n② 表单怎么摆：用不了的标灰写原因、花钱的不悄悄当默认、单价不知道不写 0 元");
  {
    eq(R.formFor("nope"), null, "不认识的配方 → null");
    const bare = R.formFor("promo-video", { config: {}, hasRenderer: false, brands: [] });
    const F = (form, name) => form.fields.find((f) => f.name === name);
    const O = (form, name, v) => (F(form, name).options || []).find((o) => o.v === v);
    ok(O(bare, "voice", "tts").disabled && /语音合成还没配/.test(O(bare, "voice", "tts").reason), "语音合成没配 → 「配音+字幕」标灰，写明去哪儿补");
    eq(F(bare, "voice").default, "music", "  └ 默认是「只要字幕+音乐」");
    ok(!bare.notes.some((n) => /^声音/.test(n)), "  └ 默认本来就是不花钱的那条，没挪，不多写说明", bare.notes);
    ok(!/朗读|say/.test(JSON.stringify(bare)), "  └ 没有拿系统朗读顶上的选项");
    eq(F(bare, "cover").default, "", "命令行里（截不了图）又没配生图 → 封面默认空，不摆一个做不出来的选项");
    ok(bare.notes.some((n) => /^封面：这台机器上都用不了/.test(n) && /这次不做/.test(n)), "  └ 卡片上写「这次不做这一项」", bare.notes);
    ok(R.summary(bare, R.defaultValues(bare)).includes("封面：这次不做"), "  └ 摘要里是「封面：这次不做」");
    eq(F(bare, "visual").default, "cards", "画面默认图文卡片（不花画面钱）");
    ok(O(bare, "visual", "ai").disabled && /生视频模型还没配/.test(O(bare, "visual", "ai").reason), "  └ AI 生成画面没配 → 标灰写原因");
    eq(bare.estimate.text, "画面和封面不花钱", "全是不花钱的选项 → 预估写「不花钱」");
    ok(bare.fields.every((f) => !("covers" in f)), "发给前端的字段里不带岔路正则");
    eq(bare.limitsNote, "最多 150 步、60 分钟", "上限说明摆在卡片上");

    const gui = R.formFor("promo-video", { config: {}, hasRenderer: true, brands: [] });
    eq(F(gui, "cover").default, "html", "桌面版（能截图）→ 封面默认排版截图");
    ok(!gui.notes.some((n) => /^封面/.test(n)), "  └ 没有多余的说明");

    const img = mediaCfg(["image"]);
    const paid = R.formFor("promo-video", { config: img, hasRenderer: false, brands: [] });
    eq(F(paid, "cover").default, "", "只剩花钱的 AI 生图一条 → 不替人选，默认「这次不做」（命令行、IM、超时都按默认走，没人看见这张表）");
    ok(!O(paid, "cover", "ai").disabled, "  └ AI 生图照样能点，要用就自己选");
    ok(paid.notes.some((n) => /^封面：.*「AI 生图」要花钱，没替你选/.test(n)), "  └ 卡片上写明「要花钱，没替你选」", paid.notes);
    eq(paid.estimate.text, "画面和封面不花钱", "  └ 照默认走一分钱不花");
    const paidAi = R.estimate(paid, { ...R.defaultValues(paid), cover: "ai" }, img);
    ok(/^单价未知：/.test(paidAi.text) && paidAi.unknown === true, "自己选了 AI 生图、查不到单价 → 「单价未知」", paidAi);
    ok(!/(^|[^\d.])0(\.0+)? ?元/.test(paidAi.text), "  └ 绝不写 0 元（0 元会被当成不花钱）", paidAi.text);
    const xhsPaid = R.formFor("xhs-carousel", { config: img, hasRenderer: false, brands: [] });
    eq(F(xhsPaid, "render").default, "", "小红书图文同理：截不了图、只剩 AI 生图 → 默认也不落上去");
    ok(xhsPaid.notes.some((n) => n.startsWith("怎么出图：命令行里截不了图")), "  └ 卡片上照样写明哪条为什么用不了", xhsPaid.notes);
    // 卡片说明是服务端拼的，界面文案闸门只扫 public/ 看不见：每种「配了哪几样 × 能不能截图」都拼一遍量长度
    const longNotes = [];
    for (let m = 0; m < 8; m++) for (const hasRenderer of [false, true]) {
      const caps = ["video", "image", "tts"].filter((_, i) => m & (1 << i));
      for (const r of R.list()) for (const n of R.formFor(r.id, { config: caps.length ? mediaCfg(caps) : {}, hasRenderer, brands: [] }).notes) if (cjkLen(n) > 40) longNotes.push(`${cjkLen(n)} 字：${n}`);
    }
    eq([...new Set(longNotes)], [], "卡片上每条说明都在 40 字以内（各种配法都拼一遍量）");
    const cardGo = R.parseAnswer(paid, JSON.stringify({ form: "promo-video", values: { ...R.defaultValues(paid), product: "云朵枕" } }));
    eq([cardGo.values.cover, cardGo.notes], ["", []], "  └ 卡片原样交回空的封面 → 照收「这次不做」，不记「填的用不了」");
    eq(R.parseAnswer(paid, JSON.stringify({ cover: "ai" })).values.cover, "ai", "  └ 自己点了 AI 生图 → 照收");

    const all = mediaCfg(["video", "image", "tts"], { unit_prices: { tts: { "fake-tts-1": { price: 2 } }, image: { "fake-image-1": 0.2 } } });
    const full = R.formFor("promo-video", { config: all, hasRenderer: true, brands: [] });
    eq(F(full, "voice").default, "music", "语音合成配上了 → 默认仍是「只要字幕+音乐」：配音按字数计费，得自己选");
    ok(!O(full, "voice", "tts").disabled, "  └ 「配音+字幕」可选");
    eq(full.estimate.text, "画面和封面不花钱", "  └ 什么都配齐了，照默认走也一分钱不花");
    ok(!O(full, "visual", "ai").disabled, "  └ AI 生成画面可选");
    eq(F(full, "visual").default, "cards", "  └ 但花钱的 AI 画面不会自己变成默认");
    const mixed = R.estimate(full, { ...R.defaultValues(full), visual: "ai", cover: "ai" }, all);
    ok(/^约 [\d.]+ 元（1 项单价未知没算进去）：/.test(mixed.text) && (mixed.text.match(/（单价未知）/g) || []).length === 1, "一部分知道单价 → 知道的加起来，写明几项没算", mixed.text);
    ok(/生成视频 60 秒（单价未知）/.test(mixed.text), "  └ 30 秒 × 两个画幅 = 60 秒生视频，单价未知的那项标出来", mixed.text);
    eq(mixed.unknown, true, "  └ unknown = true");
    const known = R.estimate(full, { ...R.defaultValues(full), voice: "tts", cover: "ai" }, all);
    ok(/^约 0\.87\d* 元：语音合成约 135 字、生成图片 3 张$/.test(known.text), "单价都知道 → 「约 … 元」加明细", known.text);
    const xhs = R.formFor("xhs-carousel", { config: all, hasRenderer: true, brands: [] });
    ok(/生成图片 12 张/.test(R.estimate(xhs, { ...R.defaultValues(xhs), render: "ai", count: "9" }, all).text), "小红书 9 张 AI 生图 = 9 张内页 + 3 张封面候选");
    const mp = R.formFor("multi-post", { config: all, hasRenderer: true, brands: [] });
    eq(F(mp, "images").default, "none", "一稿多投默认只要文字，不花钱");

    // 模型从用户原话里摘的 defaults：照规格收
    const d = R.formFor("promo-video", { config: {}, hasRenderer: true, brands: [], defaults: { product: "云朵枕", duration: "15 秒", aspects: "竖版", visual: "ai", platforms: ["抖音", "快手"] } });
    eq(F(d, "product").default, "云朵枕", "defaults：产品名照收");
    eq(F(d, "duration").default, "15", "  └「15 秒」认成 15");
    eq(F(d, "aspects").default, ["9:16"], "  └「竖版」认成 9:16");
    eq(F(d, "visual").default, "cards", "  └ 标灰的「AI 生成画面」不收（这台机器做不出来）");
    eq(F(d, "platforms").default, ["抖音", "视频号"], "  └ 多选里有一个不认识（快手）→ 整项不收，留表单默认");
    const one = R.formFor("promo-video", { config: {}, brands: ["云朵枕"] });
    eq(F(one, "product").default, "云朵枕", "品牌档案里只有一个产品 → 直接当默认");
    eq(F(one, "product").suggest, ["云朵枕"], "  └ 也摆成可点的一排");
    const two = R.formFor("promo-video", { config: {}, brands: ["云朵枕", "云朵被"] });
    eq([F(two, "product").default, F(two, "product").suggest.length], ["", 2], "两个产品 → 不替用户挑，只摆出来");

    // parseAnswer：表单 JSON、按钮、一句话、超时
    const f = gui;
    let p = R.parseAnswer(f, null);
    eq([p.timedOut, p.values.duration], [true, "30"], "超时（null）→ 按默认，timedOut");
    p = R.parseAnswer(f, R.FALLBACK_GO);
    eq(p.values, R.defaultValues(f), "「按默认开工」→ 全默认");
    ok(p.notes.some((n) => /^产品没填/.test(n)), "  └ 必填的产品空着 → 记一条「从前面的话里找，找不到在第一次汇报里问」", p.notes);
    p = R.parseAnswer(f, JSON.stringify({ form: "promo-video", values: { product: " 云朵枕 ", duration: "60", aspects: ["1:1", "9:16"], voice: "music" } }));
    eq([p.values.product, p.values.duration, p.values.aspects, p.notes], ["云朵枕", "60", ["9:16", "1:1"], []], "表单 JSON → 照收，多选按选项顺序排");
    p = R.parseAnswer(f, JSON.stringify({ duration: "45" }));
    ok(p.values.duration === "30" && p.notes.some((n) => n === "时长填的「45」用不了，按默认「30」"), "填了不在选项里的值 → 退默认并记一条，不整张作废", p.notes);
    p = R.parseAnswer(f, JSON.stringify({ aspects: ["9:16", "4:3"] }));
    eq(p.values.aspects, ["9:16", "16:9"], "多选里有一个不认识 → 整项退默认");
    p = R.parseAnswer(f, "时长 15 秒，只要竖版");
    eq([p.values.duration, p.values.aspects], ["15", ["9:16"]], "一句话「时长 15 秒，只要竖版」→ 能稳稳对上的直接改");
    ok(p.notes.includes("用户补充：时长 15 秒，只要竖版"), "  └ 整句话照样钉成「用户补充」");
    p = R.parseAnswer(f, "售价 150 元，卖点是透气");
    eq(p.values.duration, "30", "「售价 150 元」不会被当成 15 秒");
    p = R.parseAnswer(f, "只要方版");
    eq(p.values.aspects, ["1:1"], "「只要方版」→ 画幅只剩 1:1");
    p = R.parseAnswer(f, "{坏掉的 JSON");
    ok(p.notes.includes("用户补充：{坏掉的 JSON"), "JSON 坏了 → 当一句补充收，不抛");
    const noCover = R.workflowOf("promo-video", { config: {}, hasRenderer: false });
    ok(!("default" in noCover.inputs.find((i) => i.name === "cover")), "命令行里封面一条都用不了 → 流程文件不写 default（免得校验说默认值不在选项里）");
    eq(R.workflowOf("nope"), null, "workflowOf 不认识的配方 → null");
    // 命令行流程（openworkbuddy workflow xhs-carousel -i topic=…）：配了生图、截不了图，也不能默认就去花钱
    const W = require("../workflow");
    const cliFlow = W.parse(JSON.stringify(R.workflowOf("xhs-carousel", { config: img, hasRenderer: false })));
    ok(!cliFlow.error && !("default" in cliFlow.inputs.find((i) => i.name === "render")), "命令行 xhs-carousel：出图方式不带默认（不默认 AI 生图）", cliFlow.error);
    eq(W.resolveInputs(cliFlow.inputs, { topic: "早八通勤穿搭" }).values.render, "", "  └ 只给 -i topic → 出图方式是空（这次不做），不是 ai");
    eq(W.resolveInputs(cliFlow.inputs, { topic: "早八通勤穿搭", render: "ai" }).values.render, "ai", "  └ 明写 -i render=ai → 照用");
    const cliPromo = W.parse(JSON.stringify(R.workflowOf("promo-video", { config: mediaCfg(["image", "tts"]), hasRenderer: false })));
    const cliVals = W.resolveInputs(cliPromo.inputs, { product: "云朵枕" }).values;
    eq([cliVals.cover, cliVals.voice, R.estimate({ id: "promo-video" }, cliVals, {}).text], ["", "music", "画面和封面不花钱"], "命令行 promo-video：生图、语音都配了，只给产品名 → 封面不做、不配音，一分钱不花");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n③ 真跑一趟 agent：表单弹出去、答案钉住、同一个岔路不再问、上限按配方放宽");
  {
    const experts = { list: () => [], get: () => null };
    const U = { prompt: 10, completion: 5 };
    const END = { text: "写完了。", toolCalls: [], stopReason: "end", usage: U };
    const call = (id, name, input) => ({ text: "", toolCalls: [{ id, name, input }], stopReason: "tool_use", usage: U });
    const FORM = (id, form, defaults) => call(id, "ask_user", { question: "开工前把这几项定下来", form, ...(defaults ? { defaults } : {}) });
    const TODO = (i) => call(`td_${i}`, "todo_write", { todos: [{ content: `第 ${i} 步的产出`, status: "in_progress" }] });
    const PLAIN = (id) => call(id, "ask_user", { question: "先做哪一段？", options: [{ label: "开头", detail: "先把钩子定了" }, { label: "结尾", detail: "先把行动号召定了" }] });
    const scripted = (steps) => {
      const seen = [];
      let i = 0;
      return {
        provider: "假", model: "假模型", seen,
        chat: async ({ system, history }) => {
          seen.push({ system: String(system || ""), history: history.slice() });
          const s = steps[Math.min(i, steps.length - 1)]; i++;
          return typeof s === "function" ? s({ system, history }) : s;
        },
      };
    };
    const cfgOf = (agent = {}) => ({ agent: { max_steps: 12, tool_timeout_ms: 30000, ask_user_timeout_ms: 30000, ...agent } });
    const freshStats = () => ({ prompt: 0, completion: 0, cached: 0, calls: 0, startedAt: Date.now() });
    /** answer：函数 (q, 第几问) => 回答；null = 无人值守（不给 askUser） */
    const run = async ({ script, history, answer = () => R.FALLBACK_GO, agent, dir, baseDir = "任务1", maxSteps }) => {
      const ws = dir || tmp();
      const llm = scripted(script);
      const h = history || [{ role: "user", content: "给我们的新品云朵枕做条宣传片" }];
      const events = [], asked = [], stats = freshStats();
      const rt = createAgentRuntime({ config: cfgOf(agent), llm, mcpManager: new McpManager(), experts });
      let r = null, err = null;
      try {
        r = await tools.withWorkspace(ws, () => rt.runTask({
          history: h, baseDir, stats, emit: (e) => events.push(e),
          ...(answer ? { askUser: async (q) => { asked.push(q); return answer(q, asked.length); } } : {}),
          ...(maxSteps ? { maxSteps } : {}),
        }));
      } catch (e) { err = e; }
      const toolText = (id) => {
        for (const m of h) if (m && m.role === "tool" && Array.isArray(m.results)) for (const x of m.results) if (x && x.id === id) return String(x.content || "");
        return "";
      };
      const statuses = events.filter((e) => e.type === "status").map((e) => String(e.text || ""));
      return { llm, events, asked, stats, ws, r, err, h, toolText, statuses };
    };

    // 探一下接没接线：带 form 的 ask_user 回来的是不是表单那套话
    const probe = await run({ script: [FORM("tc_p", "promo-video"), END] });
    const agentWired = /用户在开头表单里定好了/.test(probe.toolText("tc_p"));
    if (wired(agentWired, "agent.js 的 ask_user 还不认 form（WIRING A/B：recipes.askForm 接进 runToolCall）")) {
      // A 桌面版：弹多项表单 → 答案钉进系统提示词、写进任务目录 → 后面再问同一个岔路被挡，擦边的照问
      const A = await run({
        script: [
          FORM("tc_f", "promo-video", { product: "云朵枕", duration: "15" }),
          call("tc_g1", "ask_user", { question: "成片要横版还是竖版？", options: [{ label: "横版 16:9", detail: "电脑上看" }, { label: "竖版 9:16", detail: "手机上刷" }] }),
          call("tc_g2", "ask_user", { question: "封面上放哪句话？", options: [{ label: "痛点", detail: "戳痛点" }, { label: "结果", detail: "给结果" }] }),
          END,
        ],
        answer: (q, n) => (n === 1 ? JSON.stringify({ form: "promo-video", values: { product: "云朵枕", duration: "15", aspects: ["9:16"], platforms: ["抖音", "小红书"] } }) : "痛点"),
      });
      eq(A.err, null, "任务没报错", A.err && A.err.message);
      eq(A.asked.length, 2, "★只弹了两次★ 开头表单一次 + 擦边的「封面上放哪句话」一次；「横版还是竖版」没弹");
      ok(A.asked[0] && Array.isArray(A.asked[0].fields) && A.asked[0].fields.length === 8, "  └ 第一问带着 8 个字段交给回答通道（桌面画成多项表单）");
      eq(A.asked[1] && A.asked[1].question, "封面上放哪句话？", "  └ 第二问是擦边的那句，照常问");
      const ev = A.events.find((e) => e.type === "ask_user" && Array.isArray(e.fields));
      ok(ev && ev.form === "promo-video" && /^画面和封面不花钱$/.test(ev.estimate) && /150 步/.test(ev.limits_note) && ev.timeout_ms === 30000, "界面收到的 ask_user 事件带表单、预估费用、上限说明、倒计时", ev && { form: ev.form, estimate: ev.estimate, limits: ev.limits_note });
      ok(ev && ev.fields.find((x) => x.name === "product").default === "云朵枕" && ev.fields.find((x) => x.name === "duration").default === "15", "  └ 模型从原话里摘的产品、时长已经预填在表单上");
      const t = A.toolText("tc_f");
      ok(/^用户在开头表单里定好了/.test(t), "模型拿到的是「定好了，照做」", t.slice(0, 200));
      for (const line of ["产品：云朵枕", "时长：15 秒", "画幅：竖版 9:16", "发哪些平台：抖音、小红书", "声音：只要字幕+音乐"]) ok(t.includes(`- ${line}`), `  └ ${line}`);
      ok(/预估生成费：画面和封面不花钱/.test(t) && /自动放宽到 150 步 \/ 60 分钟/.test(t), "  └ 带着预估费用和上限");
      const ans = A.events.find((e) => e.type === "ask_answer" && Array.isArray(e.summary));
      ok(ans && ans.summary.includes("画幅：竖版 9:16") && typeof ans.estimate === "string", "ask_answer 事件带一行一项的摘要和按答案重算的预估，卡片据此定格");
      ok(A.llm.seen[1] && A.llm.seen[1].system.includes("## 本次配方：产品宣传片 30 秒") && A.llm.seen[1].system.includes("- 画幅：竖版 9:16"), "★答案钉进系统提示词★ 填完之后每一步都看得见，压缩压不到");
      ok(!A.llm.seen[0].system.includes("## 本次配方"), "  └ 填之前没有这一段（反向对照）");
      ok(/开头表单里已经定了「画幅：竖版 9:16」/.test(A.toolText("tc_g1")), "★再问「横版还是竖版」被挡回去★ 拿到的是表单上的答案", A.toolText("tc_g1"));
      ok(!/开头表单里已经定了/.test(A.toolText("tc_g2")) && /痛点/.test(A.toolText("tc_g2")), "  └ 擦边的「封面上放哪句话」照常问、拿到用户的回答", A.toolText("tc_g2"));
      eq(A.stats.recipe && A.stats.recipe.id, "promo-video", "stats.recipe 记着这张表（整棵任务树共享，专家子任务也看得见）");
      ok(A.stats.asks && A.stats.asks[0] && A.stats.asks[0].q === "开头表单：产品宣传片 30 秒", "  └ 算这一轮的头一问（ask-gate 据此判后面的问）");
      let saved = null;
      try { saved = JSON.parse(fs.readFileSync(path.join(A.ws, "任务1", R.FORM_FILE), "utf8")); } catch {}
      ok(saved && saved.id === "promo-video" && JSON.stringify(saved.values.aspects) === '["9:16"]', `答案写进 <任务目录>/${R.FORM_FILE}，续跑时读回来`, saved);

      // B 续跑：技能还挂着 → 从任务目录读回表单；技能没挂 / 换了目录 → 不绑
      const resumeHist = (withSkill) => [
        { role: "user", content: "给我们的新品云朵枕做条宣传片" },
        ...(withSkill ? [
          { role: "assistant", text: "", toolCalls: [{ id: "u1", name: "use_skill", input: { name: "promo-video" } }] },
          { role: "tool", results: [{ id: "u1", content: "已加载技能「promo-video」" }] },
        ] : []),
        { role: "assistant", text: "做好脚本了。", toolCalls: [] },
        { role: "user", content: "接着做成片" },
      ];
      const B = await run({ script: [END], dir: A.ws, history: resumeHist(true) });
      ok(B.llm.seen[0] && B.llm.seen[0].system.includes("## 本次配方：产品宣传片 30 秒") && B.llm.seen[0].system.includes("- 画幅：竖版 9:16"), "★续跑第一步就带着表单★ 从任务目录读回来的，不用再问");
      const B2 = await run({ script: [END], dir: A.ws, history: resumeHist(false) });
      ok(B2.llm.seen[0] && !B2.llm.seen[0].system.includes("## 本次配方"), "  └ 反向：同一个目录、技能没挂着 → 不绑这张旧表单（在这个目录里做别的事）");
      const B3 = await run({ script: [END], dir: A.ws, baseDir: "任务2", history: resumeHist(true) });
      ok(B3.llm.seen[0] && !B3.llm.seen[0].system.includes("## 本次配方"), "  └ 反向：换了任务目录 → 没有表单可读");

      // C 同一趟里再调一次：不再弹
      const C = await run({ script: [FORM("tc_1", "promo-video"), FORM("tc_2", "promo-video"), END] });
      eq(C.asked.length, 1, "同一趟里模型又带 form 调了一次 → 不再弹");
      ok(/^表单已经填过了，照这个做，别再问/.test(C.toolText("tc_2")), "  └ 把填过的答案还给它", C.toolText("tc_2").slice(0, 80));

      // D 命令行 / IM 预设：消息里带着【配方表单已填】→ 开跑前就钉住，form 调用直接返回
      const D = await run({
        script: [FORM("tc_x", "xhs-carousel"), END],
        history: [{ role: "user", content: '【使用技能：xhs-carousel】【配方表单已填：xhs-carousel】{"topic":"新手露营","count":"9","style":"dark"}\n照技能第 1 步定选题角度' }],
      });
      ok(D.llm.seen[0] && D.llm.seen[0].system.includes("## 本次配方：小红书图文 6–9 张") && D.llm.seen[0].system.includes("- 张数：9 张") && D.llm.seen[0].system.includes("- 风格：深色质感"), "命令行预填的表单 → 第一步就钉在系统提示词里");
      eq(D.asked.length, 0, "  └ 模型照说明书调表单 → 一次都不弹");
      ok(/^表单已经填过了/.test(D.toolText("tc_x")), "  └ 直接拿到预填的答案");
      // D2 同一个会话里，流程那一步做完了改问别的事 → 老预填不钉；只回一句「继续」→ 还是那件事，照钉
      const stepMsg = { role: "user", content: '【使用技能：xhs-carousel】【配方表单已填：xhs-carousel】{"topic":"新手露营","count":"9","style":"dark"}\n照技能第 1 步定选题角度' };
      const D2 = await run({ script: [END], history: [stepMsg, { role: "assistant", text: "选题角度定好了。", toolCalls: [] }, { role: "user", content: "帮我写封邮件，约客户下周二开会" }] });
      ok(D2.llm.seen[0] && !D2.llm.seen[0].system.includes("## 本次配方") && !D2.stats.recipe, "★改问别的事 → 老步骤里的预填不钉★ 写邮件不会被说成在做小红书图文");
      // 前面已经挂着别的技能（点名加载那道闸就不再替这一步挂 xhs-carousel），认预填只能靠「这一轮要做的是哪条」
      const D3 = await run({ script: [END], history: [
        { role: "user", content: "先做条宣传片" },
        { role: "assistant", text: "", toolCalls: [{ id: "u9", name: "use_skill", input: { name: "promo-video" } }] },
        { role: "tool", results: [{ id: "u9", content: "已加载技能「promo-video」" }] },
        { role: "assistant", text: "宣传片做好了。", toolCalls: [] },
        stepMsg, { role: "assistant", text: "第 1 步中途断了。", toolCalls: [] }, { role: "user", content: "继续" },
      ] });
      ok(D3.llm.seen[0] && D3.llm.seen[0].system.includes("## 本次配方：小红书图文 6–9 张"), "  └ 只回一句「继续」→ 还是那一步，预填照钉（别的技能挂着也一样）");

      // E 无人值守（IM、定时任务）：不等，按默认开工，记成假设
      const E = await run({ script: [FORM("tc_u", "multi-post"), END], answer: null, history: [{ role: "user", content: "把稿子.docx 改成各平台版本" }] });
      ok(/无人值守/.test(E.toolText("tc_u")) && /assumptions/.test(E.toolText("tc_u")), "无人值守 → 按默认开工，替用户定的写进交付清单 assumptions", E.toolText("tc_u").slice(-120));
      ok(!E.events.some((e) => e.type === "ask_user"), "  └ 没有弹任何东西");
      ok(E.stats.asks && E.stats.asks[0] && E.stats.asks[0].skipped === true, "  └ 记成「跳过了的一问」");
      ok(E.stats.recipe && E.stats.recipe.id === "multi-post", "  └ 默认值照样钉住");

      // F 超时：等满了没人填
      const F = await run({ script: [FORM("tc_t", "promo-video"), END], answer: () => null });
      ok(/秒没人填，按默认值开工/.test(F.toolText("tc_t")), "超时没人填 → 按默认开工，写明等了多久", F.toolText("tc_t").slice(-80));
      ok(F.events.some((e) => e.type === "ask_answer" && e.timeout === true), "  └ 卡片收到 timeout，定格成「没人填，按默认开工」");

      // G 上限：默认 3 步做不完的活，填完表单自动放宽；用户明确限过的一步不改
      const limitScript = (first) => [first, TODO(1), TODO(2), TODO(3), END];
      const reached = (x, i) => x.events.some((e) => e.type === "todos" && JSON.stringify(e.items || []).includes(`第 ${i} 步的产出`));
      const G = await run({ script: limitScript(FORM("tc_l", "promo-video")), agent: { max_steps: 3 } });
      ok(G.statuses.some((s) => s === "按配方把上限放宽到 150 步 / 60 分钟"), "★上限按配方放宽★ 界面上说了一声", G.statuses);
      ok(reached(G, 3) && G.r && /写完了/.test(G.r.finalText || ""), "  └ 设置里 3 步的上限，照样做到了第 4 步以后", G.r && G.r.stopped);
      const G0 = await run({ script: limitScript(PLAIN("tc_p0")), agent: { max_steps: 3 } });
      ok(!reached(G0, 3) && G0.r && /最大步数/.test(G0.r.stopped || ""), "  └ 反向：不走表单的同一段脚本，3 步就被掐了", G0.r && G0.r.stopped);
      const GL = await run({ script: limitScript(FORM("tc_l2", "promo-video")), agent: { max_steps: 30 }, maxSteps: 3 });
      ok(GL.statuses.some((s) => /^你这次限了 3 步，配方建议 150 步，没改/.test(s)), "用户明确限了 3 步（--max-steps）→ 一步不改，只说一声", GL.statuses);
      ok(!reached(GL, 3), "  └ 真的停在 3 步");

      // H 专家团 / 单独委派：表单在子任务里填（或委派方先填），放宽的上限和等人的时间要带给后面的同事和委派方
      const crew = [{ name: "导演A", system: "ROLE_A 你是导演", skills: [] }, { name: "成员B", system: "ROLE_B 你是成员", skills: [] }];
      const TD = (who, i) => call(`td_${who}_${i}`, "todo_write", { todos: [{ content: `${who} 第 ${i} 步`, status: "in_progress" }] });
      const say = (text) => ({ ...END, text });
      const TEAM = call("tc_crew", "delegate_to_team", { team: "测试团", task: "做条宣传片" });
      const late = (ms, v) => () => new Promise((res) => setTimeout(() => res(v), ms));
      const relay = async ({ agent, P = [TEAM], A = [], answer = () => R.FALLBACK_GO, maxSteps }) => {
        const scripts = { P: [...P, say("父级收尾")], A: [...A, TD("A", 1), TD("A", 2), TD("A", 3), say("A 做完了")], B: [TD("B", 1), TD("B", 2), TD("B", 3), TD("B", 4), say("B 做完了")] };
        const cnt = { P: 0, A: 0, B: 0 };
        const llm = { provider: "假", model: "假模型", chat: async ({ system }) => {
          const s = String(system || ""), who = s.includes("ROLE_A") ? "A" : s.includes("ROLE_B") ? "B" : "P";
          return scripts[who][Math.min(cnt[who]++, scripts[who].length - 1)];
        } };
        const events = [], h = [{ role: "user", content: "给新品做条宣传片" }];
        const rt = createAgentRuntime({ config: cfgOf(agent), llm, mcpManager: new McpManager(), experts: crew, expertTeams: [{ name: "测试团", members: ["导演A", "成员B"] }] });
        const r = await tools.withWorkspace(tmp(), () => rt.runTask({ history: h, baseDir: "任务1", stats: freshStats(), emit: (e) => events.push(e), askUser: async (q) => answer(q), ...(maxSteps ? { maxSteps } : {}) }));
        let out = "";
        for (const m of h) if (m && m.role === "tool" && Array.isArray(m.results)) for (const x of m.results) if (x && x.id === "tc_crew") out = String(x.content || "");
        const bDid = (i) => events.some((e) => e.type === "todos" && e.expert === "成员B" && JSON.stringify(e.items || []).includes(`B 第 ${i} 步`));
        return { r, out, bDid };
      };
      const H = await relay({ agent: { max_steps: 3 }, A: [FORM("tc_fa", "promo-video")] });
      ok(H.bDid(4) && /B 做完了/.test(H.out), "★第一棒填的表，放宽的步数第二棒也有★ 设置里 3 步，成员B 照样做完第 4 步", H.out.slice(-160));
      const H0 = await relay({ agent: { max_steps: 3 } });
      ok(!H0.bDid(4) && !/B 做完了/.test(H0.out), "  └ 反向：没人填表的同一队，成员B 3 步就被掐了", H0.out.slice(-160));
      const HP = await relay({ agent: { max_steps: 3 }, P: [FORM("tc_fp", "promo-video"), TEAM] });
      ok(HP.bDid(4) && /B 做完了/.test(HP.out), "  └ 委派方自己先填的表，派出去的成员也按放宽后的步数做", HP.out.slice(-160));
      const HL = await relay({ agent: { max_steps: 3 }, P: [FORM("tc_fl", "promo-video"), TEAM], maxSteps: 3 });
      ok(!HL.bDid(4), "  └ 用户明确限了步数（--max-steps）→ 派出去的成员也不放宽步数", HL.out.slice(-160));
      const H2 = await relay({ agent: { max_runtime_ms: 1000 }, A: [FORM("tc_fb", "promo-video")], answer: late(2000, R.FALLBACK_GO) });
      ok(!/未执行：全队已达最大运行时间/.test(H2.out) && /B 做完了/.test(H2.out), "★第一棒等表单的 2 秒顺延给第二棒★ 总时长 1 秒也没把成员B 挡在门外", H2.out.slice(-160));
      ok(H2.r && !/最大运行时间/.test(H2.r.stopped || "") && /父级收尾/.test(H2.r.finalText || ""), "  └ 委派方跟着顺延，全队交差后没撞时限", H2.r && H2.r.stopped);
      const H3 = await relay({ agent: { max_runtime_ms: 1000 }, P: [call("tc_crew", "delegate_to_expert", { expert: "导演A", task: "做条宣传片" })], A: [PLAIN("tc_pa")], answer: late(2000, "开头") });
      ok(/A 做完了/.test(H3.out) && H3.r && !/最大运行时间/.test(H3.r.stopped || "") && /父级收尾/.test(H3.r.finalText || ""), "★单独委派的专家等用户回答 2 秒，委派方的时限也顺延★ 专家交差后没立刻撞时限", H3.r && H3.r.stopped);
    }
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n④ askForm / applyLimits / restore / pinBlock 的边角");
  {
    const emitted = [];
    const emit = (e) => emitted.push(e);
    let r = await R.askForm({ form: "nope" }, { emit });
    ok(r.isError && /没有叫「nope」的配方/.test(r.content) && /promo-video \/ xhs-carousel \/ multi-post/.test(r.content), "不认识的配方 → 报错，列出能用的", r.content);
    eq(emitted.length, 0, "  └ 什么都没弹");

    // 命令行两个按钮：点「改几项再开工」→ 追问一句改哪几项
    const answers = [R.FALLBACK_EDIT, "时长 15 秒，只要竖版"];
    const qs = [];
    const stats = {};
    const save = tmp();
    r = await R.askForm({ question: "开工前定一下", form: "promo-video" }, {
      emit, stats, saveDir: save, config: { agent: { ask_user_timeout_ms: 1000 } },
      askUser: async (q) => { qs.push(q); return answers.shift(); },
    });
    eq(qs.length, 2, "命令行点了「改几项再开工」→ 追问一句");
    eq(qs[0].options.map((o) => o.label), [R.FALLBACK_GO, R.FALLBACK_EDIT], "  └ 第一问是两个按钮：按默认开工 / 改几项再开工");
    ok(qs[0].options[0].detail.includes("时长：30 秒；画幅：竖版 9:16、横版 16:9"), "  └ 「按默认开工」下面写着默认是什么", qs[0].options[0].detail);
    eq(qs[0].timeoutMs, 30000, "  └ 等待至少 30 秒（设置里填太短也不会一闪而过）");
    ok(/^改哪几项？/.test(qs[1].question) && !qs[1].fields, "  └ 第二问是一句话的追问，不带表单");
    ok(["- 时长：15 秒", "- 画幅：竖版 9:16", "- 用户补充：时长 15 秒，只要竖版"].every((l) => r.content.includes(l)), "  └ 那句话里能对上的改了，整句钉成补充", r.content);
    eq(emitted.filter((e) => e.type === "ask_user").length, 2, "  └ 界面上也是两张卡");
    ok(emitted.filter((e) => e.type === "ask_answer").length === 2, "  └ 两张都有定格");
    ok(!emitted.some((e) => e.fields && e.fields.some((f) => "covers" in f)), "  └ 发给界面的字段里不带岔路正则");
    let file = null;
    try { file = JSON.parse(fs.readFileSync(path.join(save, R.FORM_FILE), "utf8")); } catch {}
    ok(file && file.v === 1 && file.id === "promo-video" && file.values.duration === "15", `写进 ${R.FORM_FILE}`, file);
    ok(stats.asks.length === 1 && stats.recipe.values.duration === "15", "stats 上记了一问、钉了表单");
    eq(r.raiseLimits, { max_steps: 150, max_runtime_min: 60 }, "返回 raiseLimits，交给 agent 放宽上限");

    r = await R.askForm({ form: "promo-video" }, { stats, askUser: async () => { throw new Error("不该再弹"); } });
    ok(/^表单已经填过了/.test(r.content) && r.raiseLimits, "同一棵任务树里再调 → 不弹，把答案还回去，上限照样放宽");

    // 上一轮是专家在子任务里填的表：这一轮 stats 是空的，任务目录里那份还在 → 照它，不再弹、不拿默认值盖掉
    const prevDir = tmp();
    const prevFile = path.join(prevDir, R.FORM_FILE);
    fs.writeFileSync(prevFile, JSON.stringify({ v: 1, id: "promo-video", title: "产品宣传片 30 秒", values: { product: "云朵枕", duration: "15", aspects: ["9:16"] }, notes: ["用户补充：只要竖版"], at: "2026-09-01T00:00:00.000Z" }));
    const prevRaw = fs.readFileSync(prevFile, "utf8");
    const st6 = {}, ev6 = [];
    r = await R.askForm({ form: "promo-video" }, { stats: st6, saveDir: prevDir, emit: (e) => ev6.push(e), askUser: async () => R.FALLBACK_GO });
    ok(/^表单上一轮已经填过了/.test(r.content) && ["- 产品：云朵枕", "- 时长：15 秒", "- 画幅：竖版 9:16", "- 用户补充：只要竖版"].every((l) => r.content.includes(l)) && r.raiseLimits, "上一轮专家填过表（任务目录里有）→ 不弹，把那份还回去，上限照样放宽", r.content);
    ok(/以这一轮说的为准/.test(r.content), "  └ 说清楚：这一轮用户说的跟表单冲突时以这一轮为准");
    ok(st6.recipe && st6.recipe.values.product === "云朵枕" && st6.recipe.from === "file", "  └ 钉回 stats（后面每一步的系统提示词里都有）");
    eq([ev6.filter((e) => e.type === "ask_user").length, fs.readFileSync(prevFile, "utf8") === prevRaw], [0, true], "  └ 没弹卡，文件原样（没被默认值盖掉）");
    const st7 = {}, q7 = [];
    r = await R.askForm({ form: "multi-post" }, { stats: st7, saveDir: prevDir, askUser: async (q) => { q7.push(q); return R.FALLBACK_GO; } });
    ok(q7.length === 1 && /^用户在开头表单里定好了/.test(r.content), "  └ 反向：目录里那份是别的配方 → 照常弹", r.content.slice(0, 40));

    const blocker = path.join(tmp(), "是个文件");
    fs.writeFileSync(blocker, "x");
    r = await R.askForm({ form: "multi-post" }, { saveDir: path.join(blocker, "子目录") });
    ok(!r.isError && /表单没写进任务目录/.test(r.content), "任务目录写不进去 → 说一声，照样开工", r.content.slice(-80));
    r = await R.askForm({ form: "multi-post" }, { saveDir: "相对/路径" });
    ok(!r.isError && !fs.existsSync(path.join(process.cwd(), "相对")), "相对路径的目录不写（不往当前目录里乱放文件）");

    // 没人在（IM、定时任务不传 askUser）和表单超时：都按默认走，默认里不能有花钱的项
    const imgTts = mediaCfg(["image", "tts"]);
    for (const [how, ask] of [["无人值守", null], ["表单超时", async () => null]]) {
      const st = {};
      const got = await R.askForm({ form: "xhs-carousel" }, { stats: st, askUser: ask, config: imgTts, hasRenderer: false });
      ok(st.recipe && st.recipe.values.render === "" && got.content.includes("预估生成费：画面和封面不花钱"), `${how}：截不了图、只配了生图 → 出图方式「这次不做」，不花钱`, st.recipe && st.recipe.values);
    }
    const stV = {};
    await R.askForm({ form: "promo-video" }, { stats: stV, config: imgTts, hasRenderer: false });
    eq([stV.recipe.values.voice, stV.recipe.values.cover], ["music", ""], "无人值守的宣传片：不配音、封面不做（都要花钱，没人点头）");

    // applyLimits：只抬不降，有顶，锁了步数不动，截止时间按多给的那段往后挪
    const D0 = 1_000_000;
    let L = R.applyLimits({ maxSteps: 25, runtimeMs: 1800000, deadline: D0 }, { max_steps: 150, max_runtime_min: 60 });
    eq([L.maxSteps, L.runtimeMs, L.deadline, L.note], [150, 3600000, D0 + 1800000, "按配方把上限放宽到 150 步 / 60 分钟"], "25 步 / 30 分钟 → 150 步 / 60 分钟，截止往后挪 30 分钟（跑掉的不退）");
    L = R.applyLimits({ maxSteps: 4, runtimeMs: 1800000, deadline: D0, locked: true }, { max_steps: 150, max_runtime_min: 60 });
    eq([L.maxSteps, L.runtimeMs, L.note], [4, 3600000, "你这次限了 4 步，配方建议 150 步，没改；时长上限 60 分钟"], "--max-steps 限过 → 步数不动，时长照放");
    L = R.applyLimits({ maxSteps: 300, runtimeMs: 7200000, deadline: D0 }, { max_steps: 150, max_runtime_min: 60 });
    eq([L.maxSteps, L.runtimeMs, L.deadline, L.note], [300, 7200000, D0, "上限够用（300 步 / 120 分钟），没动"], "设置里本来就更宽 → 不降");
    L = R.applyLimits({ maxSteps: 25, runtimeMs: 1800000, deadline: D0 }, { max_steps: 99999, max_runtime_min: 99999 });
    eq([L.maxSteps, L.runtimeMs], [500, 180 * 60000], "配方要得再多也封顶 500 步 / 180 分钟");
    const t0 = Date.now();
    L = R.applyLimits({ maxSteps: 25, runtimeMs: 60000, deadline: 0 }, { max_steps: 30, max_runtime_min: 2 });
    ok(L.deadline >= t0 + 120000 && L.deadline <= Date.now() + 120000, "没有截止时间 → 从现在按新上限算");

    // pinBlock：有长度上限、压缩也在
    eq(R.pinBlock(null), "", "没表单 → 不加任何东西");
    const big = { id: "promo-video", title: "", values: { ...R.defaultValues(R.get("promo-video")), product: "长".repeat(60), points: "卖".repeat(120) }, notes: Array.from({ length: 12 }, (_, i) => `用户补充：${"很长的一句话".repeat(20)}${i}`), at: "" };
    const pb = R.pinBlock(big);
    ok(pb.length <= 800 && pb.startsWith("\n\n## 本次配方：产品宣传片 30 秒") && /delivery_page/.test(pb), "钉进提示词的一段 ≤800 字，头尾都在（截的是中间）", pb.length);

    // restore：预填优先，文件只认技能还挂着的
    const dir = tmp();
    fs.writeFileSync(path.join(dir, R.FORM_FILE), JSON.stringify({ v: 1, id: "promo-video", values: { aspects: ["4:3"], duration: "60", cover: "" }, notes: ["用户补充：只要竖版"] }));
    let pin = R.restore({ history: [], dir, loaded: ["promo-video"] });
    ok(pin && pin.from === "file" && pin.values.duration === "60", "任务目录里的表单 + 技能挂着 → 读回来");
    eq(pin && pin.values.aspects, ["9:16", "16:9"], "  └ 文件里不认识的值（4:3）退默认");
    eq(pin && pin.values.cover, "", "  └ 当时一条都用不了而留空的单选，读回来还是空（不凭空变出默认）");
    eq(R.restore({ history: [], dir, loaded: [] }), null, "技能没挂着 → 不读");
    const preset = [{ role: "user", content: '【配方表单已填：multi-post】{"source":"稿子.docx","platforms":["知乎"]}\n改写' }];
    pin = R.restore({ history: preset, dir, loaded: ["promo-video"] });
    ok(pin && pin.id === "multi-post" && pin.from === "preset" && JSON.stringify(pin.values.platforms) === '["知乎"]', "历史里有预填 → 预填优先于文件");
    eq(R.restore({ history: [{ role: "user", content: "【配方表单已填：promo-video】{\n}" }] }), null, "预填的 JSON 折了行 → 不认（PRESET_RE 只认一行）");
    fs.writeFileSync(path.join(dir, R.FORM_FILE), "{坏了");
    eq(R.restore({ dir, loaded: ["promo-video"] }), null, "文件坏了 → null，不抛");
    // 命令行流程跑完（或中途失败）后，同一个会话里改问别的事：老步骤消息里的预填不能把配方钉到这件新事上
    const step = '【使用技能：promo-video】【配方表单已填：promo-video】{"product":"云朵枕","duration":"15"}\n照技能第 1 步写脚本';
    const later = [{ role: "user", content: step }, { role: "assistant", text: "脚本写好了。", toolCalls: [] }, { role: "user", content: "帮我写封邮件，约客户下周二开会" }];
    eq(R.restore({ history: later, loaded: [] }), null, "★旧预填不串到新事上★ 这一轮问的是别的、技能也没挂着 → 不绑");
    pin = R.restore({ history: later, loaded: ["promo-video"] });
    ok(pin && pin.id === "promo-video" && pin.from === "preset", "  └ 技能还挂着（接着做同一件事）→ 旧预填照认");
    pin = R.restore({ history: later, loaded: [], ask: step });
    ok(pin && pin.id === "promo-video" && pin.values.duration === "15", "  └ 这一轮要做的就是那条带预填的步骤（ask 传进来）→ 认");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑤ 前端表单卡：在假 DOM 里点一遍，交回去的 JSON 服务端能原样收");
  {
    const file = path.join(ROOT, "public", "js", "app-08-recipe.js");
    const src = fs.readFileSync(file, "utf8");
    let compiled = true;
    try { new vm.Script(src, { filename: file }); } catch { compiled = false; }
    ok(compiled, "app-08-recipe.js 语法过得了");
    ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(src), "前端文件里没有 emoji（注释也算）");
    const sprite = read("public/index.html");
    // ic(x ? "clock" : "circle-check") 这种三元也得捞到：括号里每个带引号的名字都算
    const icons = [...new Set([...src.matchAll(/\bic\(([^()]*)\)/g)].flatMap((m) => [...m[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1])))];
    eq(icons.filter((n) => !sprite.includes(`<symbol id="i-${n}"`)), [], `用到的图标（${icons.join("、")}）在图标表里都有`);
    ok(src.includes(`const RECIPE_GO_DEFAULT = "${R.FALLBACK_GO}";`), "「都按默认」交回去的那句跟服务端认的一字不差");

    const dom = fakeDom();
    const sent = [], toasts = [], timers = [];
    const ctx = {
      document: dom.document, console, toast: (m) => toasts.push(m), isReplaying: false,
      esc: (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
      ic: (name, cls) => `<svg class="i${cls ? " " + cls : ""}" aria-hidden="true"><use href="#i-${name}"></use></svg>`,
      setInterval: (fn) => { timers.push(fn); return timers.length; }, clearInterval: () => {},
      fetch: async () => ({ ok: false, json: async () => ({ error: "任务已经结束了" }) }),
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: file });
    ok(typeof ctx.makeRecipeFormCard === "function", "全局有 makeRecipeFormCard（app-01 的 makeAskCard 转到它）");

    // 事件就用 askForm 真发出来的那条：服务端和前端的字段形状对不上，这里就红
    const evs = [];
    await R.askForm({ form: "promo-video", defaults: { product: "云朵枕" } }, { emit: (e) => evs.push(e), askUser: async () => R.FALLBACK_GO, hasRenderer: true, config: {} });
    const ev = { ...evs.find((e) => e.type === "ask_user" && e.fields), title: '宣传片<img src=x onerror="alert(1)">' };
    const form = R.formFor("promo-video", { config: {}, hasRenderer: true, defaults: { product: "云朵枕" } });
    const flush = () => new Promise((res) => setImmediate(res));
    const mk = (e, submit, c) => ctx.makeRecipeFormCard(e, "sid-1", submit, c);
    const card = mk(ev, async (a) => { sent.push(a); return { ok: true }; });
    const $ = (sel) => card.querySelector(sel);
    const $$ = (sel) => card.querySelectorAll(sel);
    ok(card.classList.contains("ask-card") && card.classList.contains("ask-form") && card.dataset.askId === ev.ask_id, "同一个壳：.ask-card.ask-form，带 data-ask-id（ask_answer 靠它找卡）");
    eq($$(".rf-row").length, 8, "8 项一项一行");
    eq($(".ask-q").textContent, ev.title, "标题原样当文字显示（尖括号没变成标签）");
    eq($$("img").length, 0, "  └ 卡片里没有被注入出一个 img");
    ok(/预估生成费：画面和封面不花钱/.test($(".rf-top").textContent) && /最多 150 步、60 分钟/.test($(".rf-top").textContent), "顶上写着预估费用和上限");
    ok(!$(".rf-notes") && ev.notes.length === 0, "一项默认都没挪（声音默认就是不花钱的那条）→ 卡片上不摆说明", ev.notes);
    const tts = $('.rf-row[data-field="voice"] .rf-opt[data-v="tts"]');
    ok(tts && tts.disabled && tts.classList.contains("off") && /语音合成还没配/.test(tts.title + tts.textContent), "用不了的选项照样摆出来、标灰、写明去哪儿补");
    tts.click();
    ok($('.rf-row[data-field="voice"] .rf-opt[data-v="music"]').classList.contains("on"), "  └ 点标灰的没反应，还是「只要字幕+音乐」");
    eq($('.rf-row[data-field="product"] .rf-text').value, "云朵枕", "模型摘的产品名已经填在框里");
    const inp = $('.rf-row[data-field="points"] .rf-text');
    inp.value = "  透气不闷  "; inp.oninput();
    $('.rf-row[data-field="duration"] .rf-opt[data-v="15"]').click();
    const chip = (v) => $(`.rf-row[data-field="aspects"] .rf-chip[data-v="${v}"]`);
    chip("1:1").click(); chip("16:9").click(); chip("9:16").click();
    chip("1:1").click();
    eq($(".rf-err").textContent, "画幅至少留一个", "多选点到只剩一个再点 → 不让清空，说一声");
    ok(chip("1:1").classList.contains("on") && chip("1:1").getAttribute("aria-pressed") === "true", "  └ 那一个还选着");
    chip("9:16").click();
    $('.rf-row[data-field="platforms"] .rf-chip[data-v="小红书"]').click();
    $(".rf-go").click();
    await flush();
    eq(sent.length, 1, "点「按这样开工」→ 交一次");
    let got = null;
    try { got = JSON.parse(sent[0]); } catch {}
    eq(got && got.form, "promo-video", "  └ 交的是 {form, values} 一行 JSON");
    eq(got && got.values.aspects, ["9:16", "1:1"], "  └ 多选按选项顺序排，不按点的先后");
    eq(got && got.values.points, "透气不闷", "  └ 文本去掉首尾空白");
    const back = R.parseAnswer(form, sent[0]);
    eq(back.notes, [], "★服务端原样收下★ 一条「用不了」都没有");
    eq([back.values.duration, back.values.voice, back.values.cover, back.values.platforms], ["15", "music", "html", ["抖音", "视频号", "小红书"]], "  └ 时长、声音、封面、平台都对得上");
    ok(card.classList.contains("done") && $(".rf-fields").hidden && $(".rf-acts").hidden, "交完表单收起来，只留结论");
    eq($(".ask-lb").textContent, "开工前的几件事定好了", "  └ 标题换成「定好了」");
    ok(/时长：15 秒/.test($(".ask-ans").textContent) && /画幅：竖版 9:16、方版 1:1/.test($(".ask-ans").textContent), "  └ 结论一项一行（服务端摘要没到之前先按自己的值拼）");
    $(".rf-go").click(); await flush();
    eq(sent.length, 1, "  └ 交过了再点不会重复交");
    // 交表的回执先到、卡片已经定格；服务端的 ask_answer 后到，带着摘要和按答案重算的预估 → 得再画一遍
    ok(!$(".rf-top .rf-est").hidden, "  └ （对照）回执先到时顶上还挂着按默认值算的预估");
    card._mark(sent[0], false, ["时长：15 秒", "画幅：竖版 9:16、方版 1:1", "声音：配音+字幕"], "单价未知：语音合成约 135 字");
    ok($(".rf-top .rf-est").hidden && /单价未知：语音合成约 135 字/.test($(".ask-ans").textContent) && /声音：配音\+字幕/.test($(".ask-ans").textContent),
      "★回执先到、ask_answer 后到★ 照样换成服务端摘要和重算的预估，顶上那份按默认算的藏起来", $(".ask-ans").textContent);
    card._mark(sent[0], false);
    ok(/单价未知：语音合成约 135 字/.test($(".ask-ans").textContent), "  └ 之后再来一次不带摘要的定格 → 不退回去");

    // 服务端的 ask_answer 到了：用服务端的摘要和按答案重算的预估
    const c2 = mk(ev, async (a) => { sent.push(a); return { ok: true }; });
    c2._mark(R.FALLBACK_GO, false, ["时长：30 秒", "画幅：竖版 9:16、横版 16:9"], "单价未知：生成图片 3 张");
    ok(/单价未知：生成图片 3 张/.test(c2.querySelector(".ask-ans").textContent) && c2.querySelector(".rf-top .rf-est").hidden, "定格时用服务端摘要和重算的预估，顶上那份按默认算的藏起来");
    ok(!/你补充了/.test(c2.querySelector(".ask-ans").textContent), "  └ 「按默认开工」不当成补充");
    const c3 = mk(ev, async (a) => { sent.push(a); return { ok: true }; });
    c3.querySelector(".rf-def").click(); await flush();
    eq(sent[sent.length - 1], R.FALLBACK_GO, "点「都按默认」→ 交的是「按默认开工」");
    const c4 = mk(ev, null);
    c4._mark(null, true);
    eq(c4.querySelector(".ask-lb").textContent, "没人填，按默认开工", "超时 → 「没人填，按默认开工」");
    const c5 = mk(ev, null);
    c5._mark("只要竖版，别放音乐", false);
    ok(/你补充了：只要竖版，别放音乐/.test(c5.querySelector(".ask-ans").textContent), "命令行那边敲的一句话 → 结论里写「你补充了」");
    const c6 = mk(ev, undefined);
    c6.querySelector(".rf-def").click(); await flush();
    ok(!c6.classList.contains("done") && toasts.includes("任务已经结束了"), "没送出去 → 不收起，提示原因（用户还能再点）", toasts);
    // 服务端没说原因（断网、502 回的不是 JSON）：只说查得到的，不替人猜「任务可能已经结束」
    const failWith = async (impl) => {
      ctx.fetch = impl;
      const n = toasts.length;
      const cf = mk(ev, undefined);
      cf.querySelector(".rf-def").click(); await flush();
      return { card: cf, said: toasts.slice(n) };
    };
    const offline = await failWith(async () => { throw new TypeError("Failed to fetch"); });
    eq(offline.said, ["没送出去：连不上服务器，再点一次"], "连不上服务器 → 照实说连不上，不猜原因");
    ok(!offline.card.classList.contains("done"), "  └ 卡片不收起，还能再点");
    const bad = await failWith(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("not json"); } }));
    eq(bad.said, ["没送出去（HTTP 502），再点一次"], "服务端回了错但没说原因 → 写状态码，不猜原因");
    ok(!toasts.some((m) => /可能/.test(m)), "  └ 任何一条失败提示里都没有「可能」", toasts);
    const I18N = require(path.join(ROOT, "public", "js", "i18n.js"));
    const cjk = (s) => /[㐀-鿿]/.test(String(s || ""));
    for (const m of [...offline.said, ...bad.said, "画幅至少留一个", "发哪些平台至少留一个"]) {
      const en = I18N.lookup(m, "en");
      ok(en && !cjk(en), `  └ 英文界面：「${m}」→ ${en || "（没翻）"}`);
    }
    eq(I18N.lookup("画幅至少留一个", "en"), "Aspect ratio: keep at least one", "  └ 多选「至少留一个」连字段名一起翻");
    // 桌面提醒的兜底句（题面是空的那种）是界面自己写的中文，英文界面也得翻
    for (const m of ["在等你回答：一个岔路", "在等你批准：危险操作"]) {
      const en = I18N.lookup(m, "en");
      ok(en && !cjk(en), `英文界面：提醒兜底句「${m}」→ ${en || "（没翻）"}`);
    }
    // 交完的摘要里「（没选）」「这次不做」「（没填）」得各占一个文字节点：界面翻译按整个节点查词，
    // 跟「画幅：」挤在一个节点里就查不到，英文界面里这三句一直是中文
    const textNodes = (el) => (el.nodeType === 3 ? [el] : el.childNodes.flatMap(textNodes));
    const sumTexts = (c) => textNodes(c.querySelector(".ask-ans .rf-sum")).map((n) => n.data);
    const FALLBACKS = { "（没选）": "(none picked)", "这次不做": "Skip this time", "（没填）": "(left blank)" };
    const emptyVals = { aspects: [], cover: "", points: "" };
    const cz = mk(ev, null);
    cz._mark(JSON.stringify({ form: "promo-video", values: emptyVals }), false);
    // 服务端的摘要是拼好的「标签：值」字符串：就用 recipes.summary 真拼出来的那份
    const cs = mk(ev, null);
    cs._mark(R.FALLBACK_GO, false, R.summary(form, { ...R.defaultValues(form), ...emptyVals }));
    for (const [who, c] of [["自己拼的摘要", cz], ["服务端给的摘要", cs]]) {
      const zh = sumTexts(c), en = zh.map((s) => I18N.tr(s, "en"));
      for (const [src, want] of Object.entries(FALLBACKS)) ok(zh.includes(src) && en.includes(want), `英文界面（${who}）：「${src}」→ ${want}`, zh);
      ok(/画幅：（没选）/.test(c.querySelector(".ask-ans").textContent) && /封面：这次不做/.test(c.querySelector(".ask-ans").textContent) && /主打卖点：（没填）/.test(c.querySelector(".ask-ans").textContent), "  └ 中文界面照旧读成「标签：值」");
    }
    // 反过来：用户自己敲的字不许被翻。值单独成了节点，整节点查词就查得到——有人在「主打卖点」里填了「默认」，
    // 英文界面会把它改成 Default。按真 i18n.js 的跳过规则（_skipEl：translate="no" / data-i18n-skip）走一遍祖先链
    const shownEn = (c) => textNodes(c.querySelector(".ask-ans .rf-sum")).map((n) => {
      for (let a = n.parent; a; a = a.parent) if (I18N._skipEl(a)) return n.data;
      return I18N.tr(n.data, "en");
    });
    const TYPED = "默认";
    ok(I18N.tr(TYPED, "en") !== TYPED, `（前提）「${TYPED}」在词典里（${I18N.tr(TYPED, "en")}），拿它当用户敲的字才测得出误翻`);
    const typedVals = { aspects: [], cover: "", points: TYPED };
    const ct = mk(ev, null);
    ct._mark(JSON.stringify({ form: "promo-video", values: typedVals }), false);
    const ctS = mk(ev, null);
    ctS._mark(R.FALLBACK_GO, false, R.summary(form, { ...R.defaultValues(form), ...typedVals }));
    const cf = mk(ev, null);
    cf._mark(TYPED, false); // 命令行那边敲的一句补充，恰好也是「默认」
    for (const [who, c] of [["自己拼的摘要", ct], ["服务端给的摘要", ctS], ["你补充了", cf]]) {
      const en = shownEn(c);
      ok(en.includes(TYPED) && !en.includes(I18N.tr(TYPED, "en")), `★英文界面（${who}）：用户敲的「${TYPED}」原样显示，不被换成 ${I18N.tr(TYPED, "en")}★`, en);
    }
    ok(shownEn(ct).includes("(none picked)") && shownEn(ctS).includes("Skip this time"), "  └ 同一张摘要里的兜底句照样翻成英文（只有敲的字不翻）", shownEn(ct));
    const tn = timers.length;
    const c7 = mk(ev, null, { replaying: true });
    ok(c7.classList.contains("done") && c7.querySelector(".rf-fields").hidden && timers.length === tn, "历史回放 → 不倒计时、不让点");
    c7._mark(R.FALLBACK_GO, false, ["时长：30 秒"]);
    ok(/时长：30 秒/.test(c7.querySelector(".ask-ans").textContent), "  └ 后面跟着的 ask_answer 照样画上结论");
    const c8 = mk(ev, async (a) => { sent.push(a); return { ok: true }; });
    const n8 = sent.length;
    c8.querySelector(".rf-text").onkeydown({ key: "Enter", isComposing: true, preventDefault() {} });
    await flush();
    eq(sent.length, n8, "输入法选字时的回车不交表");
    c8.querySelector(".rf-text").onkeydown({ key: "Enter", isComposing: false, preventDefault() {} });
    await flush();
    eq(sent.length, n8 + 1, "  └ 真回车才交");
    ok(/^\d+:\d\d 后按默认开工$/.test(card.querySelector(".ask-timer").textContent) || card.querySelector(".ask-timer").textContent === "", "倒计时写「M:SS 后按默认开工」，交完清空");
    const c9 = mk({ ...ev, timeout_ms: 90000 }, null);
    ok(/^1:30 后按默认开工$/.test(c9.querySelector(".ask-timer").textContent), "  └ 90 秒 → 「1:30 后按默认开工」", c9.querySelector(".ask-timer").textContent);

    // 截不了图、只配了生图：封面一条都不预选，说明写在卡片上；点上 AI 生图能交，再点一下退回「这次不做」
    const imgOnly = mediaCfg(["image"]);
    const evsP = [], sentP = [];
    await R.askForm({ form: "promo-video" }, { emit: (e) => evsP.push(e), askUser: async () => R.FALLBACK_GO, hasRenderer: false, config: imgOnly });
    const cp = mk(evsP.find((e) => e.type === "ask_user" && e.fields), async (a) => { sentP.push(a); return { ok: true }; });
    const cpOpt = (name, v) => cp.querySelector(`.rf-row[data-field="${name}"] .rf-opt[data-v="${v}"]`);
    ok(cp.querySelector(".rf-notes") && /「AI 生图」要花钱，没替你选/.test(cp.querySelector(".rf-notes").textContent), "只剩花钱的一条 → 卡片上写「要花钱，没替你选」");
    ok(!cpOpt("cover", "ai").disabled && !cpOpt("cover", "ai").classList.contains("on"), "  └ AI 生图能点，但没预先选上");
    cpOpt("cover", "ai").click();
    ok(cpOpt("cover", "ai").classList.contains("on"), "  └ 点一下选上");
    cpOpt("cover", "ai").click();
    ok(!cpOpt("cover", "ai").classList.contains("on"), "  └ 再点一下退回「这次不做」");
    cpOpt("duration", "15").click(); cpOpt("duration", "15").click();
    ok(cpOpt("duration", "15").classList.contains("on"), "  └ 默认不是空的单选（时长）再点一下还是选着");
    cp.querySelector(".rf-go").click(); await flush();
    const backP = R.parseAnswer(R.formFor("promo-video", { config: imgOnly, hasRenderer: false }), sentP[0]);
    eq([sentP.length, backP.values.cover, backP.notes.filter((n) => /封面/.test(n))], [1, "", []], "  └ 交回去服务端收成「这次不做」，不记「填的用不了」");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑥ 老用户升级：内置专家补绑新技能，用户删过、改过的不动");
  {
    const bundled = {
      experts: [
        { name: "A", builtin: true, skills: ["promo-video"] },
        { name: "B", builtin: true, skills: ["x", "y"] },
        { name: "N", builtin: true, skills: ["s"] },
        { name: "C", builtin: true, skills: ["c1"] },
      ],
      teams: [{ name: "T", members: ["A", "N"], description: "d" }],
    };
    const mine = {
      experts: [
        { name: "A", builtin: true, skills: [] },
        { name: "B", builtin: true, skills: ["x"] },
        { name: "C", skills: [] }, // 用户自建的同名专家（不是内置）
        { name: "我的", skills: ["z"] },
      ],
      teams: [],
    };
    let r = mergeBuiltinExperts(mine, JSON.parse(JSON.stringify(bundled)));
    eq(r, { added: ["N"], addedTeams: ["T"], bound: ["A:promo-video"] }, "老文件第一次升级：补新专家、新团，技能空着的内置专家补绑");
    eq(mine.experts.find((e) => e.name === "B").skills, ["x"], "  └ 用户自己配过技能的内置专家不碰");
    eq(mine.experts.find((e) => e.name === "C").skills, [], "  └ 用户自建的同名专家不碰");
    eq(mine.experts.find((e) => e.name === "我的").skills, ["z"], "  └ 用户自建的专家不碰");
    eq(mine.seen_builtin_skills, { A: ["promo-video"], B: ["x", "y"], N: ["s"], C: ["c1"] }, "  └ 包里这一版记成「见过」");
    mine.experts.find((e) => e.name === "A").skills = [];
    bundled.experts[0].skills = ["promo-video", "xhs-carousel"];
    r = mergeBuiltinExperts(mine, JSON.parse(JSON.stringify(bundled)));
    eq(r.bound, ["A:xhs-carousel"], "用户删掉的 promo-video 不塞回来，包里新出的 xhs-carousel 补上");
    eq(mine.experts.find((e) => e.name === "A").skills, ["xhs-carousel"], "  └ 手里那份就是这样");
    r = mergeBuiltinExperts(mine, JSON.parse(JSON.stringify(bundled)));
    eq(r, { added: [], addedTeams: [], bound: [] }, "再跑一次什么都不动（启动时不会每次都落盘）");
    eq(mergeBuiltinExperts({}, {}), { added: [], addedTeams: [], bound: [] }, "空的也不抛，三样都在");
    const meta = JSON.parse(read("experts.json") || "{}");
    const skillNames = new Set(fs.readdirSync(path.join(ROOT, "skills")).filter((n) => fs.existsSync(path.join(ROOT, "skills", n, "skill.md"))));
    eq(validateExperts(meta, skillNames), [], "随包的 experts.json 体检干净");

    // 真升级：v0.9.5 的老文件没有 seen_builtin_skills，视频成片师手里就是当时随包那两个技能
    const up = { experts: [
      { name: "视频成片师", builtin: true, skills: ["video-compose", "short-drama"] },
      { name: "短剧导演", builtin: true, skills: [] }, // 升级前用户自己把 short-drama 删了
      { name: "周报助手", builtin: true, skills: ["weekly-report"] }, // 删了 feishu-doc
    ], teams: [] };
    r = mergeBuiltinExperts(up, JSON.parse(JSON.stringify(meta)));
    ok(r.bound.includes("视频成片师:product-demo"), "老文件第一次升级：视频成片师跟当时随包的一样 → 后来新绑的 product-demo 补上", r.bound);
    eq(up.experts.find((e) => e.name === "视频成片师").skills, ["video-compose", "short-drama", "product-demo"], "  └ 手里那份");
    eq([up.experts.find((e) => e.name === "短剧导演").skills, up.experts.find((e) => e.name === "周报助手").skills], [[], ["weekly-report"]], "  └ 升级前用户自己删掉的不塞回来");
    eq(mergeBuiltinExperts(up, JSON.parse(JSON.stringify(meta))).bound, [], "  └ 再跑一次不动");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑦ 接线：别的文件里那几处");
  {
    const app01 = read("public/js/app-01.js");
    if (wired(/makeRecipeFormCard\(ev, turnSid, submit, ctx\)/.test(app01), "app-01.js makeAskCard 还没转到 makeRecipeFormCard")) ok(true, "app-01 的 makeAskCard 遇到 fields 转给表单卡");
    if (wired(/_mark\(ev\.answer, ev\.timeout, ev\.summary, ev\.estimate\)/.test(app01), "app-01.js ask_answer 还没把 summary / estimate 交给卡片")) ok(true, "ask_answer 把摘要和预估交给卡片定格");
    const html = read("public/index.html");
    if (wired(html.includes('<script src="js/app-08-recipe.js"></script>'), "index.html 还没引 app-08-recipe.js")) ok(true, "index.html 引了 app-08-recipe.js");
    if (wired(/\.ask-form\b/.test(html) && /\.rf-opt\b/.test(html), "index.html 还没有 .ask-form 的样式")) ok(true, "index.html 有表单卡的样式");
    const app04 = read("public/js/app-04.js");
    if (wired(RECIPE_SKILLS.every((n) => app04.includes(n)), "app-04.js 的场景卡还没摆三个配方")) ok(true, "首页场景卡摆了三个配方");
    const meta = JSON.parse(read("experts.json") || "{}");
    const ex = (n) => (meta.experts || []).find((e) => e.name === n) || {};
    const bound = (ex("短视频脚本师").skills || []).includes("promo-video") && ["xhs-carousel", "multi-post"].every((s) => (ex("小红书运营").skills || []).includes(s));
    if (wired(bound && ex("宣传片导演").builtin === true && (meta.teams || []).some((t) => t.name === "宣传片出片组"), "experts.json 还没绑新技能、没加宣传片导演 / 宣传片出片组")) {
      ok(true, "experts.json：脚本师、小红书运营绑了新技能，有宣传片导演和宣传片出片组");
      // 老用户那份：这几个专家技能是空的 → 升级时补绑上
      const old = JSON.parse(JSON.stringify(meta));
      for (const e of old.experts) if (["短视频脚本师", "小红书运营"].includes(e.name)) e.skills = [];
      delete old.seen_builtin_skills;
      const r = mergeBuiltinExperts(old, meta);
      ok(r.bound.includes("短视频脚本师:promo-video") && r.bound.includes("小红书运营:xhs-carousel"), "  └ 老用户升级时补绑得上", r.bound);
    }
    if (wired(/r\.bound/.test(read("server.js")), "server.js 启动合并时还没看 r.bound（补绑了不落盘）")) ok(true, "server.js 补绑了会落盘");
    if (wired(/\["recipes",/.test(read("test/all.js")), "test/all.js 还没登记 recipes 这套")) ok(true, "test/all.js 登记了这套");
  }

  console.log(`\n内容配方：${pass} 通过，${fail} 失败${skipped ? `，${skipped} 条跳过（等接线）` : ""}`);
  finished = true;
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); finished = true; process.exit(1); });

/**
 * 够这张卡用的假 DOM：建元素、解析 innerHTML（严格：多一个没转义的尖括号就抛）、
 * 后代选择器（tag.class[data-x="v"] 用空格串起来）、classList / dataset / hidden / click。
 * 仓库里没有 jsdom，为这一张卡拉一个依赖不值得。
 */
function fakeDom() {
  const VOID = new Set(["input", "br", "img", "hr"]);
  const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m, k) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[k]);
  const camel = (s) => s.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
  class Text {
    constructor(t) { this.nodeType = 3; this.data = t; this.parent = null; }
    get textContent() { return this.data; }
  }
  class El {
    constructor(tag) {
      this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.childNodes = []; this.parent = null;
      this.attrs = {}; this.dataset = {}; this._cls = new Set(); this.hidden = false; this.disabled = false;
      this.onclick = null; this.oninput = null; this.onkeydown = null; this.value = ""; this.title = ""; this.type = ""; this.placeholder = ""; this.maxLength = -1;
      const self = this;
      this.classList = {
        add: (...c) => c.forEach((x) => self._cls.add(x)),
        remove: (...c) => c.forEach((x) => self._cls.delete(x)),
        contains: (c) => self._cls.has(c),
        toggle: (c, f) => { const on = f === undefined ? !self._cls.has(c) : !!f; if (on) self._cls.add(c); else self._cls.delete(c); return on; },
      };
    }
    get className() { return [...this._cls].join(" "); }
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
    appendChild(n) { n.parent = this; this.childNodes.push(n); return n; }
    setAttribute(k, v) {
      v = String(v);
      this.attrs[k] = v;
      if (k === "class") this.className = v;
      else if (k.startsWith("data-")) this.dataset[camel(k.slice(5))] = v;
      else if (k === "hidden") this.hidden = true;
      else if (k === "disabled") this.disabled = true;
      else if (k === "title") this.title = v;
    }
    getAttribute(k) { return k === "class" ? this.className : Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return this.getAttribute(k) != null; }
    get nodeName() { return this.tagName; }
    get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
    set textContent(t) { this.childNodes = []; if (String(t)) this.appendChild(new Text(String(t))); }
    set innerHTML(html) { this.childNodes = []; parseInto(this, String(html)); }
    click() { if (!this.disabled && typeof this.onclick === "function") this.onclick({ preventDefault() {} }); }
    querySelectorAll(sel) {
      const parts = sel.trim().split(/\s+/).map(compound);
      const out = [];
      const walk = (n) => { for (const ch of n.children) { if (chain(ch, parts)) out.push(ch); walk(ch); } };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }
  function compound(s) {
    const m = /^([a-z0-9]*)((?:\.[\w-]+)*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/i.exec(s);
    if (!m) throw new Error(`假 DOM 不认的选择器：${s}`);
    return { tag: m[1].toUpperCase(), cls: m[2].split(".").filter(Boolean), attr: m[3], val: m[4] };
  }
  function one(el, c) {
    if (c.tag && el.tagName !== c.tag) return false;
    if (!c.cls.every((x) => el._cls.has(x))) return false;
    if (!c.attr) return true;
    const got = c.attr.startsWith("data-") ? el.dataset[camel(c.attr.slice(5))] : el.getAttribute(c.attr);
    return c.val === undefined ? got != null : got === c.val;
  }
  function chain(el, parts) {
    if (!one(el, parts[parts.length - 1])) return false;
    let i = parts.length - 2;
    for (let a = el.parent; a && i >= 0; a = a.parent) if (a.nodeType === 1 && one(a, parts[i])) i--;
    return i < 0;
  }
  function parseInto(root, html) {
    const re = /<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
    let cur = root, at = 0, m;
    while ((m = re.exec(html))) {
      if (m.index !== at) throw new Error(`假 DOM：第 ${at} 个字符起解析不了（多半是没转义的尖括号）：${html.slice(at, at + 40)}`);
      at = re.lastIndex;
      if (m[1]) {
        let n = cur;
        while (n && n !== root && n.tagName !== m[1].toUpperCase()) n = n.parent;
        if (!n || n === root) throw new Error(`假 DOM：多出来的 </${m[1]}>`);
        cur = n.parent;
      } else if (m[2]) {
        const el = new El(m[2]);
        for (const a of m[3].matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], a[2] === undefined ? "" : decode(a[2]));
        cur.appendChild(el);
        if (!m[4] && !VOID.has(m[2].toLowerCase())) cur = el;
      } else cur.appendChild(new Text(decode(m[5])));
    }
    if (at !== html.length) throw new Error(`假 DOM：结尾解析不了：${html.slice(at, at + 40)}`);
    if (cur !== root) throw new Error(`假 DOM：<${cur.tagName.toLowerCase()}> 没闭合`);
  }
  return { document: { createElement: (t) => new El(t) }, El };
}
