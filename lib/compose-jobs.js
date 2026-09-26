"use strict";
/**
 * 一键合成的任务队列：算计划、探 ffmpeg、一条一条跑、跑完认账写回画布。从 server.js 原样搬出来的。
 * 路由（/api/canvas/compose）在 routes/compose.js，只管把请求翻成这里的 plan / start / cancel / get / running。
 *
 * 函数写在顶层、依赖做成模块级变量由 createComposeJobs(deps) 填上，缘故跟 routes/canvas.js 开头说的一样：
 * 测试按顶格的函数名切源码（composeWriteBack 连同 canvasTickPast 会被切出来放进沙盒里跑）。
 * 队列是进程里的一份内存：重启就没了，查旧 id 会拿到 404，跟搬家之前一样。
 */
const fs = require("fs");
const path = require("path");
const dramaCompose = require("../drama-compose");   // 短剧最后一步：把镜头真的拼成成片

// 下面这几个由 createComposeJobs(deps) 填上。asset* / canvasTickPast 来自 routes/canvas.js
let getWorkspaceDir, outputFiles, safePath, shellPath, canvasReadState, canvasWriteState, assetBase, canvasAssetLocator, canvasAssetNear, canvasTickPast;

/**
 * 短剧成片：把画布上的镜头真的拼成一条片子。
 *
 * 在这之前，「最终剪辑」节点按下去只是往对话框里塞一句「请……给出可执行方案」——
 * 于是这条产线的最后一步是模型临场发挥：顺序可能排错、配音可能被 -shortest 切掉、
 * 也可能干脆在 concat 那一下撞上 `command not found: ffmpeg`，而那时候钱已经全花完了。
 *
 * 这里把这一步收成确定性的：顺序由 drama-compose.js 算（纯函数、可单测），
 * 命令由它拼好，这一层只负责三件真会碰外部世界的事：
 *   ① 探：ffmpeg / ffprobe 在不在，每个镜头的视频真实时长和画幅是多少；
 *   ② 跑：一条一条 spawn，跑到哪、跑了多久、失败了 ffmpeg 自己说了什么，全都记下来；
 *   ③ 认账：成片真的落在盘上（存在 + 有字节）才把路径写回画布的剪辑节点。
 *      「字段里写着路径」不等于「文件在盘上」——这条规矩在进度那边就已经吃过亏了。
 * 失败一律说清楚缺什么：缺 ffmpeg 就连装法一起给，别让人对着英文报错猜。
 */
const composeJobs = new Map();          // id → 这一次合成跑到哪了
let composeBusy = "";                   // 同时只让跑一条：ffmpeg 是吃满 CPU 的，两条一起跑只会都慢

const composeFilterCache = new Map();   // ffmpeg 路径 → 这台机器的 ffmpeg 带了哪些滤镜
/**
 * 这台机器的 ffmpeg 带了哪些滤镜。
 *
 * 值得单探一次：Homebrew 的 ffmpeg 就有不带 libass 的版本，而「烧字幕」「混配乐」都是**最后几条命令**——
 * 不先探，就要等三十个镜头全拼完，才在最后一步撞上一句英文报错。探一次几十毫秒，缓存住。
 * 原来这里只探 subtitles 一个，加配乐的时候才发现：探一个和探一串是同一条命令，
 * 差别只在 grep 什么，所以干脆把整张表拿回来。
 */
async function composeFilterSet(bin) {
  if (!bin) return new Set();
  if (composeFilterCache.has(bin)) return composeFilterCache.get(bin);
  const set = await new Promise((resolve) => {
    require("child_process").execFile(bin, ["-hide_banner", "-filters"], { timeout: 15000, maxBuffer: 1 << 22 }, (err, stdout) => {
      const out = new Set();
      if (!err) for (const m of String(stdout || "").matchAll(/^\s*[TSC.]+\s+(\S+)\s/gm)) out.add(m[1]);
      resolve(out);
    });
  });
  composeFilterCache.set(bin, set);
  return set;
}

/**
 * ffmpeg / ffprobe 在哪、这台 ffmpeg 带了哪些滤镜。
 * 位置交给 lib/media-probe.js：按句配音、录屏配音用的也是那一份，找到一次整个进程都记住；
 * 那边出了岔子才退回老路子自己找——画布一键合成不能因为一个新模块坏了就整个用不了。
 */
async function composeBins() {
  let ffmpeg = "", ffprobe = "", install = "";
  try {
    const b = await require("./media-probe").resolveMediaBins();
    ffmpeg = b.ffmpeg.bin || ""; ffprobe = b.ffprobe.bin || ""; install = b.install || "";
  } catch {
    const { resolveBin } = require("../engines/which");
    try { ffmpeg = (await resolveBin("ffmpeg")).bin || ""; } catch {}
    try { ffprobe = (await resolveBin("ffprobe")).bin || ""; } catch {}
    try { install = (require("../doctor").knownTool("ffmpeg") || {}).install || ""; } catch {}
  }
  const filters = await composeFilterSet(ffmpeg);
  return {
    ffmpeg, ffprobe, install,
    burn: filters.has("subtitles"),
    duck: filters.has("sidechaincompress"),   // 说话的时候把配乐自动压下去
    limiter: filters.has("alimiter"),         // 混完限个幅，人声乘 2 之后不至于削顶
    // 下面几样是时间轴成片要的：缺哪样就降哪样（硬切 / 不推镜 / 字幕只给文件 / 不加角标 / 加黑边），
    // 而且在开跑前的警告里说出来，不等到最后一步才撞上一句英文报错
    xfade: filters.has("xfade"),
    zoompan: filters.has("zoompan"),
    ass: filters.has("ass"),
    overlay: filters.has("overlay"),
    boxblur: filters.has("boxblur"),
  };
}

