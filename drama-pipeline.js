// @ts-check
/**
 * 短剧制片进度。
 *
 * 画布上早就有剧本、角色、场次、镜头、生图生视频这些节点了，缺的是「这部戏做到哪了」——
 * 一张摆了三十个镜头的画布，光靠眼睛看不出还差几张首帧、哪一镜卡着生不出来、
 * 剩下的活儿大概要跑多久。用户只能一个节点一个节点点开看，那不叫工作流，那叫一堆卡片。
 *
 * 这里把画布算成一条**有次序的产线**：剧本 → 定妆 → 分镜 → 首帧 → 镜头视频 → 配音 → 成片。
 * 每一档都给「几个做完了 / 一共几个」，并且回答三个问题：
 *   ① 下一步该干什么（next）；
 *   ② 现在卡在哪、卡的是哪几个节点（blockers，带 ids，界面上能直接跳过去）；
 *   ③ 还剩多少活儿、按这张画布自己跑过的速度大概要多久（pending / eta）。
 *
 * 三条硬规矩：
 *   · 「有路径」不等于「做完了」。盘上没有那个文件，这一格就是没done——
 *     以前那种「字段里写着 first_frame 所以算完成」的算法，正好把最难查的一类事故算成绿的。
 *   · 没跑过就不估时间。eta 为 null 好过编一个数出来。
 *   · 纯函数，不碰 fs、不发请求。文件在不在由调用方给 onDisk，这样它能被单测钉死。
 */

/** @typedef {import("./types/drama").CanvasNode} CanvasNode */
/** @typedef {import("./types/drama").CanvasPayload} CanvasPayload */
/** @typedef {import("./types/drama").CanvasStateLike} CanvasStateLike */
/** @typedef {import("./types/drama").GenerationRun} GenerationRun */
/** @typedef {import("./types/drama").AssetHit} AssetHit */
/** @typedef {import("./types/drama").Locate} Locate */
/** @typedef {import("./types/drama").AssetLocatorOptions} AssetLocatorOptions */
/** @typedef {import("./types/drama").OutputHit} OutputHit */
/** @typedef {import("./types/drama").ProgressCell} ProgressCell */
/** @typedef {import("./types/drama").DramaProgressOptions} DramaProgressOptions */
/** @typedef {import("./types/drama").DramaProgress} DramaProgress */
/** @typedef {import("./types/drama").ProgressStage} ProgressStage */
/** @typedef {import("./types/drama").Storyboard} Storyboard */
/** @typedef {import("./types/drama").StoryboardPromptInput} StoryboardPromptInput */
/** @typedef {import("./types/drama").StoryboardDraftOptions} StoryboardDraftOptions */
/** @typedef {import("./types/drama").StoryboardReply} StoryboardReply */
/** @typedef {import("./types/drama").StoryboardDraft} StoryboardDraft */
/** @typedef {import("./types/drama").StoryboardCheck} StoryboardCheck */

/** 这些字段里装的是这个节点的产物路径 */
const OUTPUT_KEYS = {
  image: ["first_frame", "path", "url", "image"], video: ["video", "path", "url"], audio: ["audio", "voice_file", "path", "url"],
  // 定妆照单开一档。角色节点的「参考图」落的是 reference，不能并进 image：
  // 镜头节点上的 reference 是喂进去的参考图、不是产出的首帧，混在一起会把「还没生成首帧」算成已完成。
  cast: ["reference", "image", "path", "url"],
};
/** 起手模板里的占位文字。原样没改过 = 还没写，不能算「剧本已完成」 */
const PLACEHOLDERS = [
  "一句话概念、人物关系、冲突与结局…",
  "在这里写一句话概念、人物关系、冲突、对白和结局。",
  "还没有剧本内容",
  "镜头内容与运动…",
  "对白或旁白…",
  "人物外形、性格、目标与关系…",
  "地点、时间、天气、光线与氛围…",
  // 图 / 视频 / 声音三种素材节点的起手文案。它们不参与剧本和镜头的完成度判定，
  // 收在这儿是因为前端拿同一份表拦「占位文字原样没改就按生成」——两边分了家就是一边拦一边放
  "这张图要保持的主体、风格与构图…",
  "描述你想生成的内容…",
  "对白、旁白或音乐说明…",
];
// 少于这个字数的，拆不出场次也生不出镜头。定在 30 是按中文一句话梗概的实际长度来的：
// 「阿明回乡接手父亲的士多店，发现账本里藏着十年前的一笔钱。三集反转，结局和解。」是 38 字，
// 得算写过了；「随便写两句」是 5 字，不能算。门槛再往上抬就会开始误伤真的短梗概
const SCRIPT_MIN = 30;

/** @param {unknown} p @returns {string} */
function base(p) { return String(p || "").split(/[\\/]/).pop() || ""; }
/** @param {unknown} s @returns {boolean} */
function isPlaceholder(s) { const t = String(s || "").trim(); return !t || PLACEHOLDERS.includes(t); }
/** @param {Partial<CanvasNode>|null|undefined} node @returns {CanvasPayload} */
function payloadOf(node) { return (node && node.payload) || {}; }
/** @param {Partial<CanvasNode>|null|undefined} node @returns {string} */
function kindOf(node) { return String((node && node.kind) || ""); }

