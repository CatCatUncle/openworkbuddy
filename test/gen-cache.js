"use strict";
/**
 * 生成结果缓存 —— 「同一格重跑，别再烧第二次钱」这条链路。
 *
 *   node test/gen-cache.js
 *
 * 这套东西坏掉的时候，用户是看不见的：图照样出、片照样有。坏法只有两种，
 * 一种是**白花钱**（该命中的没命中，一集十二镜重跑一次就多买十一镜），
 * 另一种更糟，是**张冠李戴**（不该命中的命中了，拿上一次的旧图冒充这一次的新图，
 * 交付里错了一格，还不报错）。所以这里每条正向断言后面都跟一个反向对照：
 * 把该命中的改成不该命中的，必须落空——少了这层，「缓存」退化成「永远返回第一张图」
 * 也照样全绿。
 *
 * 盯五件事：
 *
 *   1. key 的口径。描述、落点文件名、尺寸、型号、渠道地址、落点目录、工作空间，
 *      改了任何一样都必须换一个 key。漏带哪一样，就在哪一样上张冠李戴。
 *   2. 只缓存点了名的那一格（有 filename），no_cache 是硬旁路。不分这一刀，
 *      「生成三张不同的封面」那种连着三次一样的调用会拿回同一张图。
 *   3. 参考图按**内容**算，不按路径算。重画一版还叫原来的名字，必须重出。
 *   4. 指针悬空当没命中。用户把产物删了，缓存绝不能返回一个指向空气的路径。
 *   5. 真省下了那一趟。数的是**上游被打了几次**，不是回执里写了什么——
 *      回执是缓存自己写的，拿它当证据等于自证。
 *
 * 外加一条红线：索引是明文 JSON，里面一个字节的 api_key 都不许有。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  ← " + String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 300) : "")); }
}
function eq(got, want, name) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same, name, same ? undefined : { got, want });
}

// 家目录指到临时盘：索引落在 DATA_DIR/data 下，不隔离这套测试会写进开发者自己那份缓存
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-gencache-home-"));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "owb-gencache-ws-"));
const WS2 = fs.mkdtempSync(path.join(os.tmpdir(), "owb-gencache-ws2-"));
process.env.OPENWORKBUDDY_HOME = HOME;

const cache = require(path.join(ROOT, "gen-cache"));
const mm = require(path.join(ROOT, "media-models"));
const tools = require(path.join(ROOT, "tools"));
const security = require(path.join(ROOT, "security"));

const DIR = path.join(WS, "任务_1");
fs.mkdirSync(DIR, { recursive: true });
const resolveFile = (rel) => path.join(WS, String(rel || ""));

/** 这把 Key 只有一个用途：证明它一个字节都没进索引 */
const KEY = "sk-这把钥匙绝不许进索引-9527";
const CFG = { model: "seedream-4", base_url: "https://gw.example.test/v1", api_key: KEY };
/** 算一次 key。四个参数都给默认值，测哪一样就只改哪一样 */
const K = (input, cfg, dir, wsRoot) =>
  cache.key("generate_image", input, cfg || CFG, dir || DIR, resolveFile, wsRoot || WS);