/**
 * 子进程用的 PATH。桌面版 / 服务端由 createComposeJobs 填上 shellPath（登录 shell 那份）；
 * 命令行里没人调 createComposeJobs，shellPath 是空的——退回 which.js 补全过的那份，不然一调就是 TypeError
 */
function composePath() {
  if (typeof shellPath === "function") { try { return shellPath(); } catch {} }
  try { return require("../engines/which").augmentedPath(); } catch { return process.env.PATH || ""; }
}

/** 探一个文件：多长、多大画幅、什么编码。探不到就返回 null——宁可没有，也不编一个 */
function composeProbe(bin, cwd, rel) {
  return new Promise((resolve) => {
    if (!bin) return resolve(null);
    require("child_process").execFile(bin, [
      "-v", "error", "-show_entries", `stream=codec_type,codec_name,width,height,avg_frame_rate,pix_fmt:${require("./media-probe").ROTATION_ENTRIES}:format=duration`, "-of", "json", rel,
    ], { cwd, timeout: 20000, maxBuffer: 1 << 20, env: { ...process.env, PATH: composePath() } }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout || "{}");
        const v = (j.streams || []).find((s) => s.codec_type === "video") || null;
        const fr = v && String(v.avg_frame_rate || "").split("/");
        const fps = fr && fr.length === 2 && Number(fr[1]) ? Number(fr[0]) / Number(fr[1]) : 0;
        const rot = v ? require("./media-probe").streamRotation(v) : 0;
        resolve({
          dur: Number((j.format || {}).duration) || 0,
          w: v ? Number(v.width) || 0 : 0, h: v ? Number(v.height) || 0 : 0,
          fps: Number.isFinite(fps) ? Math.round(fps) : 0, vcodec: v ? String(v.codec_name || "") : "",
          // 帧率和像素格式也得探：这两样不一致，直拼出来是「退出码 0、文件也在、
          // 就是时长少了大半截」——实测 30fps + 25fps 两段各 2 秒，拼出来只有 3.33 秒
          pix: v ? String(v.pix_fmt || "") : "",
          // w/h 仍是存储的宽高（短剧直拼要比这个）；手机竖拍转 90° 的另报 rot，按画面横竖挑裁切的地方自己换算
          ...(rot ? { rot } : {}),
        });
      } catch { resolve(null); }
    });
  });
}

/** 把画布和盘上的事实凑齐，算出这次合成的计划。dry 跑和真跑走的是同一条，不会算出两份不一样的东西 */
async function composeBuildPlan(name, want, music) {
  const bins = await composeBins();
  let state = { nodes: [], edges: [] }, boardUnreadable = "";
  try { state = canvasReadState(name || undefined, {}); } catch (e) { boardUnreadable = e.message; }
  const list = outputFiles();
  const files = new Map();
  for (const f of list) { const b = assetBase(f.name); if (!files.has(b)) files.set(b, f.name); }
  const onDisk = new Set(files.keys());
  // 素材按「相对路径 → 文件名全区搜」认，同名好几份的那一镜当卡点（以前是按文件名取第一份，
  // 两集同名的镜头拼进来的是哪一集全看目录遍历的先后）。ffmpeg 只在工作区里跑，所以只认当前工作区
  const locate = canvasAssetLocator(list, (rel) => { try { return fs.existsSync(safePath(rel)); } catch { return false; } }, { near: canvasAssetNear(name) });
  // 只探这张画布真用到的那几个文件。工作区里可能躺着几百个素材，挨个探是几十秒
  const wanted = new Set();
  for (const node of state.nodes || []) {
    const p = node.payload || {};
    // url/path/bgm 这几个是配乐那条路上的字段（声音节点的文件挂在 url/path 上）。
    // 少探一个的后果不是报错，是配乐的淡出排不出来——而那种「有音乐但结尾硬切」没人会去查字段名
    for (const key of ["video", "audio", "voice_file", "url", "path", "file", "bgm", "music", "bgm_file"]) {
      if (typeof p[key] !== "string" || !assetBase(p[key])) continue;
      const hit = locate(p[key]);
      if (hit.rel) wanted.add(hit.rel);
    }
  }
  // 探到的规格按相对路径记：两集同名的镜头时长不一样，按文件名记会串
  const probes = {};
  const cwd = getWorkspaceDir();
  for (const rel of wanted) { const r = await composeProbe(bins.ffprobe, cwd, rel); if (r) probes[rel] = r; }
  const plan = dramaCompose.composePlan(state, {
    files, locate, onDisk, probes, ...bins,
    subtitles: want == null ? null : !!want,
    music: music == null ? null : !!music,
  });
  return { plan, bins, boardUnreadable };
}