/**
 * 路径统一成「a/b/c.png」：反斜杠换正斜杠，去掉空段和「.」段。「..」原样留着，交给调用方去判越界
 * @param {unknown} p
 * @returns {string}
 */
function normRel(p) {
  return String(p == null ? "" : p).trim().replace(/\\/g, "/").split("/").filter((s) => s && s !== ".").join("/");
}

/**
 * 素材定位：字段里写的路径 → 盘上的那一份（工作区相对路径）。
 *
 * 以前只按文件名搜、同名的取第一份。产物全落在工作区根目录时这没毛病；
 * 可产物一按画布分了子目录（短剧/第1集、短剧/第2集），两集都有一张「镜头_S1-01_首帧.png」，
 * 取到哪份全看目录遍历的先后——拼进片子的可能是另一集的画面，而且哪儿都不报错。所以：
 *   ① 先按相对路径认（near 给了就先按那个目录解一遍：分镜表里的路径是相对分镜表自己写的）；
 *   ② 认不出再按文件名全区搜，只命中一份才算它；
 *   ③ 同名好几份就原样报 ambiguous，不替人挑。
 *
 * @param {Iterable<string>} rels 盘上的文件（工作区相对路径）
 * @param {AssetLocatorOptions} [opts] exists：那份清单是截断过的，
 *        按相对路径没在清单里认出来时再问一次盘。不给就只看清单
 * @returns {Locate}
 */
function assetLocator(rels, opts = {}) {
  const listed = new Set(), byBase = new Map();
  for (const r of rels || []) {
    const rel = normRel(r);
    if (!rel || listed.has(rel)) continue;
    listed.add(rel);
    const b = base(rel);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(rel);
  }
  const exists = typeof opts.exists === "function" ? opts.exists : null;
  // 问过盘的记下来：同一个路径一次请求里只问一次（调用方给 exists 设了次数上限，
  // 重复问、白问都在吃那份额度，额度一完后面的文件就被当成「没了」，一键补齐会去重花钱）
  /** @type {Map<string, boolean>} */
  const asked = new Map();
  const known = (rel) => {
    if (listed.has(rel)) return true;
    if (!exists) return false;
    if (asked.has(rel)) return asked.get(rel);
    let ok = false;
    try { ok = !!exists(rel); } catch { ok = false; }
    asked.set(rel, ok);
    return ok;
  };
  return (ref, near) => {
    const rel = normRel(ref);
    if (!rel) return { rel: "" };
    const dir = normRel(near);
    // 已经带着这个目录的（工作区相对路径）就别再拼一层「短剧/甲/短剧/甲/…」白问一次盘
    const underDir = dir && (rel === dir || rel.startsWith(dir + "/"));
    if (dir && !underDir && !/^[\\/]/.test(String(ref).trim())) { const r = normRel(dir + "/" + rel); if (known(r)) return { rel: r }; }
    if (known(rel)) return { rel };
    const hits = byBase.get(base(rel)) || [];
    if (hits.length === 1) return { rel: hits[0] };
    if (hits.length > 1) return { rel: "", ambiguous: hits.slice().sort() };
    return { rel: "" };
  };
}

/**
 * 这个节点这一类产物做出来没有：既要有路径，文件还得真在盘上。
 * 给了 locate 就按「相对路径 → 文件名全区搜」认；同名好几份的算「在」（文件确实都在，
 * 按「丢了」算的话一键补齐会拿它重跑、白花一次钱），但带上 ambiguous，让上层把它当卡点报出来。
 * @param {CanvasPayload} payload
 * @param {string} kind OUTPUT_KEYS 里的一类：image / video / audio / cast
 * @param {Set<string>|null} onDisk
 * @param {Locate|null} [locate]
 * @returns {OutputHit|null}
 */
function outputOf(payload, kind, onDisk, locate) {
  for (const key of OUTPUT_KEYS[kind] || []) {
    const v = payload[key];
    if (typeof v !== "string" || !v.trim()) continue;
    const b = base(v);
    if (typeof locate === "function") {
      const hit = /** @type {Partial<AssetHit>} */ (locate(v.trim()) || {});
      const amb = Array.isArray(hit.ambiguous) && hit.ambiguous.length > 1 ? hit.ambiguous : null;
      return { path: v.trim(), base: b, ok: !!hit.rel || !!amb, ...(hit.rel && hit.rel !== v.trim() ? { rel: hit.rel } : {}), ...(amb ? { ambiguous: amb } : {}) };
    }
    return { path: v.trim(), base: b, ok: !onDisk || onDisk.has(b) };
  }
  return null;
}
/**
 * 给界面的那一格：路径、在不在，认到了别的路径 / 同名好几份时再多带一项
 * @param {OutputHit|null} o
 * @returns {ProgressCell|null}
 */
