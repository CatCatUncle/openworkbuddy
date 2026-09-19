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

function base(p) { return String(p || "").split(/[\\/]/).pop() || ""; }
function isPlaceholder(s) { const t = String(s || "").trim(); return !t || PLACEHOLDERS.includes(t); }
function payloadOf(node) { return (node && node.payload) || {}; }
function kindOf(node) { return String((node && node.kind) || ""); }

/** 这个节点这一类产物做出来没有：既要有路径，文件还得真在盘上 */
function outputOf(payload, kind, onDisk) {
  for (const key of OUTPUT_KEYS[kind] || []) {
    const v = payload[key];
    if (typeof v !== "string" || !v.trim()) continue;
    const b = base(v);
    return { path: v.trim(), base: b, ok: !onDisk || onDisk.has(b) };
  }
  return null;
}

/**
 * 画布上所有被当成「产物」的路径。
 *
 * 判定本身还是纯函数：这里只负责把要核实的路径列出来，真去问盘的是调用方。
 * 有这一条是因为 /api/files 那份清单是截断过的（最深 3 层、最多 500 条），
 * 「不在清单里」从来就不等于「文件没了」——工作目录一攒多、素材落在深一层，
 * 满画布的节点就会一起挂出「盘上已经没有了」，而文件好端端躺着。
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

/** 过去的生成耗时。只认真记过 ms 的，缺的一律不参与，宁可估不出来也不拿 0 凑数 */
function medianMs(runs, kind) {
  const xs = runs.filter((r) => r && r.kind === kind && Number(r.ms) > 0).map((r) => Number(r.ms)).sort((a, b) => a - b);
  if (!xs.length) return 0;
  return xs.length % 2 ? xs[(xs.length - 1) / 2] : Math.round((xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2);
}

function collectRuns(nodes) {
  const out = [];
  for (const n of nodes) {
    const p = payloadOf(n);
    if (Array.isArray(p.generation_runs)) out.push(...p.generation_runs);
    else if (p.generation) out.push(p.generation);
  }
  return out;
}

/**
 * @param {{nodes?:Array}} state 画布状态
 * @param {{onDisk?:Set<string>}} opts onDisk 给 basename 集合；不给就不查盘（只看字段）
 */
function dramaProgress(state, opts = {}) {
  const nodes = Array.isArray(state && state.nodes) ? state.nodes : [];
  const onDisk = opts.onDisk instanceof Set ? opts.onDisk : null;
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
    const p = payloadOf(n), o = outputOf(p, "cast", onDisk);
    return { nodeId: n.id, name: String(p.name || p.title || n.id), role: String(p.role || ""), image: o ? { path: o.path, ok: o.ok } : null };
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
    const frame = outputOf(p, "image", onDisk), video = outputOf(p, "video", onDisk), audio = outputOf(p, "audio", onDisk);
    const needsVoice = !isPlaceholder(p.line);
    let blocked = "";
    if (isPlaceholder(p.prompt)) blocked = "没有提示词";
    else if (frame && !frame.ok) blocked = "首帧文件丢了";
    else if (!frame) blocked = "还没生成首帧";
    else if (video && !video.ok) blocked = "视频文件丢了";
    if (!frame || !frame.ok) pending.image++;
    if ((!video || !video.ok) && frame && frame.ok) pending.video++;
    if (needsVoice && (!audio || !audio.ok)) pending.audio++;
    rows.push({
      id: String(p.id || p.title || n.id), nodeId: n.id, title: String(p.title || p.id || "镜头"),
      shot_size: String(p.shot_size || ""), duration: String(p.duration || ""), line: String(p.line || ""),
      needsVoice, blocked,
      frame: frame ? { path: frame.path, ok: frame.ok } : null,
      video: video ? { path: video.path, ok: video.ok } : null,
      audio: audio ? { path: audio.path, ok: audio.ok } : null,
    });
  }
  const lostFrames = rows.filter((r) => r.frame && !r.frame.ok);
  if (lostFrames.length) push("stop", `${lostFrames.length} 个镜头的首帧文件已经不在盘上了，视频这一步过不去`, lostFrames.map((r) => r.nodeId), "重生成首帧");
  const lostVideos = rows.filter((r) => r.video && !r.video.ok);
  if (lostVideos.length) push("stop", `${lostVideos.length} 个镜头的视频文件已经不在盘上了`, lostVideos.map((r) => r.nodeId), "重生成视频");

  // ⑦ 成片
  const cutDone = timelines.filter((n) => { const o = outputOf(payloadOf(n), "video", onDisk); return !!(o && o.ok); });
  const voiceTotal = rows.filter((r) => r.needsVoice).length;
  if (timelines.length && !cutDone.length && shots.length && rows.every((r) => r.video && r.video.ok)) {
    push("warn", "所有镜头都有视频了，可以合成片了", timelines.map((n) => n.id), "开始剪辑");
  }

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

module.exports = { dramaProgress, outputPaths, _internals: { outputOf, medianMs, isPlaceholder, SCRIPT_MIN } };