/**
 * 一条 ffmpeg 命令。stderr 全留着——出事的时候，ffmpeg 自己那句话比我们转述的准。
 * 第六个参数只有时间轴成片在用：env 叠在 PATH 上；onErr 拿 stderr 读 time= 算进度；
 * timeoutMs 到点先 TERM 再 KILL（一条卡死的命令不能把整把锁永远占着）。画布那条路什么都不传，行为不变
 */
function composeRun(job, bin, cwd, argv, onChild, { env = null, onErr = null, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = require("child_process").spawn(bin, argv, { cwd, env: { ...process.env, PATH: composePath(), ...(env || {}) } });
    onChild(child);
    let err = "", timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000).unref();
    }, timeoutMs) : null;
    const done = () => { if (timer) clearTimeout(timer); };
    child.stderr.on("data", (d) => { err = (err + d).slice(-8000); if (onErr) { try { onErr(String(d)); } catch {} } });
    child.on("error", (e) => { done(); resolve({ ok: false, ms: Date.now() - started, err: `跑不起来：${e.message}` }); });
    child.on("close", (code, signal) => { done(); resolve({ ok: code === 0, code, signal, ms: Date.now() - started, err, ...(timedOut ? { timedOut: true } : {}) }); });
  });
}

/**
 * 半截文件必须删掉。
 * ffmpeg 被杀在半路、或者跑挂了，盘上多半已经躺着一个叫「成片.mp4」的东西——
 * 文件名看着就是成片，点开是半截，而用户的文件列表里它跟真成片长得一模一样。
 * 留着它比没有更危险。只删这一趟自己刚建的那个名字（名字是 freeName 挑的，开跑前盘上没有）。
 */
function composeDropPartial(cwd, rel, job) {
  if (!rel) return;
  try {
    const p = path.join(cwd, rel);
    if (!fs.existsSync(p)) return;
    fs.unlinkSync(p);
    job.log.push(`${rel} 只写了一半，已经删掉了——半截文件跟成片长得一样，留着迟早被当成成片发出去`);
  } catch {}
}

async function composeExecute(job, plan, bin, name) {
  const cwd = getWorkspaceDir();
  fs.mkdirSync(path.join(cwd, plan.outputs.dir), { recursive: true });
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i], slot = job.steps[i];
    if (job.canceled) { slot.state = "skip"; continue; }
    job.at = i + 1;
    slot.state = "run";
    // concat 的清单和字幕文件得在跑到那一步之前落盘。放在这儿而不是一开头：
    // 前面哪一段没拼出来的话，清单里那一行指的就是个不存在的文件
    try {
      if (step.key === "concat") {
        fs.writeFileSync(path.join(cwd, plan.outputs.list), plan.listText, "utf8");
        // 字幕文件在这儿写，不在「烧字幕」那一步写：这台机器烧不了字幕的时候，
        // 一份时间轴对得上的 .srt 照样要给出去——导进剪辑软件就是一行菜单的事
        if (plan.srt && plan.outputs.srt) { fs.writeFileSync(path.join(cwd, plan.outputs.srt), plan.srt, "utf8"); job.subtitleFile = plan.outputs.srt; }
      }
    } catch (e) { slot.state = "fail"; slot.note = "写不进工作区：" + e.message; job.error = slot.note; job.done = true; return; }
    let r = await composeRun(job, bin, cwd, step.argv, (c) => { job.child = c; });
    if (!r.ok && step.fallback && !job.canceled) {
      slot.note = step.fallbackWhy || "第一条路没走通，换一条再试";
      job.log.push(`${slot.label}：${slot.note}`);
      r = await composeRun(job, bin, cwd, step.fallback, (c) => { job.child = c; });
      if (r.ok) slot.note += "（换过之后成了）";
    }
    job.child = null;
    slot.ms = r.ms;
    if (r.ok) {
      // 退出码 0 也得看东西在不在：磁盘满、被杀在半路，ffmpeg 都可能留下一个 0 字节的壳
      const out = path.join(cwd, step.out);
      let size = 0; try { size = fs.statSync(out).size; } catch {}
      if (!size) { slot.state = "fail"; slot.note = `ffmpeg 说成了，但 ${step.out} 没在盘上（或者是 0 字节）`; }
      else { slot.state = "done"; slot.size = size; continue; }
    } else if (job.canceled) { slot.state = "skip"; composeDropPartial(cwd, step.out, job); continue; }
    else {
      const tail = String(r.err || "").split("\n").filter((l) => l.trim()).slice(-4).join("\n");
      slot.state = "fail";
      slot.note = (r.signal ? `被中断（${r.signal}）` : `ffmpeg 退出码 ${r.code}`) + (tail ? "：" + tail : "");
    }
    composeDropPartial(cwd, step.out, job);
    // 烧字幕失败不算这次合成失败：成片已经出来了，字幕文件也在，人能自己接着弄
    if (step.optional) { job.log.push(`${slot.label}：${step.optionalWhy}`); slot.state = "skip"; continue; }
    job.error = `${slot.label} 没成——${slot.note}`;
    job.done = true;
    return;
  }
  if (job.canceled) { job.error = "你叫停了，已经拼好的片段都留着，下次接着来不用重跑"; job.done = true; return; }

  // ── 认账：文件真的在盘上，才敢说成片出来了，才敢写回画布
  const film = path.join(cwd, plan.outputs.film);
  let size = 0; try { size = fs.statSync(film).size; } catch {}
  if (!size) { job.error = `每一步都跑完了，但 ${plan.outputs.film} 不在盘上——这次不算成片`; job.done = true; return; }
  job.output = plan.outputs.film;
  job.bytes = size;
  const subbed = plan.outputs.subtitled;
  if (subbed) { try { if (fs.statSync(path.join(cwd, subbed)).size > 0) job.subtitled = subbed; } catch {} }
  try { job.wroteNode = composeWriteBack(name, plan, job); } catch (e) { job.log.push("成片好了，但写回画布没成：" + e.message); }
  job.done = true;
}