function cellOf(o) {
  return o ? { path: o.path, ok: o.ok, ...(o.rel ? { rel: o.rel } : {}), ...(o.ambiguous ? { ambiguous: o.ambiguous } : {}) } : null;
}
/**
 * 一行里各格的 ambiguous 并成一份。「该行返回 ambiguous」是给界面直接摆出来的，不用它再挨格翻
 * @param {...(OutputHit|null)} cells
 * @returns {{ambiguous?: string[]}}
 */
function rowAmbiguous(...cells) {
  const out = [];
  for (const c of cells) for (const r of (c && c.ambiguous) || []) if (!out.includes(r)) out.push(r);
  return out.length ? { ambiguous: out } : {};
}

/**
 * 画布上所有被当成「产物」的路径。
 *
 * 判定本身还是纯函数：这里只负责把要核实的路径列出来，真去问盘的是调用方。
 * 有这一条是因为 /api/files 那份清单是截断过的（最深 3 层、最多 500 条），
 * 「不在清单里」从来就不等于「文件没了」——工作目录一攒多、素材落在深一层，
 * 满画布的节点就会一起挂出「盘上已经没有了」，而文件好端端躺着。
 * @param {CanvasStateLike} state
 * @returns {string[]}
 */
function outputPaths(state) {
  const nodes = Array.isArray(state && state.nodes) ? state.nodes : [];
  const out = new Set();
  for (const n of nodes) {
    const p = payloadOf(n);
    for (const kind of Object.keys(OUTPUT_KEYS)) {
      const o = outputOf(p, kind, null);
      if (o && o.path) out.add(o.path);
    }
  }
  return [...out];
}

/**
 * 过去的生成耗时。只认真记过 ms 的，缺的一律不参与，宁可估不出来也不拿 0 凑数
 * @param {GenerationRun[]} runs
 * @param {string} kind
 * @returns {number}
 */