// ---------------------------------------------------------------- 1
console.log("\n【1】key 的口径：改了什么，就必须换一个 key");
{
  const base = { prompt: "一只猫", filename: "猫.png", size: "1024x1024" };
  const k0 = K(base);
  ok(typeof k0 === "string" && k0.length >= 16, "点了名的调用算得出 key", k0);
  eq(K({ ...base }), k0, "同样的参数 → 同一个 key（算不稳的话缓存永远命不中，等于没有）");

  ok(K({ ...base, prompt: "一只狗" }) !== k0, "换了描述 → 换 key");
  ok(K({ ...base, filename: "狗.png" }) !== k0, "换了落点文件名 → 换 key");
  ok(K({ ...base, size: "512x512" }) !== k0, "换了尺寸 → 换 key");
  ok(K(base, { ...CFG, model: "seedream-3" }) !== k0, "换了型号 → 换 key（同一句描述，换个模型出来的是另一张图）");
  ok(K(base, { ...CFG, base_url: "https://another.example.test/v1" }) !== k0, "换了渠道地址 → 换 key");
  ok(K(base, null, path.join(WS, "任务_2")) !== k0, "换了落点目录 → 换 key（两个对话各要各的那一份）");
  // 两边都是各自工作空间下的「任务_1」——落点的相对路径逐字一样，只有工作空间根不同。
  // 这正是多租户真正会撞上的样子；不把落点也摆成一样，这一条会被「落点目录不同」顺手盖过去，
  // 看着绿，实际上根本没测到 ws 这一维（第一版就是这么写的，靠变异测试才发现）
  ok(K(base, null, path.join(WS2, "任务_1"), WS2) !== k0,
    "★换了工作空间 → 换 key★ 多租户下绝不许跨租户命中——那是数据串门，不是省钱");

  // 反向对照：这两样改了不该换 key，否则缓存会「明明是同一件事却总也命不中」
  eq(K(base, { ...CFG, api_key: "sk-同一个网关的另一把" }), k0, "反向对照：同一个网关换把 Key → 还是同一个 key（出来的是同一张图）");
  eq(K(base, { ...CFG, base_url: "https://gw.example.test/v1/" }), k0, "反向对照：地址尾巴多一个斜杠不算换渠道");
}

// ---------------------------------------------------------------- 2
console.log("\n【2】不该缓存的一律不算 key");
{
  const base = { prompt: "一只猫", filename: "猫.png" };
  eq(K({ prompt: "一只猫" }), null, "★没点名（没给 filename）→ 不缓存★ 那是「再给我一个」，生图没有 seed，本来就该每次不一样");
  eq(K({ ...base, filename: "   " }), null, "filename 只有空格 → 当没点名");
  eq(K({ ...base, no_cache: true }), null, "★no_cache: true → 硬旁路★ 「换一版试试」这条正当需求不能被缓存堵死");
  eq(K(base, { ...CFG, model: "" }), null, "渠道没配型号 → 不算 key，让真正那一趟去报错（它的话说得比这儿清楚）");
  eq(K(base, { ...CFG, base_url: "" }), null, "渠道没配地址 → 同上");
  ok(K(base) !== null, "反向对照：配齐了就该算得出 key（不然上面五条全是「因为 key 永远返回 null」）");
  eq(K({ ...base, no_cache: false }), K(base), "反向对照：no_cache: false 等于没写这个字段，不许因此换一个 key");
}

// ---------------------------------------------------------------- 3
console.log("\n【3】参考图按「内容」算，不按路径算");
{
  const ref = path.join(WS, "参考.png");
  const shot = (v) => K({ prompt: "照着这张画", filename: "出.png", reference_images: v || ["参考.png"] });
  fs.writeFileSync(ref, "第一版的参考图");
  const kA = shot();
  fs.writeFileSync(ref, "重画过的第二版，字节完全不同");
  ok(shot() !== kA, "★参考图重画了一版、还叫原来的名字 → 必须换 key★ 不然就是拿旧图冒充新图，而且不留痕迹");
  fs.writeFileSync(ref, "第一版的参考图");
  eq(shot(), kA, "反向对照：内容改回去 → key 也回到原来那个（证明算的确实是内容）");
  eq(shot("参考.png"), kA, "反向对照：给一个字符串和给只有一项的数组是同一件事");

  const x1 = shot(["查无此图.png"]);
  const x2 = shot(["也查无此图.png"]);
  ok(x1 && x2 && x1 !== x2, "两张都读不到的参考图，key 也得是两个（糊成一坨的话两次不同的调用会互相命中）");
}