/**
 * 把成片挂回画布的「最终剪辑」节点。没有这个节点就补一个——
 * 片子出来了却在画布上看不见，跟没出来差不多；而进度带那一档（成片）认的正是这个节点。
 *
 * 合成要跑好几分钟，这期间用户照样在画布上改。所以：
 *   ① 写回那一刻才读盘（不用开跑时那份）；
 *   ② 只按 id 给开跑时算进计划的那几个剪辑节点打补丁，别的节点一个字段都不碰；
 *   ③ 那几个节点在合成期间被删掉了，就不再把它们变回来——片子路径还在 job 里，人删节点是他的决定。
 *      计划里本来就没有剪辑节点的，才补一个新的。
 */
function composeWriteBack(name, plan, job) {
  const state = canvasReadState(name || undefined, {});
  const patch = { video: job.output, ...(job.subtitled ? { subtitled: job.subtitled } : {}), ...(plan.outputs.srt && plan.srt ? { subtitle_file: plan.outputs.srt } : {}), shots: plan.shots.length, built_at: Date.now(), built_by: "画布一键合成" };
  const ids = new Set((Array.isArray(plan.timelineIds) ? plan.timelineIds : []).map(String));
  const hit = ids.size
    ? state.nodes.filter((n) => ids.has(String(n.id)))
    : state.nodes.filter((n) => String(n.kind) === "timeline");
  if (ids.size && !hit.length) return "剪辑节点在合成期间被删掉了，没再加回去；成片在 " + job.output;
  if (hit.length) { for (const n of hit) n.payload = { ...n.payload, ...patch }; }
  else {
    const xs = state.nodes.map((n) => Number(n.position && n.position.x) || 0);
    const ys = state.nodes.map((n) => Number(n.position && n.position.y) || 0);
    state.nodes.push({
      id: "tl_" + Date.now().toString(36), kind: "timeline",
      payload: { title: "最终剪辑", description: "画布一键合成出来的成片。", ...patch },
      position: { x: (xs.length ? Math.max(...xs) : 0) + 520, y: ys.length ? Math.round(ys.reduce((a, b) => a + b, 0) / ys.length) : 0 },
    });
  }
  canvasTickPast(state.updatedAt);
  canvasWriteState(state, name || undefined);
  return hit.length ? "更新了剪辑节点" : "画布上补了一个剪辑节点";
}

function composeView(job) {
  if (!job) return null;
  const { child, ...rest } = job;
  return { ...rest, running: !job.done };
}

// 同一个 Map 里住着两种任务：画布一键合成（没有 kind，老数据）和对话里 compose_video 起的时间轴成片
const kindOf = (job) => (job && job.kind) || "canvas";
const composeAborts = new Map();        // 任务 id → 眼下那一步渲染的 AbortController（渲染不是子进程，杀 child 杀不到它）

/**
 * 锁被另一种任务占着的时候交回去的那份。
 * 画布拿到 409 也会把 r.job 当成自己的任务接着画——id 留空它就不轮询，也就不会把别的会话的路径、日志摊在画布上
 */
function composeBusyView(job) {
  const what = kindOf(job) === "timeline" ? "时间轴成片" : "画布合成";
  return {
    id: "", busy: true, kind: kindOf(job), stage: job.stage || "", done: true, running: false,
    error: `另一条${what}正在跑，ffmpeg 同时只跑一条，等它跑完再来`, output: "", steps: [], log: [],
  };
}

/** 叫停：子进程发 TERM，正在渲染的那一步也掐掉 */
function cancelJob(job) {
  job.canceled = true;
  try { if (job.child) job.child.kill("SIGTERM"); } catch {}
  const ac = composeAborts.get(job.id);
  if (ac) { try { ac.abort(); } catch {} }
}