function medianMs(runs, kind) {
  const xs = runs.filter((r) => r && r.kind === kind && Number(r.ms) > 0).map((r) => Number(r.ms)).sort((a, b) => a - b);
  if (!xs.length) return 0;
  return xs.length % 2 ? xs[(xs.length - 1) / 2] : Math.round((xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2);
}

/**
 * @param {Array<Partial<CanvasNode>>} nodes
 * @returns {GenerationRun[]}
 */
function collectRuns(nodes) {
  /** @type {GenerationRun[]} */
  const out = [];
  for (const n of nodes) {
    const p = payloadOf(n);
    if (Array.isArray(p.generation_runs)) out.push(...p.generation_runs);
    else if (p.generation) out.push(p.generation);
  }
  return out;
}

/**
 * @param {CanvasStateLike} state 画布状态
 * @param {DramaProgressOptions} [opts] onDisk 给 basename 集合；不给就不查盘（只看字段）。
 *        locate 是 assetLocator 造出来的那个函数：给了就按「相对路径 → 文件名全区搜」认，onDisk 不再看
 * @returns {DramaProgress}
 */
function dramaProgress(state, opts = {}) {
  const nodes = Array.isArray(state && state.nodes) ? state.nodes : [];
  const onDisk = opts.onDisk instanceof Set ? opts.onDisk : null;
  const locate = typeof opts.locate === "function" ? opts.locate : null;
  const out = (p, kind) => outputOf(p, kind, onDisk, locate);
  const by = (k) => nodes.filter((n) => kindOf(n) === k);

  const scripts = by("script"), characters = by("character"), shots = by("shot");
  const storyboards = by("storyboard"), scenes = by("scene"), timelines = by("timeline");

  const blockers = [];
  const push = (level, text, ids, action) => blockers.push({ level, text, ids: ids || [], ...(action ? { action } : {}) });

  // ① 剧本
  const written = scripts.filter((n) => !isPlaceholder(payloadOf(n).text) && String(payloadOf(n).text || "").trim().length >= SCRIPT_MIN);
  if (scripts.length && !written.length) push("stop", "剧本还是模板里那几句，先把故事写进去，后面才拆得出场次和镜头", scripts.map((n) => n.id), "编辑剧本");

  // ② 定妆照：角色节点有没有一张真在盘上的图
  const castRows = characters.map((n) => {
    const p = payloadOf(n), o = out(p, "cast");
    return { nodeId: n.id, name: String(p.name || p.title || n.id), role: String(p.role || ""), image: cellOf(o), ...rowAmbiguous(o) };
  });
  const castDone = castRows.filter((r) => r.image && r.image.ok);
  const castBroken = castRows.filter((r) => r.image && !r.image.ok);
  if (castBroken.length) push("stop", `${castBroken.length} 个角色的定妆照在画布上写着，盘上已经没有了——这几个角色的镜头会一直生不一致`, castBroken.map((r) => r.nodeId), "重生成定妆照");

  // ③ 分镜：有没有镜头，镜头有没有提示词
  if (!shots.length && (storyboards.length || scenes.length)) push("stop", "有分镜表但画布上一个镜头节点都没有，先点「展开场次与镜头」", storyboards.map((n) => n.id), "展开场次与镜头");
  const noPrompt = shots.filter((n) => isPlaceholder(payloadOf(n).prompt));
  if (noPrompt.length) push("stop", `${noPrompt.length} 个镜头没写提示词，这几个点生成也只会失败`, noPrompt.map((n) => n.id), "补提示词");

  // ④⑤⑥ 逐镜头三件事
  const rows = [], pending = { cast: castRows.filter((r) => !r.image || !r.image.ok).length, image: 0, video: 0, audio: 0 };
  for (const n of shots) {
    const p = payloadOf(n);
    const frame = out(p, "image"), video = out(p, "video"), audio = out(p, "audio");
    const needsVoice = !isPlaceholder(p.line);
    let blocked = "";
    if (isPlaceholder(p.prompt)) blocked = "没有提示词";
    else if (frame && !frame.ok) blocked = "首帧文件丢了";
    else if (!frame) blocked = "还没生成首帧";
    else if (frame.ambiguous) blocked = "首帧同名的有好几份";
    else if (video && !video.ok) blocked = "视频文件丢了";
    else if (video && video.ambiguous) blocked = "视频同名的有好几份";
    if (!frame || !frame.ok) pending.image++;
    // 首帧同名好几份的不算「能生视频」：拿哪张当首帧都是猜，先让人把路径定下来
    if ((!video || !video.ok) && frame && frame.ok && !frame.ambiguous) pending.video++;
    if (needsVoice && (!audio || !audio.ok)) pending.audio++;
    rows.push({
      id: String(p.id || p.title || n.id), nodeId: n.id, title: String(p.title || p.id || "镜头"),
      shot_size: String(p.shot_size || ""), duration: String(p.duration || ""), line: String(p.line || ""),
      needsVoice, blocked,
      frame: cellOf(frame), video: cellOf(video), audio: cellOf(audio),
      ...rowAmbiguous(frame, video, audio),
    });
  }
  const lostFrames = rows.filter((r) => r.frame && !r.frame.ok);
  if (lostFrames.length) push("stop", `${lostFrames.length} 个镜头的首帧文件已经不在盘上了，视频这一步过不去`, lostFrames.map((r) => r.nodeId), "重生成首帧");
  const lostVideos = rows.filter((r) => r.video && !r.video.ok);
  if (lostVideos.length) push("stop", `${lostVideos.length} 个镜头的视频文件已经不在盘上了`, lostVideos.map((r) => r.nodeId), "重生成视频");
  // 同名好几份：文件都在，只是不知道该用哪一份。拿哪份往下生视频、往片子里拼都是在替人猜，
  // 所以当卡点报——改法是把字段改成带目录的路径，不花钱
  const twins = [...castRows, ...rows].filter((r) => r.ambiguous);
  if (twins.length) push("stop", `${twins.length} 个节点的素材有同名的好几份，分不清用哪份；把路径改成带目录的`, twins.map((r) => r.nodeId), "选定素材");

  // ⑦ 成片
  const cutDone = timelines.filter((n) => { const o = out(payloadOf(n), "video"); return !!(o && o.ok); });
  const voiceTotal = rows.filter((r) => r.needsVoice).length;
  if (timelines.length && !cutDone.length && shots.length && rows.every((r) => r.video && r.video.ok)) {
    push("warn", "所有镜头都有视频了，可以合成片了", timelines.map((n) => n.id), "开始剪辑");
  }

  /** @type {ProgressStage[]} */
  const stages = [
    { key: "script", label: "剧本", done: written.length, total: scripts.length },
    { key: "cast", label: "定妆", done: castDone.length, total: characters.length },
    { key: "shots", label: "分镜", done: shots.length - noPrompt.length, total: shots.length },
    { key: "frame", label: "首帧", done: rows.filter((r) => r.frame && r.frame.ok).length, total: shots.length },
    { key: "video", label: "镜头视频", done: rows.filter((r) => r.video && r.video.ok).length, total: shots.length },
    { key: "voice", label: "配音", done: rows.filter((r) => r.needsVoice && r.audio && r.audio.ok).length, total: voiceTotal },
    { key: "cut", label: "成片", done: cutDone.length, total: timelines.length },
  ].map((s) => ({ ...s, state: s.total === 0 ? "none" : s.done >= s.total ? "done" : s.done > 0 ? "doing" : "todo" }));

  const counted = stages.filter((s) => s.total > 0);
  const doneSum = counted.reduce((n, s) => n + Math.min(s.done, s.total), 0);
  const totalSum = counted.reduce((n, s) => n + s.total, 0);
  const percent = totalSum ? Math.round((doneSum / totalSum) * 100) : 0;

  // 下一步：卡着的优先，否则就是第一个没做完的档
  const firstStop = blockers.find((b) => b.level === "stop");
  const firstOpen = stages.find((s) => s.total > 0 && s.done < s.total);
  const next = firstStop
    ? { text: firstStop.text, ids: firstStop.ids, action: firstStop.action || "" }
    : firstOpen
      ? { text: `继续做「${firstOpen.label}」：还差 ${firstOpen.total - firstOpen.done} 个`, ids: [], action: firstOpen.key }
      : totalSum ? { text: "这部片子该做的都做完了", ids: [], action: "" } : { text: "画布还是空的，先建一条短剧工作流", ids: [], action: "starter" };

  // 还要多久：只按这张画布自己跑过的耗时中位数算。没跑过就说不知道
  const runs = collectRuns(nodes);
  const per = { image: medianMs(runs, "image"), video: medianMs(runs, "video"), audio: medianMs(runs, "audio") };
  // 定妆照跑的就是生图那条命令，耗时并进 image 一起算，别让它在「还要多久」里凭空消失
  const need = { image: pending.image + pending.cast, video: pending.video, audio: pending.audio };
  const known = ["image", "video", "audio"].filter((k) => need[k] > 0 && per[k] > 0);
  const unknown = ["image", "video", "audio"].filter((k) => need[k] > 0 && !per[k]);
  const eta = known.length
    ? { ms: known.reduce((n, k) => n + need[k] * per[k], 0), basis: `按这张画布跑过的 ${runs.filter((r) => Number(r.ms) > 0).length} 次取中位数`, partial: unknown.length > 0 }
    : null;

  return { percent, stages, shots: rows, cast: castRows, blockers, next, pending, eta, counts: { script: scripts.length, character: characters.length, shot: shots.length, scene: scenes.length, storyboard: storyboards.length, timeline: timelines.length } };
}

// ---------- 剧本 → 分镜表草稿 ----------
/*
 * 以前剧本到分镜只能在对话里让 agent 写，画布上没有入口；每一镜的画风也是各写各的，十几镜下来一路漂。
 * 这一段是「剧本 → 草稿」的四步：拼提示词、解析回复、归一、校验。全是纯函数，跟上面一样不碰 fs、不发请求。
 *
 * 分工是死的：
 *   · 模型只管「拆」：场次、镜头、景别、画面、运动、台词；
 *   · 画幅、全片画风、每镜时长是人定的，归一时按请求写回去，不信模型的——
 *     模型顺手编一段画风写进来，镜与镜之间照样漂，等于白加了这个字段；
 *   · 产物字段（首帧 / 尾帧 / 视频 / 配音 / 定妆照 / 成片）一律不收：草稿阶段什么都还没生成，
 *     模型写的路径全是编的。留着它，进度面板会去盘上找一个根本不存在的文件，报一串「文件丢了」。
 */
const STORYBOARD_ASPECTS = ["9:16", "16:9", "1:1"];
const SHOT_PRODUCT_KEYS = ["first_frame", "last_frame", "video", "audio"];
const SHOT_DRAFT_KEYS = ["id", "cast", "shot_size", "frame_prompt", "motion_prompt", "line", "speaker", "note"];
const CHARACTER_DRAFT_KEYS = ["id", "name", "look", "voice"]; // ref 是定妆照路径，也是产物
const SCENE_DRAFT_KEYS = ["id", "place", "time"];

/**
 * 拼给模型的那两段话。
 * frame_prompt 里不许写画风：画布展开时会把全片 style 接在首帧提示词后面（见 short-drama 技能），
 * 模型再写一遍就是两段画风打架，回写时也剥不干净。
 * @param {StoryboardPromptInput} [input]
 * @returns {{system:string, prompt:string}}
 */
function buildStoryboardPrompt({ script, style = "", aspect = "9:16", shotSeconds = 5, title = "" } = {}) {
  const sec = Number(shotSeconds) > 0 ? Number(shotSeconds) : 5;
  const system = [
    "你是短剧分镜师。把用户给的剧本拆成一份分镜表，只输出一个 JSON 对象：不要解释，不要 Markdown 代码块。",
    "结构：",
    `{"title":"片名","logline":"一句话梗概","aspect":"${aspect}",`,
    ` "characters":[{"id":"A","name":"角色名","look":"外貌，一段写死，后面每镜照用"}],`,
    ` "scenes":[{"id":"S1","place":"地点","time":"时间与光线","shots":[`,
    `   {"id":"S1-01","shot_size":"远景|全景|中景|近景|特写","cast":["A"],"frame_prompt":"首帧画面","motion_prompt":"动作与运镜","line":"台词或旁白","speaker":"A"}]}]}`,
    "规矩：",
    "1. 镜头号全片唯一，按场次编：S1-01、S1-02、S2-01……场次号 S1、S2……角色 id 用 A、B、C……",
    "2. frame_prompt 写首帧：景别 + 场景 + 姿态 + 光线。角色只写「参考图里的女生」这类指代，不要描述五官；不要写画风，画风全片统一另加。",
    "3. motion_prompt 只写动作和运镜，不重复画面内容。",
    `4. 每镜约 ${sec} 秒，台词要在 ${sec} 秒内说得完；没有人声的镜头不写 line 和 speaker。`,
    "5. cast 和 speaker 只填 characters 里有的 id。",
    "6. 不要写 first_frame、last_frame、video、audio、ref、duration、output、style：现在还什么都没生成。",
    "7. 只拆剧本里有的内容，不加新情节。",
  ].join("\n");
  const head = [];
  if (String(title || "").trim()) head.push(`片名（没有更好的就用它）：${String(title).trim()}`);
  if (String(style || "").trim()) head.push(`全片画风（只作参考，不要写进任何字段）：${String(style).trim()}`);
  head.push(`画幅：${aspect}；每镜约 ${sec} 秒。`);
  return { system, prompt: head.join("\n") + "\n\n剧本：\n" + String(script || "").trim() };
}

/**
 * 模型回复 → 对象。模型爱在 JSON 外面包一层 ```json 或者前后各说一句，
 * 先剥围栏、再截第一个「{」到最后一个「}」；还解不出来就是坏的，交给调用方重试。
 * 推理模型（MiniMax、部分网关转的 DeepSeek / Qwen）会把 <think>…</think> 直接写进正文，
 * 思考里常带花括号，不先剥掉，「第一个 { 到最后一个 }」就截到思考里去了——两次都这样，白付两遍钱拿个 422。
 * 一律按最后一个 </think> 之后算正文——有的网关把开头标签吃了，只剩收尾的，这样也能对上。
 * @param {unknown} text
 * @returns {StoryboardReply}
 */
function parseStoryboardReply(text) {
  let raw = String(text == null ? "" : text);
  const thinkEnd = raw.toLowerCase().lastIndexOf("</think>");
  if (thinkEnd >= 0) raw = raw.slice(thinkEnd + "</think>".length);
  raw = raw.trim();
  if (!raw) return { ok: false, error: "模型回复是空的" };
  const tries = [raw];
  const fence = raw.match(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/);
  if (fence) tries.push(fence[1].trim());
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a >= 0 && b > a) tries.push(raw.slice(a, b + 1));
  for (const t of tries) {
    let v;
    try { v = JSON.parse(t); } catch { continue; }
    if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, data: v };
    return { ok: false, error: "模型回复不是一个 JSON 对象" };
  }
  return { ok: false, error: "模型回复不是合法 JSON" };
}