// ---------------------------------------------------------------- 4
console.log("\n【4】索引往返：记得住、认得出、指针悬空当没命中");
{
  cache.clear();
  const k = K({ prompt: "一只猫", filename: "猫.png" });
  eq(cache.get(k, WS), null, "还没记过 → 没命中");

  fs.writeFileSync(path.join(DIR, "猫.png"), "PNG");
  cache.put(k, { content: "图片已生成：任务_1/猫.png（工作空间内的相对路径，模型 seedream-4）", isError: false, file: "猫.png" }, DIR, WS, "seedream-4");

  const hit = cache.get(k, WS);
  ok(hit && hit.isError === false && hit.cached === true, "记过之后 → 命中", hit);
  ok(hit && hit.content.startsWith("图片已生成：任务_1/猫.png"), "回执还是上次那一份（模型拿到的路径不变）", hit && hit.content);
  ok(hit && hit.content.endsWith(cache.HIT_NOTE), "回执尾巴上补了那句：这次没再花钱");
  ok(/no_cache/.test(cache.HIT_NOTE), "那句话里真写了 no_cache 这条出路（不写的话模型只能自己猜怎么绕开）");
  eq(hit && hit.file, "猫.png", "命中时带回产物文件名");
  eq(cache.stats().entries, 1, "索引里就这一条");
  ok(cache.stats().hits >= 1, "命中次数记上了（设置页要拿它告诉用户省了多少次）", cache.stats());

  fs.unlinkSync(path.join(DIR, "猫.png"));
  eq(cache.get(k, WS), null, "★用户把产物删了 → 当没命中★ 绝不返回一个指向空气的路径");
  eq(cache.stats().entries, 0, "悬空那条顺手清掉，不留一条永远命不中的垃圾");
}

// ---------------------------------------------------------------- 5
console.log("\n【5】不该记进索引的一律不记");
{
  cache.clear();
  const k = K({ prompt: "一只猫", filename: "a.png" });
  cache.put(k, { content: "图像接口错误 500", isError: true, file: "a.png" }, DIR, WS, "m");
  eq(cache.stats().entries, 0, "失败的那一趟不记（记了的话下次重试会直接拿回上次的失败）");
  cache.put(k, { content: "已生成", isError: false }, DIR, WS, "m");
  eq(cache.stats().entries, 0, "没报出产物文件名的不记（没有指针可记）");
  cache.put(k, { content: "已生成", isError: false, file: "跑到外面.png" }, os.tmpdir(), WS, "m");
  eq(cache.stats().entries, 0, "产物落在工作空间外面的不记（指针会指到工作空间外头去）");

  fs.writeFileSync(path.join(DIR, "a.png"), "PNG");
  cache.put(k, { content: "已生成", isError: false, file: "a.png" }, DIR, WS, "m");
  eq(cache.stats().entries, 1, "反向对照：正常的那一趟记上了（不然上面三条全是「因为 put 根本不工作」）");
}

// ---------------------------------------------------------------- 6
console.log("\n【6】索引封顶：超了按「最近用过」淘汰");
{
  // 这份索引是手写的，每条给一个明确的 last。靠 Date.now() 现攒的话，
  // 五百条会挤在同一毫秒里并列，「谁被淘汰」就成了随机的，测了也不算测
  const items = {};
  const N = cache.MAX_ENTRIES + 5;
  for (let i = 0; i < N; i++) items["k" + i] = { file: "任务_1/a.png", content: "旧的", model: "m", at: 1, last: 1000 + i, hits: 0 };
  fs.writeFileSync(cache.FILE, JSON.stringify({ v: 1, items }));

  cache.put(K({ prompt: "新的一格", filename: "a.png" }), { content: "新的", isError: false, file: "a.png" }, DIR, WS, "m");
  const db = JSON.parse(fs.readFileSync(cache.FILE, "utf8"));
  eq(Object.keys(db.items).length, cache.MAX_ENTRIES, "索引封顶在 MAX_ENTRIES 条");
  ok(!db.items.k0 && !db.items.k5, "最久没用过的那几条被淘汰了", Object.keys(db.items).length);
  ok(db.items.k6 && db.items["k" + (N - 1)], "反向对照：最近用过的都留着（不然就是「一超量就全清」）");
}

// ---------------------------------------------------------------- 7 / 8 / 9
const json = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
const bin = (b) => ({ ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => b, text: async () => "" });