/**
 * 开跑一条。同时只跑一条：已经有一条没跑完，就把那一条交回去（busy），这一条不建。
 * composeExecute 要在拍快照之前起：它同步跑到第一步已经 spawn 出去，回给前端的那份才是「第 1 步在跑」
 */
function composeStart(name, plan, bin) {
  const running = composeJobs.get(composeBusy);
  if (running && !running.done) return { busy: kindOf(running) === "canvas" ? composeView(running) : composeBusyView(running) };
  const id = "cmp" + Date.now().toString(36);
  const job = {
    id, name, at: 0, total: plan.steps.length, startedAt: Date.now(), done: false, canceled: false,
    error: "", output: "", subtitled: "", subtitleFile: "", log: [], child: null,
    steps: plan.steps.map((s) => ({ key: s.key, label: s.label, out: s.out, state: "wait", ms: 0, note: "" })),
    outputs: plan.outputs, mode: plan.mode, etaMs: plan.etaMs,
  };
  composeJobs.set(id, job);
  composeBusy = id;
  // 只留最近几条。这是进度信息，不是账本
  for (const key of [...composeJobs.keys()].slice(0, -5)) { composeJobs.delete(key); composeDone.delete(key); composeAborts.delete(key); }
  composeExecute(job, plan, bin, name).catch((e) => { job.error = "合成中断：" + e.message; job.done = true; });
  return { job: composeView(job) };
}

/**
 * 叫停。已经跑完的、查无此条的原样交回去（null 也是一种回答），不报错。
 * 下面三个是画布那条路由的口子，只认画布自己的任务：对话里起的时间轴成片不归画布管，也不该被画布叫停
 */
function composeCancel(id) {
  const job = composeJobs.get(String(id));
  if (job && kindOf(job) !== "canvas") return null;
  if (!job || job.done) return composeView(job);
  cancelJob(job);
  return composeView(job);
}

/** 按 id 查一条；没有就是 null（服务重启过，或者被挤出最近那几条了） */
function composeGet(id) {
  const job = composeJobs.get(id);
  return job && kindOf(job) !== "canvas" ? null : composeView(job);
}

/** 眼下在跑的那一条；没有就是 null */
function composeRunning(kind = "canvas") {
  return composeView([...composeJobs.values()].find((j) => !j.done && kindOf(j) === kind)) || null;
}

// ── 时间轴成片（对话里的 compose_video）────────────────────────────────────────
// 计划在 lib/timeline-compose.js 里算好（纯函数、可单测），这里只管跑。跟画布一键合成共用同一个 Map、
// 同一把锁：ffmpeg 吃满 CPU，对话里起一条、画布上再点一条是真会发生的事，两条一起跑只会都慢

let tlSeq = 0;
const composeDone = new Map();          // 任务 id → 跑完（成了、挂了、叫停了）才 resolve 的 promise