/**
 * 只留白名单里的键；字符串顺手去掉首尾空白，空串当没写
 * @param {Record<string, any>} obj
 * @param {string[]} keys
 * @returns {Record<string, any>}
 */
function pickKeys(obj, keys) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of keys) {
    let v = obj[k];
    if (typeof v === "string") { v = v.trim(); if (!v) continue; }
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 模型给的草稿 → 能交给人改的草稿。改动全部写进 warnings，不悄悄改。
 * 不修结构性错误（缺字段、类型不对）：那些留给 validateStoryboard 报，调用方拿去重试。
 * @param {any} obj parseStoryboardReply 解出来的对象
 * @param {StoryboardDraftOptions} [opts] 人定的那几项
 * @returns {StoryboardDraft}
 */
function normalizeStoryboardDraft(obj, opts = {}) {
  const src = obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  const warnings = [];
  const data = pickKeys(src, ["title", "logline", "fps"]);
  if (typeof data.title !== "string" || !data.title) {
    data.title = String(opts.title || "").trim() || "未命名短剧";
    warnings.push(`模型没给片名，先叫「${data.title}」`);
  }
  if (!(Number.isInteger(data.fps) && data.fps >= 12 && data.fps <= 60)) delete data.fps;
  data.aspect = STORYBOARD_ASPECTS.includes(opts.aspect) ? opts.aspect : "9:16";
  const style = String(opts.style || "").trim();
  if (style) data.style = style;
  const extra = Object.keys(src).filter((k) => !["title", "logline", "fps", "aspect", "style", "characters", "scenes"].includes(k));
  if (extra.length) warnings.push("去掉了模型多写的字段：" + extra.join("、"));

  data.characters = Array.isArray(src.characters)
    ? src.characters.filter((c) => c && typeof c === "object" && !Array.isArray(c)).map((c) => pickKeys(c, CHARACTER_DRAFT_KEYS))
    : src.characters;

  const sec = Number(opts.shotSeconds);
  let products = 0, emptyScenes = 0;
  if (Array.isArray(src.scenes)) {
    data.scenes = [];
    for (const s of src.scenes) {
      if (!s || typeof s !== "object" || Array.isArray(s)) continue;
      const scene = pickKeys(s, SCENE_DRAFT_KEYS);
      if (!Array.isArray(s.shots)) { scene.shots = s.shots; data.scenes.push(scene); continue; }
      scene.shots = s.shots.filter((sh) => sh && typeof sh === "object" && !Array.isArray(sh)).map((sh) => {
        if (SHOT_PRODUCT_KEYS.some((k) => sh[k] != null && sh[k] !== "")) products++;
        const shot = pickKeys(sh, SHOT_DRAFT_KEYS);
        if (Array.isArray(shot.cast)) shot.cast = [...new Set(shot.cast.map((x) => (typeof x === "string" ? x.trim() : x)))];
        if (sec > 0) shot.duration = sec;
        return shot;
      });
      // 一镜都没有的场次，schema 里就不合法（shots 至少一个）。整场丢掉，说一声
      if (!scene.shots.length) { emptyScenes++; continue; }
      data.scenes.push(scene);
    }
  } else data.scenes = src.scenes;
  if (products) warnings.push(`去掉了 ${products} 镜里模型编的产物路径（还什么都没生成）`);
  if (emptyScenes) warnings.push(`去掉了 ${emptyScenes} 个一镜都没有的场次`);
  return { data, warnings };
}

let storyboardSchemaCache = null;
/** 分镜表 schema。跟技能读的是同一份文件——两边各写一份，迟早一边改了一边没改 */
function storyboardSchema() {
  if (!storyboardSchemaCache) storyboardSchemaCache = require("./skills/short-drama/references/分镜表.schema.json");
  return storyboardSchemaCache;
}

/**
 * 按 schema 走一遍：type / required / additionalProperties / enum / minItems / minimum / maximum / items。够分镜表用，不是通用实现
 * @param {any} v 被查的那一段
 * @param {any} sch 对应的那一段 schema
 * @param {string} at 报错时的位置前缀，根上是空串
 * @param {string[]} out 错误收在这里，最多 30 条
 */
function schemaErrors(v, sch, at, out) {
  if (!sch || out.length >= 30) return;
  const where = at || "分镜表";
  const t = sch.type;
  const isObj = v && typeof v === "object" && !Array.isArray(v);
  const typeOk = t === "object" ? isObj : t === "array" ? Array.isArray(v) : t === "string" ? typeof v === "string"
    : t === "number" ? typeof v === "number" && Number.isFinite(v) : t === "integer" ? Number.isInteger(v)
    : t === "boolean" ? typeof v === "boolean" : true;
  if (!typeOk) { out.push(`${where} 应该是 ${t}`); return; }
  if (Array.isArray(sch.enum) && !sch.enum.includes(v)) { out.push(`${where} 只能是 ${sch.enum.join(" / ")}`); return; }
  if (typeof v === "number") {
    if (sch.minimum != null && v < sch.minimum) out.push(`${where} 不能小于 ${sch.minimum}`);
    if (sch.maximum != null && v > sch.maximum) out.push(`${where} 不能大于 ${sch.maximum}`);
  }
  if (t === "array") {
    if (sch.minItems != null && v.length < sch.minItems) out.push(`${where} 至少要 ${sch.minItems} 个`);
    v.forEach((x, i) => schemaErrors(x, sch.items, `${where}[${i}]`, out));
  }
  if (t === "object") {
    const props = sch.properties || {};
    const sub = (k) => (at ? `${at}.${k}` : k);
    for (const k of sch.required || []) {
      if (v[k] === undefined) out.push(`${sub(k)} 缺了`);
      // 必填的文字留空，跟没写一样：景别、提示词空着，下一步生成根本没法跑
      else if (typeof v[k] === "string" && !v[k].trim()) out.push(`${sub(k)} 不能是空的`);
    }
    for (const k of Object.keys(v)) {
      if (props[k]) schemaErrors(v[k], props[k], sub(k), out);
      else if (sch.additionalProperties === false) out.push(`${sub(k)} 不是分镜表里的字段`);
    }
  }
}

/**
 * 分镜表校验：必填字段、类型、镜头号唯一。
 * 镜头号不分大小写比：mac、Windows 的盘上「镜头_s1-01.png」和「镜头_S1-01.png」是同一个文件，
 * 两镜撞了号，后生成的那张会把前一张盖掉。
 * cast / speaker 指向不存在的角色只算 warning：那一镜少一张参考图，不至于整份不能用。
 * @param {any} data
 * @param {object} [schema] 不给就读 分镜表.schema.json
 * @returns {StoryboardCheck}
 */
function validateStoryboard(data, schema = storyboardSchema()) {
  const errors = [], warnings = [];
  schemaErrors(data, schema, "", errors);
  const isObj = data && typeof data === "object" && !Array.isArray(data);
  const chars = isObj && Array.isArray(data.characters) ? data.characters.filter((c) => c && typeof c === "object") : [];
  const scenes = isObj && Array.isArray(data.scenes) ? data.scenes.filter((s) => s && typeof s === "object") : [];
  const dup = (label, ids) => {
    const seen = new Set(), hit = new Set();
    for (const id of ids) { if (typeof id !== "string" || !id.trim()) continue; const k = id.trim().toLowerCase(); if (seen.has(k)) hit.add(id.trim()); seen.add(k); }
    for (const id of hit) errors.push(`${label} ${id} 重复了`);
  };
  dup("角色 id", chars.map((c) => c.id));
  dup("场次号", scenes.map((s) => s.id));
  const shots = [];
  for (const s of scenes) for (const sh of (Array.isArray(s.shots) ? s.shots : [])) if (sh && typeof sh === "object") shots.push(sh);
  dup("镜头号", shots.map((sh) => sh.id));
  const known = new Set(chars.map((c) => (typeof c.id === "string" ? c.id.trim() : "")).filter(Boolean));
  const stray = new Set();
  for (const sh of shots) {
    for (const c of (Array.isArray(sh.cast) ? sh.cast : [])) if (typeof c === "string" && c.trim() && !known.has(c.trim())) stray.add(`${sh.id}:${c}`);
    if (typeof sh.speaker === "string" && sh.speaker.trim() && !known.has(sh.speaker.trim())) stray.add(`${sh.id}:${sh.speaker}`);
  }
  if (stray.size) warnings.push("这些镜头引用了不存在的角色：" + [...stray].slice(0, 10).join("、"));
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 追加：草稿接到已有分镜表后面。
 *   · 画幅、画风、片名沿用原表：已经生过的镜头是按原表的画幅和画风出的，追加的这一段跟着它走；
 *   · 角色按名字认——同名就是同一个人，沿用原表的 id 和外貌，定妆照也就接着用；
 *   · 撞号的场次、镜头、角色 id 换一个空着的号，改了哪个都写进 warnings。不许悄悄并到原表的同号镜头里去：
 *     那会把已经生好的首帧挂到另一句提示词名下。
 * @param {Partial<Storyboard>|null|undefined} base 原表
 * @param {Partial<Storyboard>} add 这次的草稿
 * @returns {StoryboardDraft}
 */
function mergeStoryboard(base, add) {
  const data = JSON.parse(JSON.stringify(base || {}));
  const warnings = [];
  const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
  if (add.aspect && data.aspect && add.aspect !== data.aspect) warnings.push(`草稿画幅是 ${add.aspect}，沿用原表的 ${data.aspect}`);
  if (add.style && !data.style) data.style = add.style;
  else if (add.style && add.style !== data.style) warnings.push("草稿的画风跟原表不一样，沿用原表的");
  if (!Array.isArray(data.characters)) data.characters = [];
  if (!Array.isArray(data.scenes)) data.scenes = [];

  const charIds = new Set(data.characters.map((c) => low(c && c.id)));
  const idMap = new Map();
  for (const c of add.characters || []) {
    const same = data.characters.find((o) => o && String(o.name || "").trim() && String(o.name).trim() === String(c.name || "").trim());
    if (same) {
      idMap.set(c.id, same.id);
      if (low(same.look) !== low(c.look)) warnings.push(`角色「${c.name}」沿用原表的外貌`);
      continue;
    }
    let id = String(c.id);
    if (charIds.has(low(id))) {
      let n = 2;
      while (charIds.has(low(`${c.id}${n}`))) n++;
      id = `${c.id}${n}`;
      warnings.push(`角色「${c.name}」的 id ${c.id} 跟原表撞了，改成 ${id}`);
    }
    charIds.add(low(id));
    idMap.set(c.id, id);
    data.characters.push({ ...c, id });
  }

  const sceneIds = new Set(data.scenes.map((s) => low(s && s.id)));
  const shotIds = new Set();
  for (const s of data.scenes) for (const sh of (Array.isArray(s && s.shots) ? s.shots : [])) shotIds.add(low(sh && sh.id));
  const nextShot = (prefix) => { let n = 1; while (shotIds.has(low(`${prefix}-${String(n).padStart(2, "0")}`))) n++; return `${prefix}-${String(n).padStart(2, "0")}`; };
  const remap = (id) => (idMap.has(id) ? idMap.get(id) : id);
  for (const s of add.scenes || []) {
    let sid = String(s.id);
    const moved = sceneIds.has(low(sid));
    if (moved) {
      let n = sceneIds.size + 1;
      while (sceneIds.has(low(`S${n}`))) n++;
      sid = `S${n}`;
      warnings.push(`场次 ${s.id} 跟原表撞号，追加为 ${sid}，镜头号跟着改`);
    }
    sceneIds.add(low(sid));
    const shots = [];
    for (const sh of s.shots || []) {
      let id = String(sh.id);
      if (moved || shotIds.has(low(id))) {
        id = nextShot(sid);
        if (!moved) warnings.push(`镜头 ${sh.id} 跟原表撞号，改成 ${id}`);
      }
      shotIds.add(low(id));
      const shot = { ...sh, id };
      if (Array.isArray(shot.cast)) shot.cast = [...new Set(shot.cast.map(remap))];
      if (typeof shot.speaker === "string" && shot.speaker) shot.speaker = remap(shot.speaker);
      shots.push(shot);
    }
    data.scenes.push({ ...s, id: sid, shots });
  }
  return { data, warnings };
}

module.exports = {
  dramaProgress, outputPaths, assetLocator,
  buildStoryboardPrompt, parseStoryboardReply, normalizeStoryboardDraft, validateStoryboard, mergeStoryboard,
  STORYBOARD_ASPECTS,
  _internals: { outputOf, normRel, medianMs, isPlaceholder, SCRIPT_MIN, storyboardSchema, schemaErrors },
};
