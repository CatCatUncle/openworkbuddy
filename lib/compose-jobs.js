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

async function composeBins() {
  const { resolveBin } = require("../engines/which");
  const { knownTool } = require("../doctor");
  let ffmpeg = "", ffprobe = "";
  try { ffmpeg = (await resolveBin("ffmpeg")).bin || ""; } catch {}
  try { ffprobe = (await resolveBin("ffprobe")).bin || ""; } catch {}
  const filters = await composeFilterSet(ffmpeg);
  return {
    ffmpeg, ffprobe, install: (knownTool("ffmpeg") || {}).install || "",
    burn: filters.has("subtitles"),
    duck: filters.has("sidechaincompress"),   // 说话的时候把配乐自动压下去
    limiter: filters.has("alimiter"),         // 混完限个幅，人声乘 2 之后不至于削顶
  };
}

/** 探一个文件：多长、多大画幅、什么编码。探不到就返回 null——宁可没有，也不编一个 */
function composeProbe(bin, cwd, rel) {
  return new Promise((resolve) => {
    if (!bin) return resolve(null);
    require("child_process").execFile(bin, [
      "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,pix_fmt:format=duration", "-of", "json", rel,
    ], { cwd, timeout: 20000, maxBuffer: 1 << 20, env: { ...process.env, PATH: shellPath() } }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout || "{}");
        const v = (j.streams || []).find((s) => s.codec_type === "video") || null;
        const fr = v && String(v.avg_frame_rate || "").split("/");
        const fps = fr && fr.length === 2 && Number(fr[1]) ? Number(fr[0]) / Number(fr[1]) : 0;
        resolve({
          dur: Number((j.format || {}).duration) || 0,
          w: v ? Number(v.width) || 0 : 0, h: v ? Number(v.height) || 0 : 0,
          fps: Number.isFinite(fps) ? Math.round(fps) : 0, vcodec: v ? String(v.codec_name || "") : "",
          // 帧率和像素格式也得探：这两样不一致，直拼出来是「退出码 0、文件也在、
          // 就是时长少了大半截」——实测 30fps + 25fps 两段各 2 秒，拼出来只有 3.33 秒
          pix: v ? String(v.pix_fmt || "") : "",
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

/** 一条 ffmpeg 命令。stderr 全留着——出事的时候，ffmpeg 自己那句话比我们转述的准 */
function composeRun(job, bin, cwd, argv, onChild) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = require("child_process").spawn(bin, argv, { cwd, env: { ...process.env, PATH: shellPath() } });
    onChild(child);
    let err = "";
    child.stderr.on("data", (d) => { err = (err + d).slice(-8000); });
    child.on("error", (e) => resolve({ ok: false, ms: Date.now() - started, err: `跑不起来：${e.message}` }));
    child.on("close", (code, signal) => resolve({ ok: code === 0, code, signal, ms: Date.now() - started, err }));
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

/**
 * 开跑一条。同时只跑一条：已经有一条没跑完，就把那一条交回去（busy），这一条不建。
 * composeExecute 要在拍快照之前起：它同步跑到第一步已经 spawn 出去，回给前端的那份才是「第 1 步在跑」
 */
function composeStart(name, plan, bin) {
  const running = composeJobs.get(composeBusy);
  if (running && !running.done) return { busy: composeView(running) };
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
  for (const key of [...composeJobs.keys()].slice(0, -5)) composeJobs.delete(key);
  composeExecute(job, plan, bin, name).catch((e) => { job.error = "合成中断：" + e.message; job.done = true; });
  return { job: composeView(job) };
}

/** 叫停。已经跑完的、查无此条的原样交回去（null 也是一种回答），不报错 */
function composeCancel(id) {
  const job = composeJobs.get(String(id));
  if (!job || job.done) return composeView(job);
  job.canceled = true;
  try { if (job.child) job.child.kill("SIGTERM"); } catch {}
  return composeView(job);
}

/** 按 id 查一条；没有就是 null（服务重启过，或者被挤出最近那几条了） */
function composeGet(id) {
  return composeView(composeJobs.get(id));
}

/** 眼下在跑的那一条；没有就是 null */
function composeRunning() {
  return composeView([...composeJobs.values()].find((j) => !j.done)) || null;
}

/**
 * deps：getWorkspaceDir / outputFiles / safePath / shellPath / canvasReadState / canvasWriteState 来自 tools.js；
 * assetBase / canvasAssetLocator / canvasAssetNear / canvasTickPast 来自 routes/canvas.js。
 */
function createComposeJobs(deps) {
  ({ getWorkspaceDir, outputFiles, safePath, shellPath, canvasReadState, canvasWriteState, assetBase, canvasAssetLocator, canvasAssetNear, canvasTickPast } = deps);
  return { plan: composeBuildPlan, start: composeStart, cancel: composeCancel, get: composeGet, running: composeRunning };
}

module.exports = { createComposeJobs };