/** ffmpeg stderr 里最后一个 time=00:00:03.20 → 秒；读不出来是 -1 */
function ffTimeSec(s) {
  const all = [...String(s).matchAll(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (!all.length) return -1;
  const m = all[all.length - 1];
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** 计划里的相对路径拼出来要是跑到工作区外面去了，就是空串：一个字节都不往外写，也不往外删 */
function insideCwd(cwd, rel) {
  if (!rel) return "";
  const root = path.resolve(cwd), abs = path.resolve(root, String(rel));
  const r = path.relative(root, abs);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? abs : "";
}

function fileSize(abs) { try { return fs.statSync(abs).size; } catch { return 0; } }

/**
 * 开跑一条时间轴成片。
 *   plan：timelinePlan 的返回（ok 为真的那种）；bin / probeBin：ffmpeg / ffprobe；cwd：计划里相对路径的根；
 *   owner：哪个会话起的——查、停只认它自己，别的会话连路径都看不到；
 *   hooks.render(step, signal, onFrac)：把 HTML 画成 PNG / mp4；hooks.onProgress(ev)；hooks.finish(job)。
 * 返回 {job, done}：done 在最后一步跑完（或挂了、被叫停）才 resolve 成最终那份。锁被占着就是 {busy}
 */
function startTimeline({ plan, bin, probeBin = "", cwd, env = null, owner = "", hooks = {} }) {
  if (!plan || !plan.ok || !Array.isArray(plan.steps)) return { error: "计划没排出来，不能开跑" };
  if (!bin) return { error: "没找到 ffmpeg" };
  if (!cwd) return { error: "不知道成片往哪写" };
  const running = composeJobs.get(composeBusy);
  if (running && !running.done) {
    const mine = kindOf(running) === "timeline" && String(running.owner || "") === String(owner || "");
    return { busy: mine ? composeView(running) : composeBusyView(running) };
  }
  const { PROGRESS_STAGE } = require("./timeline-compose");
  const id = "tlc" + Date.now().toString(36) + (++tlSeq).toString(36);
  const job = {
    id, kind: "timeline", owner: String(owner || ""), name: plan.title, at: 0, total: plan.steps.length,
    startedAt: Date.now(), done: false, canceled: false, error: "", output: "", outputs: [], films: [], covers: [],
    manifest: "", subtitleFile: "", bytes: 0, log: [], child: null,
    stage: "", stages: [...new Set(plan.steps.map((s) => PROGRESS_STAGE[s.stage] || "compose"))], pct: 0,
    steps: plan.steps.map((s) => ({ key: s.key, label: s.label, out: s.out, state: "wait", ms: 0, note: "" })),
    etaMs: plan.etaMs, outDir: plan.outDir, warnings: [...(plan.warnings || [])],
  };
  composeJobs.set(id, job);
  composeBusy = id;
  for (const key of [...composeJobs.keys()].slice(0, -5)) { composeJobs.delete(key); composeDone.delete(key); composeAborts.delete(key); }
  const done = composeExecuteTimeline(job, plan, bin, cwd, { hooks, env, probeBin, PROGRESS_STAGE })
    .catch((e) => { job.error = job.error || "合成中断：" + ((e && e.message) || e); })
    .then(() => { job.child = null; composeAborts.delete(id); job.done = true; return composeView(job); });
  composeDone.set(id, done);
  return { job: composeView(job), done };
}

/** 跑一步渲染（HTML → PNG / mp4）。渲染不是我们 spawn 的子进程，叫停和超时都靠 AbortController 递进去 */
async function timelineRender(job, step, hooks, onFrac) {
  if (typeof hooks.render !== "function") return { ok: false, note: "这一步要把 HTML 渲染成画面，但这里没有渲染器（要桌面版，或者本机装个 Chrome）" };
  const ac = new AbortController();
  composeAborts.set(job.id, ac);
  const timeoutMs = Math.max(180000, (step.expectSeconds || 0) * 20000);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { ac.abort(); } catch {} }, timeoutMs);
  try {
    await hooks.render(step, ac.signal, onFrac);
    return { ok: true };
  } catch (e) {
    if (timedOut) return { ok: false, note: `渲染超过 ${Math.round(timeoutMs / 1000)} 秒没完，掐掉了` };
    return { ok: false, note: "渲染没成：" + String((e && e.message) || e).slice(0, 300) };
  } finally { clearTimeout(timer); composeAborts.delete(job.id); }
}

async function composeExecuteTimeline(job, plan, bin, cwd, { hooks = {}, env = null, probeBin = "", PROGRESS_STAGE = {} } = {}) {
  /** 这一趟新建的文件和目录：失败了只收拾自己建的，用户原来的东西一个不碰 */
  const created = { files: [], dirs: [] };
  let ok = false;
  try {
    ok = await timelineSteps(job, plan, bin, cwd, { hooks, env, PROGRESS_STAGE, created });
    if (ok) ok = await timelineSettle(job, plan, cwd, probeBin, hooks);
  } catch (e) { job.error = job.error || "合成中断：" + ((e && e.message) || e); ok = false; }
  // 中间件（每段的片段、混好的声音、卡片）成不成都删：它们只对这一趟有用，留着就是一堆看不懂的文件
  // 只整个删这一趟自己建的：排片时已经绕开了盘上现有的 .work，这里再兜一道，别人的目录一个字节不碰
  for (const rel of plan.cleanup || []) {
    const abs = insideCwd(cwd, rel);
    if (abs && path.basename(abs).startsWith(".work") && created.dirs.includes(abs)) { try { fs.rmSync(abs, { recursive: true, force: true }); } catch {} }
  }
  if (ok) return;
  const kept = (plan.aspects || []).map((a) => a.file).filter((f) => fileSize(path.join(cwd, f)) > 0);
  if (kept.length) { job.log.push(`已经出好的成片留着：${kept.join("、")}`); return; }
  // 一条成片都没出来：连字幕文件、空目录一起收掉，不然盘上躺着一个只有 .srt 的「成片」文件夹
  for (const abs of created.files) { try { fs.unlinkSync(abs); } catch {} }
  for (const abs of created.dirs.slice().reverse()) { try { fs.rmdirSync(abs); } catch {} }
}

async function timelineSteps(job, plan, bin, cwd, { hooks, env, PROGRESS_STAGE, created }) {
  const root = path.resolve(cwd);
  for (const rel of plan.dirs || []) {
    const abs = insideCwd(cwd, rel);
    if (!abs) { job.error = `输出目录 ${rel} 在工作区外面，不往那儿写`; return false; }
    const chain = [];
    for (let p = abs; p !== root && !fs.existsSync(p); p = path.dirname(p)) chain.push(p);
    created.dirs.push(...chain.reverse());
    try { fs.mkdirSync(abs, { recursive: true }); } catch (e) { job.error = `建不了目录 ${rel}：${e.message}`; return false; }
  }
  const n = plan.steps.length;
  const totalSec = Math.max(0.001, plan.steps.reduce((x, s) => x + (s.expectSeconds || 0), 0));
  let doneSec = 0;
  // 进度按每一步的预估秒数加权：一条 30 秒的合成和一张封面不该各占一格。封顶 99，只增不减——
  // 100 留给文件真的认完账那一刻
  const report = (i, frac, label) => {
    const step = plan.steps[i];
    const f = Math.max(0, Math.min(1, Number(frac) || 0));
    const pct = Math.min(99, Math.floor(((doneSec + (step ? step.expectSeconds || 0 : 0) * f) / totalSec) * 100));
    if (pct > job.pct) job.pct = pct;
    if (typeof hooks.onProgress === "function") { try { hooks.onProgress({ stage: job.stage, done: i, total: n, pct: job.pct, label }); } catch {} }
  };
  const unburned = new Set();
  job.fallbacks = [];
  for (let i = 0; i < n; i++) {
    const step = plan.steps[i], slot = job.steps[i];
    if (job.canceled) { slot.state = "skip"; continue; }
    job.at = i + 1;
    job.stage = PROGRESS_STAGE[step.stage] || "compose";
    slot.state = "run";
    report(i, 0, step.label);
    try {
      for (const w of step.writes || []) {
        const abs = insideCwd(cwd, w.rel);
        if (!abs) throw new Error(`${w.rel} 在工作区外面`);
        const existed = fs.existsSync(abs);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, w.text, "utf8");
        if (!existed) created.files.push(abs);
        if (w.rel === plan.srt) job.subtitleFile = w.rel;
      }
    } catch (e) { slot.state = "fail"; slot.note = "写不进工作区：" + e.message; job.error = `${slot.label} 没成——${slot.note}`; return false; }
    const started = Date.now();
    let r;
    if (step.kind === "render") {
      r = await timelineRender(job, step, hooks, (frac) => report(i, frac, step.label));
    } else {
      const onErr = step.mediaSeconds > 0 ? (s) => { const t = ffTimeSec(s); if (t >= 0) report(i, t / step.mediaSeconds, step.label); } : null;
      const timeoutMs = Math.max(120000, (step.expectSeconds || 0) * 20000);
      r = await composeRun(job, bin, cwd, step.argv, (c) => { job.child = c; }, { env, onErr, timeoutMs });
      if (!r.ok && step.fallback && !job.canceled) {
        slot.note = step.fallbackWhy || "第一条路没走通，换一条再试";
        job.log.push(`${slot.label}：${slot.note}`);
        r = await composeRun(job, bin, cwd, step.fallback, (c) => { job.child = c; }, { env, onErr, timeoutMs });
        if (r.ok && step.aspect) { unburned.add(step.aspect); job.fallbacks.push({ aspect: step.aspect, why: slot.note }); slot.note += "（换过之后成了）"; }
      }
      job.child = null;
    }
    slot.ms = Date.now() - started;
    if (r.ok) {
      // 退出码 0 也得看东西在不在：磁盘满、被杀在半路，都可能留下一个 0 字节的壳
      const size = fileSize(path.join(cwd, step.out));
      if (size > 0) { slot.state = "done"; slot.size = size; doneSec += step.expectSeconds || 0; continue; }
      slot.state = "fail";
      slot.note = `${step.kind === "render" ? "渲染器" : "ffmpeg"}说成了，但 ${step.out} 没在盘上（或者是 0 字节）`;
    } else if (job.canceled) { slot.state = "skip"; composeDropPartial(cwd, step.out, job); continue; }
    else {
      const tail = String(r.err || "").split("\n").filter((l) => l.trim()).slice(-4).join("\n");
      slot.state = "fail";
      slot.note = r.note || ((r.timedOut ? "跑太久被掐掉了" : r.signal ? `被中断（${r.signal}）` : `ffmpeg 退出码 ${r.code}`) + (tail ? "：" + tail : ""));
    }
    composeDropPartial(cwd, step.out, job);
    // 封面这种可有可无的：没截出来记一笔就往下走，成片本身不受影响
    if (step.optional) { job.log.push(`${slot.label}：${step.optionalWhy || "这一步没成，跳过"}`); slot.state = "skip"; doneSec += step.expectSeconds || 0; continue; }
    // 不自动整条重跑：ffmpeg 挂在哪一步、自己说了什么都在这儿，重跑一遍多半还是同一句
    job.error = `${slot.label} 没成——${slot.note}`;
    return false;
  }
  if (job.canceled) { job.error = "你叫停了。已经出好的成片留着，没出完的半截删掉了"; return false; }
  job.unburned = [...unburned];
  return true;
}

