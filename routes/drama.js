"use strict";
/**
 * 短剧分镜表路由：/api/drama/storyboard(s)（读、整份存、剧本拆草稿、草稿落盘、单格回写）和
 * /api/drama/shot-history/*（一镜一镜的版本留底与恢复）。从 server.js 原样搬出来的，URL、状态码、返回体一个字没动。
 * 顶层登记、路由器变量叫 app、依赖做成模块级变量的缘故见 routes/canvas.js 开头。
 */
const fs = require("fs");
const path = require("path");
const express = require("express");
const dramaPipeline = require("../drama-pipeline");
const shotHistory = require("../shot-history"); // 一镜一镜的版本留底：改台词重跑之后，上一版首帧还拿得回来
const store = require("../store");

// 下面这几个由 createDramaRouter(deps) 填上
let getWorkspaceDir, outputFiles, safePath, account, org, budget, llm, llmForSession, addUsage, toolRunSubdir, toolRunSubdirReady, canvasAssetNear;

// 大小写敏感跟 server.js 一致：子路由器不继承外面那个 case sensitive routing 的设置
const app = express.Router({ caseSensitive: true });

// ---------- AI 短剧分镜表 / 无限画布 ----------
// 画布只读/回写分镜表，不另造一份数据库。这样命令行技能、画布和下一次会话看到的始终
// 是同一份 JSON；镜头单格重跑产生的路径也会立刻回到唯一真源里。
const DRAMA_JSON_MAX = 4 * 1024 * 1024;
function dramaName(raw) {
  const name = String(raw || "").replace(/\\/g, "/").trim();
  if (!name || !/\.json$/i.test(name) || name.split("/").includes("..") || name.startsWith("/")) return "";
  return name;
}
function dramaSummary(name, data, stat) {
  const scenes = Array.isArray(data && data.scenes) ? data.scenes : [];
  const shots = scenes.reduce((n, s) => n + (Array.isArray(s && s.shots) ? s.shots.length : 0), 0);
  return {
    name, title: String((data && data.title) || name.replace(/\.json$/i, "")),
    aspect: String((data && data.aspect) || "9:16"), scenes: scenes.length, shots,
    size: stat ? stat.size : 0, mtime: stat ? stat.mtimeMs : 0,
  };
}
function readDramaJson(name) {
  const rel = dramaName(name);
  if (!rel) throw new Error("分镜表文件名不合法（只允许工作区内的 .json 文件）");
  const p = safePath(rel);
  if (!fs.existsSync(p)) throw new Error("分镜表不存在：" + rel);
  const stat = fs.statSync(p);
  if (!stat.isFile() || stat.size > DRAMA_JSON_MAX) throw new Error("分镜表不是普通文件，或超过 4MB 上限");
  let data;
  try { data = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { throw new Error("分镜表不是合法 JSON：" + rel); }
  if (!data || typeof data !== "object" || !Array.isArray(data.scenes)) throw new Error("这不是可识别的分镜表：缺少 scenes 数组");
  return { rel, p, stat, data };
}
app.get("/api/drama/storyboards", (_req, res) => {
  try {
    const rows = outputFiles().filter((f) => /(?:分镜表|storyboard|shotlist)[^/]*\.json$/i.test(f.name));
    const out = [];
    for (const f of rows) {
      try {
        const r = readDramaJson(f.name);
        out.push(dramaSummary(r.rel, r.data, r.stat));
      } catch {}
    }
    res.json({ storyboards: out });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get("/api/drama/storyboard", (req, res) => {
  try {
    const r = readDramaJson(req.query.name);
    res.json({ name: r.rel, data: r.data, summary: dramaSummary(r.rel, r.data, r.stat) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put("/api/drama/storyboard", async (req, res) => {
  try {
    const rel = dramaName(req.body && req.body.name);
    const data = req.body && req.body.data;
    if (!rel || !data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.scenes)) {
      return res.status(400).json({ error: "缺少合法的分镜表 name / data.scenes" });
    }
    const raw = JSON.stringify(data, null, 2) + "\n";
    if (Buffer.byteLength(raw) > DRAMA_JSON_MAX) return res.status(400).json({ error: "分镜表超过 4MB 上限" });
    const p = safePath(rel);
    const kept = dramaSnapshotDiff(rel, data, "整份保存之前", String((req.body || {}).session || ""));
    await fs.promises.writeFile(p, raw, "utf8");
    res.json({ ok: true, name: rel, summary: dramaSummary(rel, data, fs.statSync(p)), snapshots: kept.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * 剧本 → 分镜表草稿。画布上「生成分镜表」那个按钮打的就是它。
 *
 * 只出草稿、不落盘：草稿要先给人看、给人改，拍板了才走下面的 commit 落成分镜表。
 * 直接写盘的话，模型拆坏的一版会先把画布旁边那份真源盖掉，人还没看过一眼。
 *
 * 用的是用户当前配置的对话模型（请求里带了 model 就用那一条；那条被删了就报错，不悄悄换一个跑）。
 * 模型回了坏 JSON / 不合 schema 的，把错处告诉它再要一次；还是坏的就 422——
 * 最多两次调用，再多就是替用户花冤枉钱。提示词、解析、校验都在 drama-pipeline.js（纯函数，可单测）。
 */
const STORYBOARD_SCRIPT_MAX = 20000;
const STORYBOARD_STYLE_MAX = 300;
const STORYBOARD_LLM_TIMEOUT_MS = 180000;
app.post("/api/drama/storyboard/draft", async (req, res) => {
  const body = req.body || {};
  const script = typeof body.script === "string" ? body.script.trim() : "";
  if (!script || dramaPipeline._internals.isPlaceholder(script) || script.length < dramaPipeline._internals.SCRIPT_MIN) {
    return res.status(400).json({ error: `剧本至少要 ${dramaPipeline._internals.SCRIPT_MIN} 个字，才拆得出场次和镜头` });
  }
  if (script.length > STORYBOARD_SCRIPT_MAX) return res.status(400).json({ error: `剧本超过 ${STORYBOARD_SCRIPT_MAX} 字，分几段来拆` });
  const aspect = body.aspect == null || body.aspect === "" ? "9:16" : String(body.aspect);
  if (!dramaPipeline.STORYBOARD_ASPECTS.includes(aspect)) return res.status(400).json({ error: "aspect 只能是 " + dramaPipeline.STORYBOARD_ASPECTS.join(" / ") });
  if (body.style != null && typeof body.style !== "string") return res.status(400).json({ error: "style 要是一段文字" });
  const style = String(body.style || "").trim();
  if (style.length > STORYBOARD_STYLE_MAX) return res.status(400).json({ error: `画风描述超过 ${STORYBOARD_STYLE_MAX} 字` });
  const shotSeconds = body.shotSeconds == null || body.shotSeconds === "" ? 5 : Number(body.shotSeconds);
  if (!Number.isFinite(shotSeconds) || shotSeconds < 1 || shotSeconds > 60) return res.status(400).json({ error: "shotSeconds 要是 1 到 60 之间的秒数" });
  if (body.canvas != null && typeof body.canvas !== "string") return res.status(400).json({ error: "canvas 要是画布名" });
  // 画布名只拿来给模型当片名的候选；默认画布叫 main，那不是片名
  const canvas = String(body.canvas || "").trim().slice(0, 80);
  const titleHint = canvas && canvas !== "main" ? canvas : "";
  if (body.model != null && (typeof body.model !== "string" || !body.model.trim())) return res.status(400).json({ error: "model 要是模型列表里的一个名字" });

  const user = req.user; // authGuard 已挂上
  // 两道闸跟 /api/chat 一样：积分和钱。这一下是真调模型、真花钱的
  if (user && account.creditsEnabled(user) && account.balanceOf(user) <= 0) {
    return res.status(402).json({ error: "用量不足，这次没调模型。找管理员在企业后台充值，或者把「用量限额」关掉。" });
  }
  if (user) {
    try {
      const o = org.getOrg(org.orgIdOf(user));
      const hit = budget.exhausted({ org: org.settingsOf(o), orgId: o.id, user });
      if (hit) return res.status(402).json({ error: `${hit.message}预算由管理员在「企业管理 → API 中转站」里设，每月 1 号重置。` });
    } catch (e) {
      console.warn("[预算] 钱闸没能判（本次放行）：" + (e && e.message));
    }
  }

  const runLLM = body.model ? llmForSession({ model: body.model.trim() }) : llm;
  const { system, prompt } = dramaPipeline.buildStoryboardPrompt({ script, style, aspect, shotSeconds, title: titleHint });
  // 请求断了就别再等模型（挂在 res 的 close 上：Node 新版里请求体一读完 req 就发 close）
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, STORYBOARD_LLM_TIMEOUT_MS);
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  const total = { prompt: 0, completion: 0, cached: 0, calls: 0, elapsed_ms: 0 };
  let draft = null, warnings = [], errors = [], cut = false;
  try {
    for (let attempt = 0; attempt < 2 && !draft; attempt++) {
      // 第二次把上一次的错处列给它，不把坏的那段原文再喂回去：那是白付一遍输入的钱。
      // 上一次是写到长度上限被截断的（cut 还是上一轮的），原样再要一遍只会在同一个地方再断一次，得让它写短
      const ask = attempt === 0 ? prompt
        : prompt + "\n\n上一次的输出没法用：" + errors.slice(0, 12).join("；") + "。"
          + (cut ? "上一次写到长度上限被截断了，每镜的 frame_prompt、motion_prompt 各写一句，写短些。" : "")
          + "重新输出完整的分镜表，只输出 JSON。";
      const t0 = Date.now();
      const r = await runLLM.chat({ system, history: [{ role: "user", content: ask }], tools: [], signal: ac.signal });
      addUsage(total, { ...(r.usage || {}), elapsed_ms: Date.now() - t0 });
      cut = /^(length|max_tokens)$/.test(String(r.stopReason || ""));
      const parsed = dramaPipeline.parseStoryboardReply(r.text);
      if (!parsed.ok) { errors = [parsed.error]; continue; }
      const norm = dramaPipeline.normalizeStoryboardDraft(parsed.data, { aspect, style, shotSeconds, title: titleHint });
      const v = dramaPipeline.validateStoryboard(norm.data);
      if (!v.ok) { errors = v.errors; continue; }
      draft = norm.data;
      warnings = [...norm.warnings, ...v.warnings];
    }
  } catch (e) {
    clearTimeout(timer);
    chargeStoryboardDraft(user, total, runLLM);
    if (res.writableEnded || res.destroyed) return;
    if (timedOut) return res.status(504).json({ error: `模型 ${STORYBOARD_LLM_TIMEOUT_MS / 1000} 秒没出完，这次没出草稿` });
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
  clearTimeout(timer);
  const usage = { ...total, model: runLLM.model, provider: runLLM.provider, credits: chargeStoryboardDraft(user, total, runLLM) };
  if (res.writableEnded || res.destroyed) return;
  if (!draft) {
    // 只报看得见的事实：截断是上游回的 stop 原因，不是猜的
    const why = cut ? "模型输出到了长度上限被截断，" : "";
    return res.status(422).json({ error: `模型连着两次没给出合格的分镜表，${why}这次没出草稿`, errors: errors.slice(0, 30), usage });
  }
  res.json({ draft, warnings, usage });
});
/** 草稿这一趟调了几次模型就记几次账。记账坏了不挡正事（account.chargeRun 那头同一个口径） */
function chargeStoryboardDraft(user, total, runLLM) {
  if (!user || !total.calls) return 0;
  try { return account.chargeRun(user, { ...total, model: runLLM.model, provider: runLLM.provider, source: "web" }) || 0; }
  catch (e) { console.warn("[分镜草稿] 记账失败：" + (e && e.message)); return 0; }
}

/**
 * 草稿 → 分镜表。人在画布上看过、改过草稿之后，拍板落盘走这里。
 *
 * 落到哪：默认是这张画布的产物目录里那份「短剧/<画布名>/分镜表.json」——跟画布生图生视频落的是同一个目录，
 * 分镜表里的相对路径也就对得上。给了 name 就写那份（画布上的分镜表节点本来就指着某一份）。
 *
 * 三种 mode，盘上已经有一份时是三种不同的后果，所以不替人挑：
 *   new     —— 盘上已经有了就 409，把现有那份的概况带回去，让人选追加还是替换；
 *   append  —— 接在原表后面，撞号的换号（见 drama-pipeline 的 mergeStoryboard）；
 *   replace —— 整份换掉。换之前每一镜、每个角色先拍一张快照（shot-history），首帧视频的字节一起留底，
 *              换错了能一镜一镜找回来。
 * baseUpdatedAt：我是照着盘上哪一版（分镜表文件的 mtime，409 回执里的 updatedAt）拍的板。
 * 盘上已经不是那一版（别的标签页、Agent、命令行改过）就 409，不拿旧眼光把新改动盖掉。不给就不查。
 */
app.post("/api/drama/storyboard/commit", (req, res) => {
  try {
    const body = req.body || {};
    const mode = String(body.mode || "");
    if (!["new", "append", "replace"].includes(mode)) return res.status(400).json({ error: "mode 只能是 new / append / replace" });
    const draft = body.draft;
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) return res.status(400).json({ error: "缺少分镜表草稿 draft" });
    if (Buffer.byteLength(JSON.stringify(draft)) > DRAMA_JSON_MAX) return res.status(400).json({ error: "分镜表超过 4MB 上限" });
    const v = dramaPipeline.validateStoryboard(draft);
    if (!v.ok) return res.status(400).json({ error: "草稿不合分镜表格式：" + v.errors.slice(0, 3).join("；"), errors: v.errors });

    // 落点：name 优先，没给就按画布名算。画布名的口径跟 canvasAssetNear / 前端 canvasOutputSubdir 一样
    let rel;
    if (body.name != null && body.name !== "") {
      rel = dramaName(body.name);
      if (!rel) return res.status(400).json({ error: "分镜表文件名不合法（只允许工作区内的 .json 文件）" });
    } else {
      if (body.canvas != null && typeof body.canvas !== "string") return res.status(400).json({ error: "canvas 要是画布名" });
      const near = canvasAssetNear(body.canvas || "main");
      if (near.includes("..") || /[\0-\x1f\x7f]/.test(near)) return res.status(400).json({ error: "画布名里有 .. 或控制字符，按它建不了目录；用 name 指定分镜表路径" });
      rel = near + "/分镜表.json";
    }
    const dirAbs = toolRunSubdir(path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel));
    const p = safePath(rel);
    let prev = null;
    if (fs.existsSync(p)) {
      // 符号链接不认：往链接上写，写到的是工作区外面那份
      if (fs.lstatSync(p).isSymbolicLink()) return res.status(400).json({ error: "分镜表是个符号链接，不往上写：" + rel });
      try { prev = readDramaJson(rel); }
      catch (e) {
        // 读不出来就留不了底。new 照样按「已存在」拦；追加和替换都会把这份盖掉，不做
        if (mode === "new") return res.status(409).json({ exists: true, name: rel, updatedAt: fs.statSync(p).mtimeMs, error: "这个位置已经有一份分镜表了：" + rel });
        return res.status(400).json({ error: "盘上那份分镜表读不出来，留不了底，这次不写：" + e.message });
      }
    }
    const nowAt = prev ? prev.stat.mtimeMs : 0;
    if (prev && mode === "new") {
      return res.status(409).json({ exists: true, name: rel, updatedAt: nowAt, summary: dramaSummary(rel, prev.data, prev.stat), error: "这张画布已经有分镜表了，选追加还是替换" });
    }
    const base = body.baseUpdatedAt;
    if (mode !== "new" && base != null && base !== "") {
      const n = Number(base);
      // 容 1ms：mtime 带小数，前端拿去四舍五入过也还认得出是同一版
      if (!Number.isFinite(n) || Math.abs(n - nowAt) >= 1) {
        return res.status(409).json({ conflict: true, name: rel, updatedAt: nowAt, ...(prev ? { summary: dramaSummary(rel, prev.data, prev.stat) } : {}), error: "分镜表在你打开之后被改过了，重新读一次再提交" });
      }
    }

    let next = draft, warnings = [...v.warnings], kept = [];
    if (prev && mode === "append") {
      const m = dramaPipeline.mergeStoryboard(prev.data, draft);
      next = m.data;
      warnings = warnings.concat(m.warnings);
    }
    const raw = JSON.stringify(next, null, 2) + "\n";
    if (Buffer.byteLength(raw) > DRAMA_JSON_MAX) return res.status(400).json({ error: "分镜表超过 4MB 上限" });
    // 替换之前先留底。追加不动原表里任何一镜，不用拍
    if (prev && mode === "replace") kept = dramaSnapshotDiff(rel, next, "替换分镜表之前", String(body.session || ""));
    if (dirAbs) toolRunSubdirReady(dirAbs);
    store.writeTextAtomic(p, raw, { backup: false });
    const stat = fs.statSync(p);
    res.json({ ok: true, name: rel, mode, created: !prev, data: next, summary: dramaSummary(rel, next, stat), updatedAt: stat.mtimeMs, snapshots: kept.length, warnings });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

/**
 * 画布上生成出来的产物，回到分镜表里。
 *
 * 分镜表是唯一真源（技能里原话：「产物路径全部回写进分镜表——它是下次改一镜重跑的依据」），
 * 可画布一直只读不写。在画布上把十二镜的首帧和视频全生出来之后，盘上那份分镜表还是空的。
 * 后果不是「两个页面显示得不一样」，是钱和一致性：
 *   · 短剧页每张卡片都还写着「暂无首帧」，人照着点「重跑首帧」——十二镜再买一遍
 *     （那条路上 no_cache 是关着缓存的，一分钱都省不下）；
 *   · 命令行和 Agent 那条「改一镜只重算一镜」读的也是这份 JSON，它看到的是一部什么都没开工的戏；
 *   · 角色的定妆照落不进 characters[].ref，短剧页那头重跑首帧就没有参考图，人一镜一个样。
 *
 * 为什么不直接复用上面那条整份 PUT：
 *   · 整份写回会把人在短剧页刚改的那几笔一起盖掉——画布这边手里是展开那一刻的旧副本；
 *   · 十二镜几乎同时生完，就是十二次「读-改-写」互相踩，最后只剩一个字段活下来。
 * 所以这条只认「哪一镜的哪个字段」，落盘的也只有那一个字段，读和写之间不许有 await
 * （同步读同步写，两个请求就挤不进彼此中间）。
 */
/**
 * 这条接口收哪些字段。分三档是因为它们的「空」不是一回事：
 *   must   —— 必须非空。产物路径写成空串等于把已经买到手的东西抹掉；
 *             shot_size / frame_prompt / motion_prompt 在 schema 里是 required，空着下一步根本没法跑。
 *   text   —— 可以为空。台词空着就是无人声镜头，音色空着就是用设置里的默认音色。
 *   number —— 时长。schema 里它是 number，写成字符串整份分镜表就不合法了，
 *             下次读这份表的人会收到一句「这不是可识别的分镜表」。
 *
 * 为什么提示词也收进来：画布上改了一镜的提示词不回表，从命令行或短剧页重跑的还是老那句——
 * 而且参数变了缓存命不中，等于花钱买一张**老提示词**的图，把刚才改好的那张盖掉。
 * id 永远不在这儿：它是定位用的钥匙，改它得去分镜表里改。
 */
const DRAMA_OUTPUT_FIELDS = {
  shot: {
    first_frame: "must", last_frame: "must", video: "must", audio: "must",
    shot_size: "must", frame_prompt: "must", motion_prompt: "must",
    // note 是短剧页重跑那一格写的流水（「首帧已重跑」）。以前那里走的是整份 PUT，
    // 写回去的是打开页面那一刻的副本——中间画布上生的十二笔会被这一次重跑连带抹掉
    line: "text", speaker: "text", note: "text", duration: "number",
    // cast 是画布上连出来的：连一根线多一个人。它不是装饰——这一镜出图时按 cast 去取谁的定妆照当参考图。
    // 画布上连了两个人、表里还写着一个人，重跑这一镜只带一张参考图，第二个人当场换一张脸
    cast: "list",
  },
  character: { ref: "must", name: "must", look: "must", voice: "text" },
};
app.post("/api/drama/storyboard/output", (req, res) => {
  try {
    const body = req.body || {};
    const fields = body.fields && typeof body.fields === "object" && !Array.isArray(body.fields) ? body.fields : null;
    if (!fields) return res.status(400).json({ error: "缺少要回写的 fields" });
    const shotId = String(body.shot || "").trim(), charId = String(body.character || "").trim();
    if (!shotId && !charId) return res.status(400).json({ error: "要回写到哪一镜或哪个角色：shot / character 至少给一个" });
    if (shotId && charId) return res.status(400).json({ error: "shot 和 character 只能给一个" });
    const target = shotId ? "shot" : "character";
    const allowed = DRAMA_OUTPUT_FIELDS[target];
    const keys = Object.keys(fields);
    // 白名单外的字段直接退回，不是悄悄跳过：分镜表 schema 是 additionalProperties:false，
    // 塞进一个它不认的字段，下一次读这份表的人会收到一句「这不是可识别的分镜表」
    const rejected = keys.filter((k) => !allowed[k]);
    if (rejected.length) return res.status(400).json({ error: "这条接口不收 " + target + " 上的这些字段：" + rejected.join("、") + "（镜头号和角色 id 是定位用的钥匙，要改去分镜表里改）" });
    if (!keys.length) return res.status(400).json({ error: "fields 是空的，没有要回写的东西" });
    for (const k of keys) {
      const kind = allowed[k], v = fields[k];
      if (kind === "number") {
        // 类型错了不当场拦，整份分镜表就变成读不出来的了——错在这一笔，赔的是整部戏
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return res.status(400).json({ error: k + " 要是一个大于 0 的秒数（分镜表里它是数字，写成字符串整份表就不合法了）" });
      } else if (kind === "list") {
        // 空数组是合法的：把角色线全拆了就是一个空镜。但里头混进一个空串或者数字，
        // 整份分镜表就不合 schema 了（cast 是 string 数组），下次读这份表的人只会收到「这不是可识别的分镜表」
        if (!Array.isArray(v)) return res.status(400).json({ error: k + " 要是一组角色 id（分镜表里它是数组）" });
        if (v.length > 24) return res.status(400).json({ error: k + " 一镜里最多 24 个角色，收到 " + v.length + " 个（多半是连线连错了地方）" });
        if (v.some((x) => typeof x !== "string" || !x.trim())) return res.status(400).json({ error: k + " 里有空的或者不是文字的角色 id" });
        if (new Set(v).size !== v.length) return res.status(400).json({ error: k + " 里有重复的角色 id" });
      } else if (typeof v !== "string") {
        return res.status(400).json({ error: k + " 要是一段文字" });
      } else if (kind === "must" && !v.trim()) {
        return res.status(400).json({ error: k + " 不能是空的（产物路径清空等于把已经生出来的东西抹掉；景别和提示词空着下一步没法跑）" });
      }
    }

    const r = readDramaJson(body.name);
    const label = target === "shot" ? "镜头" : "角色";
    const hits = [];
    if (target === "shot") {
      const wantScene = String(body.scene || "").trim();
      for (const scene of r.data.scenes) {
        if (wantScene && String((scene && scene.id) || "") !== wantScene) continue;
        for (const shot of (Array.isArray(scene && scene.shots) ? scene.shots : [])) {
          if (shot && typeof shot === "object" && String(shot.id || "") === shotId) hits.push(shot);
        }
      }
    } else {
      for (const c of (Array.isArray(r.data.characters) ? r.data.characters : [])) {
        if (c && typeof c === "object" && (String(c.id || "") === charId || String(c.name || "") === charId)) hits.push(c);
      }
    }
    // 查无此镜就当场说，别静悄悄成功：画布上写着文件路径、分镜表里一个字没有，
    // 这种「两边都不报错的分家」要等到下次重跑白花一次钱才看得出来
    if (!hits.length) return res.status(404).json({ error: "分镜表 " + r.rel + " 里没有" + label + " " + (shotId || charId) + "——它多半是被改名或删掉了，画布上这个节点已经指不着真源了" });
    if (hits.length > 1) return res.status(409).json({ error: "分镜表 " + r.rel + " 里有 " + hits.length + " 个" + label + "都叫 " + (shotId || charId) + "，不替你猜是哪一个——先把重复的编号改掉" });

    // 盖掉之前先留一张。首帧是按「镜头_<镜头号>_首帧.png」这个固定名字落盘的，重跑就是原地盖掉：
    // 只记路径找不回上一版，留底存的是字节本身
    shotHistory.snapshot(getWorkspaceDir(), {
      board: r.rel, kind: target, id: shotId || charId, data: r.data,
      why: "回写 " + keys.join("、") + " 之前", session: String(body.session || ""),
    });
    Object.assign(hits[0], fields);
    const raw = JSON.stringify(r.data, null, 2) + "\n";
    if (Buffer.byteLength(raw) > DRAMA_JSON_MAX) return res.status(400).json({ error: "分镜表超过 4MB 上限" });
    fs.writeFileSync(r.p, raw, "utf8");
    res.json({ ok: true, name: r.rel, target, id: shotId || charId, fields });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * 分镜节点的版本快照 + 一键恢复。
 *
 * 要治的是这一件：改一句台词、重跑一下，上一版的首帧被同名文件盖掉了，找不回来。
 * 所以留底存的是**字节本身**（见 shot-history.js），不是路径。
 *
 * 拍照的时机有三处，少一处就有一段时间是裸奔的：
 *   · 重跑之前——前端点「重跑首帧」的第一件事，盖掉之前这一下最要紧；
 *   · 单格回写之前；
 *   · 整份保存之前，且只给这一次真的动了的镜头拍——画布上挪一个节点走的也是整份保存，
 *     整版拍一遍等于把每条视频都算一遍 sha256，那就成了拖一下卡一下。
 *
 * 留底失败一律不挡住保存：用户要的是这一笔先写对，退不回去是第二位的事。
 */
function dramaTargetIds(data, kind) {
  const out = [];
  if (kind === "character") for (const c of (Array.isArray(data && data.characters) ? data.characters : [])) { const id = String((c && c.id) || ""); if (id) out.push(id); }
  else for (const s of (Array.isArray(data && data.scenes) ? data.scenes : [])) for (const sh of (Array.isArray(s && s.shots) ? s.shots : [])) { const id = String((sh && sh.id) || ""); if (id) out.push(id); }
  return out;
}
/** 整份保存之前：只给这一次真的动了的拍。删掉一镜也算动了——那是最该留底的一种改法，删完连路径都不剩 */
function dramaSnapshotDiff(rel, next, why, session) {
  const out = [];
  let prev;
  try { prev = readDramaJson(rel).data; } catch { return out; } // 第一次保存，本来就没有上一版
  const root = getWorkspaceDir(), same = (a, b) => JSON.stringify(shotHistory._internals.stable(a)) === JSON.stringify(shotHistory._internals.stable(b));
  for (const kind of ["shot", "character"]) {
    for (const id of new Set(dramaTargetIds(prev, kind))) {
      const a = shotHistory._internals.findTarget(prev, kind, id);
      if (a.length !== 1) continue;                       // 撞号的不碰：拍了也不知道拍的是哪一个
      const b = shotHistory._internals.findTarget(next, kind, id);
      if (b.length === 1 && same(a[0], b[0])) continue;
      const e = shotHistory.snapshot(root, { board: rel, kind, id, data: prev, why: b.length ? why : "删掉之前", session });
      if (e) out.push(e.id);
    }
  }
  return out;
}
function shotHistoryArgs(src) {
  const rel = dramaName(src && src.name);
  if (!rel) throw new Error("分镜表文件名不合法（只允许工作区内的 .json 文件）");
  const kind = String((src && src.kind) || "shot");
  if (kind !== "shot" && kind !== "character") throw new Error("kind 只能是 shot 或 character");
  const id = String((src && src.id) || "").trim();
  if (!id) throw new Error("要看哪一镜 / 哪个角色：缺 id");
  return { rel, kind, id, session: String((src && src.session) || "") };
}
app.get("/api/drama/shot-history", (req, res) => {
  try {
    const { rel, kind, id } = shotHistoryArgs(req.query);
    // 分镜表读不出来照样列版本：表坏了正是最想翻留底的时候，这时候再回一句「表不合法」等于把门锁上
    let data = null;
    try { data = readDramaJson(rel).data; } catch {}
    res.json({ ok: true, name: rel, kind, id, versions: shotHistory.list(getWorkspaceDir(), { board: rel, kind, id, data }), usage: shotHistory.usage(getWorkspaceDir()) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// 重跑之前先拍一张。前端在发生成请求之前调它——图一旦落盘，上一版就已经被盖掉了，那时候再拍拍到的是新的
app.post("/api/drama/shot-history/snapshot", (req, res) => {
  try {
    const { rel, kind, id, session } = shotHistoryArgs(req.body);
    const r = readDramaJson(rel);
    const e = shotHistory.snapshot(getWorkspaceDir(), { board: rel, kind, id, data: r.data, why: String((req.body || {}).why || "重跑之前"), session });
    res.json({ ok: true, name: rel, kind, id, saved: e ? { id: e.id, ts: e.ts } : null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
/**
 * 把某一版留下的那份素材直接吐出来，给界面画缩略图用。
 *
 * 没有它，「恢复到哪一版」只能靠时间戳猜——而这功能的整个由头就是**看一眼上一版的首帧**。
 * 盘上那个路径早被同名盖掉了，所以只能从留底里读。
 * 路径不来自请求：请求给的是版本号和字段名，落到哪个文件由账本里那串 sha256 决定，
 * 而它必须是 64 位十六进制——外面递什么进来都拼不出一个能跳出 objects/ 的路径。
 */
app.get("/api/drama/shot-history/blob", (req, res) => {
  try {
    const { rel, kind, id } = shotHistoryArgs(req.query);
    const version = String(req.query.version || "").trim(), field = String(req.query.field || "").trim();
    const root = getWorkspaceDir();
    const entry = shotHistory._internals.readLedger(root, rel).find((e) => e.id === version && e.kind === kind && e.target === id);
    if (!entry) return res.status(404).json({ error: "没有这一版" });
    const b = (entry.blobs || {})[field];
    if (!b || !b.hash) return res.status(404).json({ error: "这一版没留下 " + field });
    const p = shotHistory._internals.objPath(root, b.hash);
    if (!p || !fs.existsSync(p)) return res.status(410).json({ error: "这一版的 " + field + " 留底超过保留期被清掉了" });
    res.type(path.extname(String(b.rel || "")) || "application/octet-stream");
    // 内容按 sha256 寻址，同一个地址的字节永远不变，可以放心让浏览器长期缓存
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    res.sendFile(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/drama/shot-history/restore", (req, res) => {
  try {
    const { rel, kind, id, session } = shotHistoryArgs(req.body);
    const version = String((req.body || {}).version || "").trim();
    if (!version) return res.status(400).json({ error: "要恢复到哪一版：缺 version" });
    const r = shotHistory.restore(getWorkspaceDir(), { board: rel, kind, id, version, session });
    if (!r.ok) return res.status(/没有这一版|分镜表里没有/.test(r.error) ? 404 : /都叫/.test(r.error) ? 409 : 400).json(r);
    res.json({ ...r, name: rel, kind, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * deps：getWorkspaceDir / outputFiles / safePath 来自 tools.js；account / org / budget 是 server.js 手里那几份
 * （草稿接口真调模型，积分和预算两道闸跟 /api/chat 一样）；llm / llmForSession / addUsage / toolRunSubdir /
 * toolRunSubdirReady 是 server.js 的；canvasAssetNear 来自 routes/canvas.js。
 */
function createDramaRouter(deps) {
  ({ getWorkspaceDir, outputFiles, safePath, account, org, budget, llm, llmForSession, addUsage, toolRunSubdir, toolRunSubdirReady, canvasAssetNear } = deps);
  return app;
}

// readDramaJson 画布的素材台账也要用（routes/canvas.js），由 server.js 通过 deps 递过去
module.exports = { createDramaRouter, readDramaJson };