async function e2e() {
  console.log("\n【7】端到端：同一格重跑，上游真的没被再打一次");
  cache.clear();
  security.auditClear();

  const c = {
    media: {
      image: { base_url: "https://gw.example.test/v1", api_key: KEY, model: "seedream-4" },
      tts: { base_url: "https://gw.example.test/v1", api_key: KEY, model: "tts-1", voice: "Cherry" },
      video: { base_url: "https://ark.example.test/api/v3", api_key: KEY, model: "seedance-1-0-pro" },
    },
  };
  mm.normalize(c);
  const media = mm.resolve(c);

  // 数的是「上游被打了几次」。拿回执当证据等于自证——那句「这次没花钱」本来就是缓存自己写的
  const up = { image: 0, tts: 0, video: 0 };
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (/\/images\/generations$/.test(u)) { up.image++; return json({ data: [{ b64_json: Buffer.from("fake-png-bytes").toString("base64") }] }); }
    if (/\/audio\/speech$/.test(u)) { up.tts++; return bin(Buffer.alloc(400, 7)); }
    if (/\/contents\/generations\/tasks$/.test(u)) { up.video++; return json({ id: "task-1" }); }
    if (/\/contents\/generations\/tasks\/task-1$/.test(u)) return json({ status: "succeeded", content: { video_url: "https://cdn.example.test/v.mp4" } });
    if (/\.mp4$/.test(u)) return bin(Buffer.alloc(300, 9));
    throw new Error("测试里没准备这个地址：" + u);
  };

  const OUT = "任务_缓存";
  const call = (name, input) => tools.executeTool(name, input, { media, security: { gateway: false }, baseDir: OUT });
  const outFile = (n) => path.join(WS, OUT, n);

  try {
    await tools.withWorkspace(WS, async () => {
      // ── 生图 ────────────────────────────────────────────────
      let r = await call("generate_image", { prompt: "封面：一只猫", filename: "封面.png" });
      eq(r.isError, false, "第一次：出图成功", r.content);
      eq(up.image, 1, "第一次：上游被打了 1 次");
      ok(!/no_cache/.test(r.content), "第一次不是命中，回执里不该有那句复用说明", r.content.slice(-60));

      r = await call("generate_image", { prompt: "封面：一只猫", filename: "封面.png" });
      eq(r.isError, false, "第二次：还是成功", r.content);
      eq(up.image, 1, "★第二次：上游一次都没再被打——这一格的钱只花过一次★");
      ok(r.content.endsWith(cache.HIT_NOTE), "第二次的回执里说清楚了这次没花钱、要重出该加什么", r.content.slice(-60));
      ok(security.auditList(20).some((e) => /复用上次的产物/.test(e.text)), "审计里留了痕：这一趟是复用的（省下的钱得看得见）", security.auditList(3));

      await call("generate_image", { prompt: "封面：一只猫", filename: "封面.png", no_cache: true });
      eq(up.image, 2, "★no_cache: true → 真的重出一份★ 硬旁路，不许被缓存堵死");

      await call("generate_image", { prompt: "随便来一张" });
      await call("generate_image", { prompt: "随便来一张" });
      eq(up.image, 4, "★反向对照：没给 filename 的连着两次一样的调用，每次都真跑★ 不然「生成三张不同的封面」会变成同一张");

      await call("generate_image", { prompt: "封面：一只狗", filename: "封面2.png" });
      eq(up.image, 5, "反向对照：换了描述 → 重出");

      fs.unlinkSync(outFile("封面.png"));
      r = await call("generate_image", { prompt: "封面：一只猫", filename: "封面.png" });
      eq(up.image, 6, "产物被用户删了 → 下一次真跑");
      eq(r.isError, false, "而且是真出了一张新的", r.content);
      ok(fs.existsSync(outFile("封面.png")), "文件真的回来了（而不是甩回一个指向空气的路径）");

      // ── 配音 ────────────────────────────────────────────────
      r = await call("text_to_speech", { text: "第一句旁白", filename: "旁白.mp3" });
      eq(r.isError, false, "配音：第一次成功", r.content);
      eq(up.tts, 1, "配音：上游 1 次");
      r = await call("text_to_speech", { text: "第一句旁白", filename: "旁白.mp3" });
      eq(up.tts, 1, "★配音重跑也不再花钱★");
      ok(r.content.endsWith(cache.HIT_NOTE), "配音命中的回执也带那句说明", r.content.slice(-60));
      await call("text_to_speech", { text: "换了一句词", filename: "旁白2.mp3" });
      eq(up.tts, 2, "反向对照：词改了 → 真的重配");

      // ── 生视频（这一路最贵，也最值得缓存）──────────────────
      r = await call("generate_video", { prompt: "猫跑过草地", filename: "第一镜.mp4" });
      eq(r.isError, false, "视频：第一次成功", r.content);
      eq(up.video, 1, "视频：上游 1 次");
      r = await call("generate_video", { prompt: "猫跑过草地", filename: "第一镜.mp4" });
      eq(up.video, 1, "★视频重跑也不再花钱★");
      ok(r.content.endsWith(cache.HIT_NOTE), "视频命中的回执也带那句说明", r.content.slice(-60));
      await call("generate_video", { prompt: "狗跑过草地", filename: "第二镜.mp4" });
      eq(up.video, 2, "反向对照：换了镜头 → 真的重出");
    });
  } finally {
    global.fetch = realFetch;
  }

  // ---------------------------------------------------------------- 8
  console.log("\n【8】索引是明文 JSON：一个字节的 Key 都不许在里面");
  {
    const raw = fs.readFileSync(cache.FILE, "utf8");
    eq(raw.indexOf(KEY), -1, "★索引文件里搜不到 api_key★");
    eq(raw.indexOf("sk-"), -1, "连 sk- 这个前缀都搜不到");
    ok(raw.indexOf("封面.png") > 0, "反向对照：索引里确实有这几格的指针（证明上面搜的是一份有内容的索引，不是空文件）", raw.length);

    // 有些聚合网关是把 Key 挂在查询串上的。接口地址只进 key 的哈希、不进索引正文，
    // 但哈希也别拖着它走——万一哪天为了排查方便把 endpoint 明文记进条目，这条就是最后一道闸
    ok(cache.endpointOf("https://gw.example.test/v1?token=" + KEY).indexOf(KEY) === -1,
      "★地址里带 Key 的那种网关，算 endpoint 时只取 host + path，一个字节的 Key 都不拖进来★",
      cache.endpointOf("https://gw.example.test/v1?token=" + KEY));
    eq(cache.endpointOf("https://gw.example.test/v1?token=x"), cache.endpointOf("https://gw.example.test/v1"),
      "反向对照：同一个网关，地址上带不带查询串算出来是同一个 endpoint（跟「换把 Key 不换 key」同一个道理）");
  }

  // ---------------------------------------------------------------- 9
  console.log("\n【9】工具说明书里得写着「怎么强制重出」");
  {
    const defs = tools.TOOL_DEFS;
    for (const n of ["generate_image", "generate_video", "text_to_speech"]) {
      const d = defs.find((x) => x.name === n) || {};
      const s = d.input_schema || {};
      ok(s.properties && s.properties.no_cache, n + "：参数表里有 no_cache（模型得知道怎么换一版）", Object.keys(s.properties || {}));
      ok(!(s.required || []).includes("no_cache"), n + "：no_cache 是可选的");
      ok(((s.properties || {}).no_cache || {}).type === "boolean", n + "：no_cache 是个布尔（写成别的类型，模型给 \"true\" 字符串就绕不开缓存了）", (s.properties || {}).no_cache);
    }
    const h = (defs.find((x) => x.name === "html_to_image") || {}).input_schema || {};
    ok(h.properties && !h.properties.no_cache,
      "反向对照：html_to_image 不进缓存，也就不该有这个参数（本机渲染不花钱，而且同名 HTML 天天在变，按参数算 key 一定拿旧图冒充新图）");
    const t = (defs.find((x) => x.name === "transcribe_audio") || {}).input_schema || {};
    ok(t.properties && !t.properties.no_cache, "反向对照：转写也不进缓存（产物是文字，本来就便宜，模型还常改 with_timestamps 再跑一遍）");
  }

  // ---------------------------------------------------------------- 10
  console.log("\n【10】直调这条口：不过模型也能重跑一格，但只准跑这四个");
  {
    const { createAgentRuntime, DIRECT_TOOLS } = require(path.join(ROOT, "agent"));

    eq(DIRECT_TOOLS.length, 4, "能直调的就四个", DIRECT_TOOLS);
    for (const n of ["generate_image", "generate_video", "text_to_speech", "html_to_image"]) {
      ok(DIRECT_TOOLS.includes(n), n + "：给定输入 → 一个产物文件，可以直调");
    }
    // 这几个永远不许进白名单：把它们做成界面上一按就执行的按钮，等于开了一个没人看守的门
    for (const n of ["write_file", "edit_file", "run_shell", "run_node", "delete_file", "use_skill", "delegate_to_expert"]) {
      ok(!DIRECT_TOOLS.includes(n), "★" + n + " 不许直调★ 它要的是模型的判断，不是一颗能从界面上扣的扳机");
    }

    // 模型这一路整条封死：直调只要碰它一次，这个桩就当场炸
    let llmCalls = 0;
    const llmStub = {
      model: "假模型", provider: "假渠道",
      chat: async () => { llmCalls++; throw new Error("直调这条路不许碰模型"); },
    };
    const cfg = { ...c, agent: { tool_timeout_ms: 120000 }, security: { gateway: false }, search: {} };
    const rt = createAgentRuntime({ config: cfg, llm: llmStub, mcpManager: { toolDefs: () => [] }, experts: [] });
    ok(typeof rt.runTool === "function", "runtime 上挂着 runTool（server.js 的 /api/tool/run 就打这个口）");

    const up2 = { image: 0 };
    const realFetch2 = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      if (/\/images\/generations$/.test(u)) { up2.image++; return json({ data: [{ b64_json: Buffer.from("fake-png-bytes").toString("base64") }] }); }
      throw new Error("测试里没准备这个地址：" + u);
    };
    try {
      await tools.withWorkspace(WS, async () => {
        let denied = null;
        try { await rt.runTool("run_shell", { command: "echo 直调" }, {}); } catch (e) { denied = e; }
        ok(denied, "★白名单外的工具直接被拒★ 不是跑完再拦");
        eq(denied && denied.status, 400, "拒得是「你这个请求不对」（400），不是「服务器炸了」（500）");
        ok(denied && /generate_image/.test(denied.message), "拒绝的话里把能跑的那几个列出来了（照着改就行，不用去翻代码）", denied && denied.message);

        // 真跑一趟：能出图就说明 execOpts 把 media 带上了（少这一项，generate_image 连模型都点不了名）
        const r1 = await rt.runTool("generate_image", { prompt: "直调：一只猫", filename: "直调.png" }, { baseDir: OUT });
        eq(r1.isError, false, "直调：出图成功", r1.content);
        eq(up2.image, 1, "直调：上游被打了 1 次");
        eq(r1.file, "直调.png", "回执里报出了产物文件名（前端要拿它换那一格的图）");
        ok(fs.existsSync(outFile("直调.png")), "★产物落在这条对话自己的成果目录里★ 跟对话里生成的那批待在一起");
        ok(!r1.cached, "第一次不是命中");

        const r2 = await rt.runTool("generate_image", { prompt: "直调：一只猫", filename: "直调.png" }, { baseDir: OUT });
        eq(up2.image, 1, "★直调重跑同一格：上游一次都没再被打★");
        eq(r2.cached, true, "命中时带上 cached 标记——界面上「这一次没花钱」那句话就靠它");

        await rt.runTool("generate_image", { prompt: "直调：一只猫", filename: "直调.png", no_cache: true }, { baseDir: OUT });
        eq(up2.image, 2, "反向对照：直调这条路上 no_cache 照样是硬旁路");

        eq(llmCalls, 0, "★全程一次模型都没调★ 这条口存在的全部理由就是这一行");
      });
    } finally {
      global.fetch = realFetch2;
    }
  }
}

e2e().then(
  () => finish(),
  (e) => { fail++; console.log("  ✗ 端到端那组炸了：" + ((e && e.stack) || e)); finish(); }
);

function finish() {
  for (const d of [HOME, WS, WS2]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
}