/** 认账：每条成片真的在盘上、再探一次真实尺寸和时长，才写清单、才说出来了 */
async function timelineSettle(job, plan, cwd, probeBin, hooks) {
  const unburned = new Set(job.unburned || []);
  const films = [];
  for (const a of plan.aspects || []) {
    const bytes = fileSize(path.join(cwd, a.file));
    if (!bytes) { job.error = `每一步都跑完了，但 ${a.file} 不在盘上——这次不算成片`; return false; }
    const p = await composeProbe(probeBin, cwd, a.file);
    films.push({
      aspect: a.aspect, label: a.label, file: a.file, bytes, burned: !!a.burned && !unburned.has(a.aspect),
      // 探不到就照计划写，并且说一句：清单里的数是量出来的还是算出来的，要分得清
      w: p && p.w ? p.w : a.w, h: p && p.h ? p.h : a.h,
      duration: p && p.dur ? Math.round(p.dur * 1000) / 1000 : Number(plan.T) || 0, probed: !!(p && p.dur),
    });
  }
  const runtimeWarn = [];
  if (films.some((f) => !f.probed)) runtimeWarn.push("没探到成片的真实时长和尺寸（ffprobe 不在或探挂了），清单里写的是计划值");
  for (const f of job.fallbacks || []) if (!runtimeWarn.includes(f.why)) runtimeWarn.push(f.why);
  const draft = plan.manifestDraft || {};
  const coversByKey = {};
  const covers = [];
  for (const [key, list] of Object.entries(draft.covers || {})) {
    coversByKey[key] = (list || []).filter((c) => fileSize(path.join(cwd, c)) > 0);
    covers.push(...coversByKey[key]);
  }
  const manifest = {
    ...draft,
    aspects: films.map((f) => ({ aspect: f.aspect, file: f.file, w: f.w, h: f.h, duration: f.duration, burned: f.burned })),
    covers: coversByKey,
    warnings: [...(draft.warnings || []), ...runtimeWarn],
  };
  const mAbs = insideCwd(cwd, plan.manifest);
  if (mAbs) {
    try { fs.writeFileSync(mAbs, JSON.stringify(manifest, null, 2) + "\n", "utf8"); job.manifest = plan.manifest; }
    catch (e) { job.log.push("成片好了，但清单没写进去：" + e.message); }
  }
  const sidecars = [];
  if (plan.srt && fileSize(path.join(cwd, plan.srt)) > 0) { job.subtitleFile = plan.srt; sidecars.push(plan.srt); }
  for (const a of plan.aspects || []) if (a.ass && fileSize(path.join(cwd, a.ass)) > 0) sidecars.push(a.ass);
  job.films = films.map(({ probed, ...f }) => f);
  job.covers = covers;
  job.output = films[0] ? films[0].file : "";
  job.outputs = [...films.map((f) => f.file), ...sidecars, ...covers, ...(job.manifest ? [job.manifest] : [])];
  job.bytes = films.reduce((x, f) => x + f.bytes, 0);
  job.warnings = [...job.warnings, ...runtimeWarn.filter((w) => !job.warnings.includes(w))];
  job.pct = 100;
  job.at = job.total;
  if (typeof hooks.onProgress === "function") { try { hooks.onProgress({ stage: job.stage || "compose", done: job.total, total: job.total, pct: 100, label: "成片出来了" }); } catch {} }
  if (typeof hooks.finish === "function") { try { await hooks.finish(job); } catch (e) { job.log.push("成片好了，收尾那一步没成：" + e.message); } }
  return true;
}

/** 按 id 查一条时间轴成片。别的会话起的、画布的，一律当没有 */
function timelineGet(id, owner = "") {
  const job = composeJobs.get(String(id || ""));
  if (!job || kindOf(job) !== "timeline" || job.owner !== String(owner || "")) return null;
  return composeView(job);
}

/** 叫停自己会话起的那条；已经跑完的原样交回 */
function timelineCancel(id, owner = "") {
  const job = composeJobs.get(String(id || ""));
  if (!job || kindOf(job) !== "timeline" || job.owner !== String(owner || "")) return null;
  if (!job.done) cancelJob(job);
  return composeView(job);
}

/** 这个会话眼下在跑的那条时间轴成片 */
function timelineRunning(owner = "") {
  return composeView([...composeJobs.values()].find((j) => !j.done && kindOf(j) === "timeline" && j.owner === String(owner || ""))) || null;
}

/** 等一条跑完，最多等 ms 毫秒（signal 断了也不等了）。返回跑没跑完 */
async function timelineWait(id, ms, { signal = null } = {}) {
  const p = composeDone.get(String(id || ""));
  const job = composeJobs.get(String(id || ""));
  if (!p || !job) return true;
  if (job.done) return true;
  let timer = null, onAbort = null;
  await Promise.race([
    p,
    new Promise((resolve) => {
      timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
      if (signal) { onAbort = resolve; if (signal.aborted) resolve(); else signal.addEventListener("abort", onAbort, { once: true }); }
    }),
  ]);
  clearTimeout(timer);
  if (signal && onAbort) { try { signal.removeEventListener("abort", onAbort); } catch {} }
  return !!job.done;
}

/**
 * deps：getWorkspaceDir / outputFiles / safePath / shellPath / canvasReadState / canvasWriteState 来自 tools.js；
 * assetBase / canvasAssetLocator / canvasAssetNear / canvasTickPast 来自 routes/canvas.js。
 */
function createComposeJobs(deps) {
  ({ getWorkspaceDir, outputFiles, safePath, shellPath, canvasReadState, canvasWriteState, assetBase, canvasAssetLocator, canvasAssetNear, canvasTickPast } = deps);
  return { plan: composeBuildPlan, start: composeStart, cancel: composeCancel, get: composeGet, running: composeRunning, startTimeline };
}

module.exports = { createComposeJobs, composeBins, composeProbe, startTimeline, timelineGet, timelineCancel, timelineRunning, timelineWait };
