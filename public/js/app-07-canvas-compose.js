/* 无限画布 · 进度、批量与合成（第 7 片）
 *
 * 进度条和预计时间、批量补齐及花费预估、合成成片的开始轮询和停止，
 * 起手模板的占位文字、素材清单和缺失核对、把结果落成节点、打开时恢复或铺起手模板。
 * 加载顺序见 app-03.js 的 loadCanvasDeps，各片分工见入口 app-07-canvas.js 开头。
 */
function canvasBytesText(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / 1048576).toFixed(1) + " MB";
  return (b / 1073741824).toFixed(1) + " GB";
}

/** 素材台账。单独一条路：算得慢一点也不该挡住文件列表出现 */
/* ── 短剧制片进度带 ────────────────────────────────────────────────────────
 * 用户要的是「真的能拿这个做 AI 短剧」。画布上摆得下三十个镜头，但摆得下不等于做得完：
 * 还差几张首帧、哪一镜卡着、剩下的活儿大概多久，光看画布是看不出来的，
 * 用户只能一个节点一个节点点开数——那不叫工作流。
 *
 * 这条带子回答三个问题，顺序就是它在屏幕上的顺序：
 *   ① 做到哪了（七档进度：剧本 → 定妆 → 分镜 → 首帧 → 镜头视频 → 配音 → 成片）
 *   ② 卡在哪（点一下直接跳到出问题的那几个节点上）
 *   ③ 还剩多少活儿、按这张画布自己跑过的速度大概要多久，以及「一键把差的补上」
 *
 * 判定全在服务端 drama-pipeline.js 里做（纯函数、可单测），这里只负责显示和按按钮。
 */
function canvasEtaText(ms) {
  if (!ms || ms < 1000) return "";
  const m = Math.round(ms / 60000);
  if (m < 1) return "不到 1 分钟";
  if (m < 60) return `约 ${m} 分钟`;
  return `约 ${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 跳到出问题的节点上：选中 + 居中。卡在哪要能点得过去，不然说了等于没说 */
function canvasProgressFocus(ids) {
  const wanted = new Set((ids || []).map(String));
  const hit = (canvasState.graph?.getElements?.() || []).filter((n) => wanted.has(String(n.id)));
  if (!hit.length) { canvasToast("这些节点在当前画布上找不到了（可能刚被删掉）。", "info"); return; }
  canvasState.selectedAll = false;
  canvasState.selectedIds = new Set(hit.map((n) => n.id));
  canvasState.selected = hit[0].id;
  canvasRenderInspector(false);
  canvasCenterSelected(document.querySelector(".canvas-page"));
  hit.forEach((n) => canvasRefreshNode(n));
}

/** 进度带里那块合成区。方案、跑动、结果三种样子，同一块地方，不弹窗 */
function canvasComposeHtml(p) {
  const job = canvasState.composeJob, plan = canvasState.composePlan;
  const shots = p.shots || [];
  const canCompose = shots.length > 0 && shots.every((r) => r.video && r.video.ok);
  const button = (label, extra) => `<button class="ui-btn ui-btn--xs ui-btn--brand" data-cp-compose ${extra || ""}>${esc(label)}</button>`;

  if (job && !job.done) {
    const at = Math.max(1, Number(job.at) || 1), total = Math.max(1, Number(job.total) || 1);
    const step = (job.steps || [])[at - 1] || {};
    return `<div class="cp-compose"><div class="cp-compose-head"><b>正在拼成片</b>`
      + `<span>第 ${at}/${total} 步 · ${esc(step.label || "")}</span>`
      + `<button class="ui-btn ui-btn--xs ui-btn--ghost" data-cp-compose-stop>停下</button></div>`
      + `<div class="cp-bar is-sub"><i style="width:${Math.round(((at - 1) / total) * 100)}%"></i></div>`
      + (job.log || []).map((l) => `<div class="cp-compose-log">${esc(l)}</div>`).join("")
      + `</div>`;
  }
  if (job && job.output) {
    return `<div class="cp-compose is-done"><div class="cp-compose-head"><b>成片好了</b>`
      + `<code>${esc(job.subtitled || job.output)}</code>`
      + `<button class="ui-btn ui-btn--xs ui-btn--outline" data-cp-compose-open="${esc(job.subtitled || job.output)}">打开看看</button>`
      + button("重新合成") + `</div>`
      + (job.subtitled && job.output !== job.subtitled ? `<div class="cp-compose-log">不带字幕的那条也在：${esc(job.output)}</div>` : "")
      // 没烧进画面的时候更要说字幕文件在哪：不说，用户会以为字幕根本没做出来，
      // 而它其实就躺在旁边，拖进剪映/达芬奇就能用
      + (job.subtitleFile && !job.subtitled ? `<div class="cp-compose-log">字幕文件也在：${esc(job.subtitleFile)}（没烧进画面，拖进剪辑软件就能用）</div>` : "")
      + (job.log || []).map((l) => `<div class="cp-compose-log">${esc(l)}</div>`).join("")
      + `</div>`;
  }
  if (job && job.error) {
    const bad = (job.steps || []).filter((x) => x.state === "fail");
    return `<div class="cp-compose is-bad"><div class="cp-compose-head"><b>没拼成</b><span>${esc(job.error)}</span>${button("再来一次")}</div>`
      + bad.map((x) => `<div class="cp-compose-log">${esc(x.label)}：${esc(x.note || "")}</div>`).join("")
      + `</div>`;
  }
  if (plan === "loading") return `<div class="cp-compose"><span class="cp-compose-tip">正在看这部戏能不能拼（在探每一镜的真实时长和画幅）…</span></div>`;
  if (plan) {
    const stop = (plan.blockers || []).filter((b) => b.level === "stop");
    const warn = (plan.blockers || []).filter((b) => b.level !== "stop");
    const rows = (plan.shots || []).map((r, i) => `<li${r.why ? ' class="is-bad"' : ""}>`
      + `<span class="cp-ord">${i + 1}</span><b>${esc(r.id)}</b>`
      + `<span>${r.seconds ? r.seconds + "s" : "时长探不到"}</span>`
      + `<span>${r.audio ? "有配音" : r.line ? "缺配音" : "无人声"}${r.pad ? `（画面补 ${r.pad}s）` : ""}</span>`
      + `<span class="cp-why">${esc(r.why || "")}</span></li>`).join("");
    const eta = canvasEtaText(plan.etaMs);
    // 「烧不了」有三种不一样的原因，混成一句「做不了」等于没说：
    // 自己关掉的不用解释；没台词/探不到时长是这张画布的事；没 libass 是这台机器的事，
    // 而且后者字幕文件照样给——不说清楚，用户会以为字幕根本没生成
    const burnBlocked = (plan.blockers || []).some((b) => /libass/.test(b.text));
    const subNote = !canvasState.composeSub || plan.outputs.subtitled ? ""
      : burnBlocked ? "（本机 ffmpeg 没带 libass，烧不进画面；字幕文件照样给你）"
      : "（这次做不了：没有台词，或者探不到时长）";
    return `<div class="cp-compose is-plan"><div class="cp-compose-head"><b>合成方案</b>`
      + `<span>${(plan.shots || []).length} 镜 · ${plan.totalSeconds ? plan.totalSeconds + " 秒" : "总时长探不到"} · ${plan.mode === "copy" ? "直接拼，一帧都不重压" : `统一到 ${plan.target.w}×${plan.target.h} 重新编码`}</span>`
      + `<button class="ui-btn ui-btn--xs ui-btn--ghost" data-cp-compose-close>收起</button></div>`
      + `<div class="cp-compose-tip">按分镜编号排序，不对就改镜头 ID。</div>`
      + `<ol class="cp-order">${rows}</ol>`
      + [...stop, ...warn].map((b) => `<div class="cp-compose-log is-${esc(b.level)}">${esc(b.text)}</div>`).join("")
      + `<label class="cp-compose-sub"><input type="checkbox" data-cp-compose-sub ${canvasState.composeSub ? "checked" : ""}>把字幕烧进画面${subNote}</label>`
      // 配乐：用了哪一段得写出来。画布上可能摆着好几段音乐，
      // 「它到底混了哪一首」是开跑前一眼能纠正、跑完只能重跑一遍的事
      + (plan.music
        ? `<label class="cp-compose-sub"><input type="checkbox" data-cp-compose-bgm ${canvasState.composeBgm ? "checked" : ""}>垫上配乐<code>${esc(plan.music.title || plan.music.base)}</code><span class="cp-why">${plan.music.duck ? "说话的时候自动压低" : "固定音量垫在台词底下"}</span></label>`
        : `<div class="cp-compose-tip">加配乐：放一个「声音」节点，用途写「配乐」，拖入音乐文件。</div>`)
      + `<div class="cp-compose-out">会写出 <code>${esc(plan.outputs.film)}</code>${plan.outputs.subtitled ? ` 和 <code>${esc(plan.outputs.subtitled)}</code>` : ""}${plan.outputs.srt ? ` 和 <code>${esc(plan.outputs.srt)}</code>` : ""}${(plan.outputs.clips || []).length ? ` · 中间片段放在 <code>${esc(plan.outputs.dir)}/</code>` : ""}。同名的旧成片不会被盖掉。</div>`
      + `<div class="cp-compose-act"><button class="ui-btn ui-btn--xs ui-btn--brand" data-cp-compose-go ${plan.ready ? "" : "disabled"}>开始合成${eta ? `（${eta}）` : ""}</button></div>`
      + `</div>`;
  }
  if (!canCompose) return "";
  return `<div class="cp-compose">${button("合成成片")}<span class="cp-compose-tip">配音合轨 → 拼接 → 配乐 → 字幕，本机运行，不花钱。</span></div>`;
}

/**
 * 进度条占了多高，就从画布视口里扣掉多少。
 *
 * 视口的高度是写死的 calc(100vh - 278px)，那个 278 是这一条还不存在时算出来的。
 * 它一出现（展开之后还会长出卡点清单和镜头表）就把下面的画布连同对话区一起顶下去，
 * 界面上看到的就是「又被挡住了」。所以把它的实际高度量出来喂给 CSS，视口自己让位。
 */
function canvasProgressHeight(box) {
  const page = document.getElementById("assist-page");
  // 让位只是好看，量不出来就算了：一条进度带不能因为「高度没算成」整条画不出来
  if (!page || !page.style || typeof page.style.setProperty !== "function") return;
  const h = box && !box.hidden ? (box.offsetHeight || 0) + 8 : 0; // +8 是它自己的下边距
  page.style.setProperty("--cp-h", h + "px");
}

function canvasRenderProgress() {
  const box = document.getElementById("canvas-progress");
  if (!box) return;
  const p = canvasState.progress;
  // 读不到就整条不显示。显示一个「0%」比什么都不显示更糟：那是在撒谎
  if (!p || !Array.isArray(p.stages)) { box.hidden = true; box.innerHTML = ""; canvasProgressHeight(box); return; }
  const counted = p.stages.filter((s) => s.total > 0);
  if (!counted.length && !(p.blockers || []).length) { box.hidden = true; box.innerHTML = ""; canvasProgressHeight(box); return; }
  box.hidden = false;

  const chips = p.stages.map((s) => s.total === 0
    ? `<span class="cp-chip is-none" title="这张画布上没有这一档的节点">${esc(s.label)}</span>`
    : `<span class="cp-chip is-${s.state}" title="${esc(s.label + "：" + s.done + "/" + s.total)}">${esc(s.label)}<b>${s.done}/${s.total}</b></span>`).join("");

  const stops = (p.blockers || []).filter((b) => b.level === "stop");
  const others = (p.blockers || []).filter((b) => b.level !== "stop");
  const blockerHtml = [...stops, ...others].slice(0, 6).map((b, i) => `<li class="cp-blocker is-${esc(b.level)}">`
    + `<span>${esc(b.text)}</span>`
    + (b.ids && b.ids.length ? `<button class="ui-btn ui-btn--xs ui-btn--ghost" data-cp-focus="${i}">跳过去看</button>` : "")
    + `</li>`).join("");

  const pend = p.pending || {};
  const jobs = [["cast", "定妆照", pend.cast], ["image", "首帧", pend.image], ["video", "镜头视频", pend.video], ["audio", "配音", pend.audio]]
    .filter(([, , n]) => n > 0);
  const eta = p.eta ? canvasEtaText(p.eta.ms) : "";
  const running = canvasState.batch;
  const jobsHtml = jobs.length
    ? `<div class="cp-jobs"><span class="cp-jobs-label">还要生成</span>`
      + jobs.map(([kind, label, n]) => `<button class="ui-btn ui-btn--xs ui-btn--outline" data-cp-run="${kind}" ${running ? "disabled" : ""} title="${esc("按镜头顺序跑，同时跑几条在工具栏里选，中途可以停")}">${esc(label)} ${n} 个</button>`).join("")
      + (eta ? `<span class="cp-eta" title="${esc(p.eta.basis + (p.eta.partial ? "；有一类还没跑过，这个数只算了跑过的那些" : ""))}">${esc(eta)}${p.eta.partial ? "（还不全）" : ""}</span>`
             : `<span class="cp-eta is-unknown" title="这张画布还没跑过生成，估不出来">时间估不出来</span>`)
      + (running ? `<span class="cp-running">正在跑第 ${running.at}/${running.total} 个${running.label ? "：" + esc(running.label) : ""}</span><button class="ui-btn ui-btn--xs ui-btn--ghost" data-cp-stop>停下</button>` : "")
      + `</div>`
    : "";

  const shots = (p.shots || []).filter((r) => r.blocked || !r.frame || !r.video);
  const shotsHtml = shots.length ? `<table class="cp-shots"><thead><tr><th>镜头</th><th>首帧</th><th>视频</th><th>配音</th><th>卡在哪</th></tr></thead><tbody>`
    + shots.slice(0, 30).map((r) => {
      const cell = (v, need) => !need ? `<span class="cp-x is-skip" title="这一镜不需要">—</span>`
        : v && v.ok ? `<span class="cp-x is-ok">✓</span>`
          : v ? `<span class="cp-x is-lost" title="${esc(v.path)}">文件没了</span>`
            : `<span class="cp-x is-todo">·</span>`;
      return `<tr data-cp-shot="${esc(r.nodeId)}"><td>${esc(r.id)}</td><td>${cell(r.frame, true)}</td><td>${cell(r.video, true)}</td><td>${cell(r.audio, r.needsVoice)}</td><td class="cp-why">${esc(r.blocked || "")}</td></tr>`;
    }).join("")
    + `</tbody></table>${shots.length > 30 ? `<div class="cp-more">还有 ${shots.length - 30} 个镜头没列出来</div>` : ""}` : "";

  box.innerHTML = `<div class="cp-bar"><i style="width:${Math.max(0, Math.min(100, p.percent))}%"></i></div>`
    + `<button class="cp-head" type="button" data-cp-toggle aria-expanded="${canvasState.progressOpen ? "true" : "false"}">`
      + `<span class="cp-pct">${p.percent}%</span>`
      + `<span class="cp-stages">${chips}</span>`
      // 收起时这里是唯一一句话，展开时下面第一条卡点就是它——同一句话摆两遍，看着像出了两个故障。
      // 展开时留着这个格子当撑满的间隔（flex:1），只是不写字
      + `<span class="cp-next" title="${esc(p.next?.text || "")}">${(canvasState.progressOpen ? "" : esc(p.next?.text || ""))}</span>`
      + `<span class="cp-caret">${ic(canvasState.progressOpen ? "chevron-up" : "chevron-down")}</span>`
    + `</button>`
    + (canvasState.progressOpen
      ? `<div class="cp-body">${blockerHtml ? `<ul class="cp-blockers">${blockerHtml}</ul>` : ""}${jobsHtml}${canvasComposeHtml(p)}${shotsHtml}${p.boardUnreadable ? `<div class="cp-warn">画布文件读不出来，这里算的是空的：${esc(p.boardUnreadable)}</div>` : ""}</div>`
      : "");

  canvasProgressHeight(box);
  box.querySelector("[data-cp-toggle]")?.addEventListener("click", () => { canvasState.progressOpen = !canvasState.progressOpen; canvasRenderProgress(); });
  const all = [...stops, ...others].slice(0, 6);
  box.querySelectorAll("[data-cp-focus]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); canvasProgressFocus(all[Number(b.dataset.cpFocus)]?.ids); }));
  box.querySelectorAll("[data-cp-shot]").forEach((tr) => tr.addEventListener("click", () => canvasProgressFocus([tr.dataset.cpShot])));
  box.querySelectorAll("[data-cp-run]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); canvasRunPending(b.dataset.cpRun); }));
  box.querySelector("[data-cp-stop]")?.addEventListener("click", (e) => { e.stopPropagation(); if (canvasState.batch) canvasState.batch.stop = true; canvasToast("在跑的跑完就停，不再开新的。", "info"); });
  box.querySelector("[data-cp-compose]")?.addEventListener("click", (e) => { e.stopPropagation(); canvasComposeOpen(); });
  box.querySelector("[data-cp-compose-go]")?.addEventListener("click", (e) => { e.stopPropagation(); canvasComposeStart(); });
  box.querySelector("[data-cp-compose-stop]")?.addEventListener("click", (e) => { e.stopPropagation(); canvasComposeStop(); });
  box.querySelector("[data-cp-compose-close]")?.addEventListener("click", (e) => { e.stopPropagation(); canvasState.composePlan = null; canvasRenderProgress(); });
  box.querySelector("[data-cp-compose-open]")?.addEventListener("click", (e) => { e.stopPropagation(); canvasPreviewRight(e.currentTarget.dataset.cpComposeOpen); });
  // 字幕烧不烧会换掉输出文件名，所以改了就重算一遍方案，别让屏幕上写的和真跑的是两回事
  box.querySelector("[data-cp-compose-sub]")?.addEventListener("change", (e) => { e.stopPropagation(); canvasState.composeSub = !!e.currentTarget.checked; canvasComposeOpen(); });
  box.querySelector("[data-cp-compose-bgm]")?.addEventListener("change", (e) => { e.stopPropagation(); canvasState.composeBgm = !!e.currentTarget.checked; canvasComposeOpen(); });
}

async function canvasLoadProgress() {
  const r = await fetch("/api/canvas/progress?name=" + encodeURIComponent(canvasState.canvasName)).then((x) => x.json()).catch(() => null);
  canvasState.progress = r && Array.isArray(r.stages) ? r : null;
  canvasRenderProgress();
  canvasRefreshHistory();   // 版本清单也认进度里这一镜的产物：后到的，到了再列一遍
  if (typeof canvasRenderTimeline === "function") canvasRenderTimeline();   // 时间线的红点认的也是这份进度（盘上真有没有）
}

// 一键补齐同时跑几条。默认 2：一条一条跑太慢，十条一起发出去，失败了分不清是谁先撞的墙（限流、显存），
// 钱也是一口气烧出去的。上限 4 是给「接口够快、心里有数」的人留的，再多就该去后台批量了
const CANVAS_BATCH_LIMIT_KEY = "openworkbuddy.canvas.batchLimit";
function canvasBatchLimit() {
  const clamp = (v) => { const n = Math.round(Number(v)); return n >= 1 && n <= 4 ? n : 0; };
  const held = clamp(canvasState.batchLimit);
  if (held) return held;
  // 隐私窗口、存储被禁用时 localStorage 一碰就抛：读不到就按默认，不能让一键补齐因此点不动
  try { const saved = clamp(localStorage.getItem(CANVAS_BATCH_LIMIT_KEY)); if (saved) return saved; } catch {}
  return 2;
}
function canvasSetBatchLimit(value) {
  const n = Math.min(4, Math.max(1, Math.round(Number(value)) || 2));
  canvasState.batchLimit = n;   // 存不进去也照样按选的跑，只是下次打开会回到默认
  try { localStorage.setItem(CANVAS_BATCH_LIMIT_KEY, String(n)); } catch {}
  return n;
}

/**
 * 这一格拿去估价的那一条：只带影响价钱的东西（型号、配音的字数），不带参考图、上下文。
 * 估价接口按 units 算：图按张（没写 n 就是 1）、配音按字、视频按型号默认时长——跟真跑那一枪同一个口径
 */
function canvasEstimateItem(node, kind) {
  const p = canvasPayload(node) || {};
  // 型号跟真跑那一枪同一个口径：卡上没选就用「新建短剧」时定的（见 canvasDramaModel）
  const picked = kind === "audio" ? "" : typeof canvasDramaModel === "function" ? canvasDramaModel(p, kind, canvasKind(node)) : String(p.model || "");
  const model = picked ? { model: picked } : {};
  if (kind === "audio") return { tool: "text_to_speech", input: { text: String(p.text || p.line || p.description || "").trim() } };
  // 时长是视频的计价单位：卡上 / 新建短剧定的秒数不带进来，估出来的就是模型默认那一档
  if (kind === "video") return { tool: "generate_video", input: { prompt: String(p.motion_prompt || p.prompt || p.description || "").trim(), ...(typeof canvasVideoSpec === "function" ? canvasVideoSpec(p, canvasKind(node)) : {}), ...model } };
  return { tool: "generate_image", input: { prompt: String(p.prompt || p.description || p.text || "").trim(), ...model } };
}
// ¥ 两位小数；不到一分钱的（配音按字计，一句几厘）两位会写成 ¥0.00，看着像不要钱，所以多留几位
function canvasFormatYuan(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  if (n > 0 && n < 0.01) return "¥" + Number(n.toPrecision(2));
  return "¥" + n.toFixed(2);
}
async function canvasEstimate(items) {
  // 返回 { est } 或 { error }：估价失败不猜原因，把服务端那句原话带回去
  try {
    const r = await fetch("/api/tool/estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
    const data = await r.json().catch(() => null);
    if (r.ok !== false && data && data.ok !== false && Array.isArray(data.items)) return { est: data };
    return { error: String((data && data.error) || (r.status ? "HTTP " + r.status : "没有返回报价")) };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

/**
 * 一键补齐开跑前的那一道：几条、大概多少钱、点了就开始扣费。点「先不了」一个请求都不发。
 * 估价拿不到（老服务端、接口报错）也照样弹，只是不写金额——不能因为估不出来就默默开跑
 */
async function canvasConfirmBatch(kind, queue) {
  if (typeof askConfirm !== "function") return true;
  const n = queue.length;
  const { est, error } = await canvasEstimate(queue.map((node) => canvasEstimateItem(node, kind === "cast" ? "image" : kind)));
  const known = est ? est.items.filter((x) => x && x.known).length : 0;
  const unknown = est ? (Number.isFinite(Number(est.unknownCount)) ? Number(est.unknownCount) : est.items.length - known) : n;
  const money = est && known ? canvasFormatYuan(est.total) : "";
  const pick = kind === "video" ? 0 : kind === "audio" ? 1 : 2;
  const hint = !est ? canvasT("没拿到报价：{n}", { n: error })
    : !known ? "这一批估不出价格"
      : unknown > 0 ? canvasT("另有 {n} 条价格未知", { n: unknown }) : "";
  // 标题原文就地写在 title: 后面、并且 await：test/confirm-dialogs.js 按字面量核「每处都写了 title」、
  // 逐句过英文词典，也核每处 askConfirm 都是 await 出来的
  return await askConfirm({
    title: money
      ? canvasT(["将生成 {n} 段视频，预计 {m}，确认后开始扣费", "将生成 {n} 条配音，预计 {m}，确认后开始扣费", "将生成 {n} 张图，预计 {m}，确认后开始扣费"][pick], { n, m: money })
      : canvasT(["将生成 {n} 段视频，确认后开始扣费", "将生成 {n} 条配音，确认后开始扣费", "将生成 {n} 张图，确认后开始扣费"][pick], { n }),
    ...(hint ? { hint } : {}),
    ok: "开始生成",
    cancel: "先不了",
  });
}

/**
 * 检查器里「生成」按钮旁的那个价：一格一条，同一条参数只问一次（切来切去选节点不必每次都问）。
 * 估不出就写「价格未知」，接口出错就留空——空着比写一个猜的数强
 */
async function canvasFillPrices(box, node) {
  if (!box || !node) return;
  const spots = [...box.querySelectorAll("[data-canvas-price]")];
  if (!spots.length) return;
  if (!(canvasState.priceCache instanceof Map)) canvasState.priceCache = new Map();
  for (const spot of spots) {
    const item = canvasEstimateItem(node, spot.dataset.canvasPrice);
    // 价跟着设置里选的型号走：型号换了，同一条参数也得重新问
    const models = typeof settingsCache !== "undefined" && settingsCache ? settingsCache.media_models || null : null;
    const key = JSON.stringify([item, models]);
    let got = canvasState.priceCache.get(key);
    if (!got && item.tool === "text_to_speech" && !item.input.text) got = { text: "" };   // 没台词就没法按字算，先不写
    if (!got) {
      const { est } = await canvasEstimate([item]);
      const row = est && est.items[0];
      got = !row ? { text: "" } : row.known ? { text: canvasT("约 {m}", { m: canvasFormatYuan(row.cost) }) } : { text: "价格未知" };
      if (row) canvasState.priceCache.set(key, got);   // 出错的不记：下次选中再问一次
    }
    if (spot.isConnected) spot.textContent = got.text;
  }
}

/**
 * 把缺的那一类一次跑完。
 *
 * 开跑前先弹一道确认：几条、大概多少钱（问 /api/tool/estimate）。点「先不了」一个请求都不发。
 * 同时跑几条有上限（默认 2，工具栏里选 1–4）：生图生视频是花钱也吃显存的活儿，十个一起发出去，
 * 失败了都不知道是哪个先撞的墙。中途能停，停的意思是「在跑的跑完就不再开新的」，
 * 不是把正在跑的那几个掐死——掐死只会留下半截文件。
 */
async function canvasRunPending(kind) {
  if (canvasState.batch) return;
  const elements = canvasState.graph?.getElements?.() || [];
  const has = (p, k) => {
    const row = (canvasState.progress?.shots || []).find((r) => String(r.nodeId) === String(p));
    if (!row) return true;
    const v = k === "image" ? row.frame : k === "video" ? row.video : row.audio;
    if (k === "audio" && !row.needsVoice) return true;
    if (k === "video" && !(row.frame && row.frame.ok)) return true;   // 没首帧的镜头轮不到生视频
    // 首帧同名好几份（ok 但带 ambiguous）也轮不到：拿哪张当首帧都是猜，跟进度接口 pending.video 的口径一样
    if (k === "video" && row.frame.ambiguous) return true;
    return !!(v && v.ok);
  };
  // 定妆照这一档数的是角色节点，判「做完了没」看的是盘上到底有没有那张图（进度接口算的），
  // 不是画布上写没写路径——写着路径而文件没了，照样得重跑。
  const castRows = (canvasState.progress && canvasState.progress.cast) || [];
  const castOk = (id) => { const row = castRows.find((r) => String(r.nodeId) === String(id)); return !!(row && row.image && row.image.ok); };
  const todo = kind === "cast"
    ? elements.filter((n) => canvasKind(n) === "character" && !castOk(n.id) && !canvasIsPlaceholderPrompt(canvasPayload(n).description))
    : elements.filter((n) => canvasKind(n) === "shot" && !has(n.id, kind)
      && !canvasIsPlaceholderPrompt(canvasPayload(n).prompt));
  if (!todo.length) {
    // 「没有要补的了」和「有要补的，但都还没写设定」是两回事，不能都报一句绿的
    const held = kind === "cast" && elements.some((n) => canvasKind(n) === "character" && !castOk(n.id));
    canvasToast(held ? "这些角色缺人物设定，无法生成定妆照。" : "这一类没有要补的了。",
      held ? "triangle-alert" : "circle-check", held ? "err" : undefined);
    return;
  }
  // 配音这一档多一道：不知道该用谁的嗓子的镜头先拦下来。
  // 整批停掉太狠（二十个镜头里一个没点名，另外十九个也做不了），一个一个弹错误又只会被
  // 最后那句「N 个没成」盖掉——所以把它们摘出来单算，跑完一起说清楚，再跳到那几个镜头上。
  const noSpeaker = kind === "audio" ? todo.filter((n) => canvasResolveVoice(n, canvasPayload(n)).error) : [];
  const queue = todo.filter((n) => !noSpeaker.includes(n));
  const heldNote = noSpeaker.length ? `，${noSpeaker.length} 个不知道该用谁的嗓子（去镜头的「说话的角色」里点个名）` : "";
  if (!queue.length) {
    canvasToast(`${noSpeaker.length} 个镜头连了多个角色，先指定说话人。`, "triangle-alert", "err");
    canvasProgressFocus(noSpeaker.map((n) => n.id));
    return;
  }
  await canvasRunQueue(kind, queue, noSpeaker, heldNote);
}

/**
 * 真正跑的那一段。一键补齐和「重试失败的 M 条」共用：重试只是换了一份更短的名单。
 *
 * 成没成看 canvasGenerate 的返回值，不看 payload 变没变——生成途中节点被删了、被远端
 * 重铺成新对象了，手里那个旧对象的 payload 怎么看都不对。没成的记下 id，结束那条提示上
 * 挂一颗「重试失败的 M 条」，只重跑这几个：成了的那些再跑一遍是白花钱。
 *
 * 并发是个小池子：limit 个 worker 共用一个游标，谁空了谁取下一个，按镜头顺序发出去。
 */
async function canvasRunQueue(kind, queue, noSpeaker = [], heldNote = "") {
  // 确认框开着的时候再点一次，不能叠出第二个确认、更不能绕过确认直接开跑
  if (canvasState.batch || canvasState.confirming) return;
  if (typeof canvasConfirmBatch === "function") {
    canvasState.confirming = true;
    let go = false;
    try { go = await canvasConfirmBatch(kind, queue); } finally { canvasState.confirming = false; }
    if (!go || canvasState.batch) return;
  }
  canvasState.batch = { kind, total: queue.length, at: 0, label: "", stop: false };
  canvasRenderProgress();
  let ok = 0;
  const failed = [];
  // 记下是哪张画布发起的：重试按钮要认这个，换到别的画布上点，不能拿同名 id 去那张图上开枪
  const where = { board: canvasState.canvasName, project: canvasState.workspaceName }, hadGraph = !!canvasState.graph;
  let moved = false, next = 0;
  const limit = Math.max(1, Math.min(queue.length, typeof canvasBatchLimit === "function" ? canvasBatchLimit() : 2));
  const worker = async () => {
    while (next < queue.length) {
      if (canvasState.batch.stop) return;
      // 人换到别的画布去了：剩下的不再开枪（复制出来的画布 id 一样，按 id 取会打到那张图上）
      if (canvasState.canvasName !== where.board || canvasState.workspaceName !== where.project) { moved = true; return; }
      const queued = queue[next];
      next += 1;
      canvasState.batch.at += 1;
      // 画布页重画那一小会儿图是空的：等它建好（最多 3 秒），不拿手里的旧对象去开枪——往孤儿身上写，钱白花
      for (let i = 0; i < 30 && hadGraph && !canvasState.graph; i += 1) await new Promise((r) => setTimeout(r, 100));
      // 排队那会儿拿到的对象，轮到它时可能已经被删了或者换了新的：按 id 重新取，取不到就跳过
      const node = canvasState.graph?.getCell?.(queued.id) || (canvasState.graph || hadGraph ? null : queued);
      if (!node) continue;
      canvasState.batch.label = String(canvasPayload(node).id || canvasPayload(node).name || canvasPayload(node).title || "");
      canvasRenderProgress();
      const r = await canvasGenerate(node, kind === "cast" ? "image" : kind);
      if (r && r.ok) ok += 1; else failed.push(node.id);
    }
  };
  try {
    await Promise.all(Array.from({ length: limit }, worker));
  } finally {
    const stopped = canvasState.batch?.stop;
    canvasState.batch = null;
    const bad = failed.length;
    // 按钮上的字是模板 + 参数：英文界面按整句查词条，数字单独塞进去
    const retry = bad ? { label: "重试失败的 {n} 条", params: { n: bad }, run: () => canvasRetryFailed(kind, failed, where) } : undefined;
    const warn = bad || noSpeaker.length || moved;
    canvasToast(`${ok} 个做好了${bad ? `，${bad} 个没成` : ""}${heldNote}${stopped ? "（手动停了）" : ""}${moved ? "（换了画布，没跑完）" : ""}`, warn ? "triangle-alert" : "circle-check", warn ? "err" : undefined, retry);
    if (noSpeaker.length) canvasProgressFocus(noSpeaker.map((n) => n.id));
    await canvasLoadProgress();
    canvasLoadLibrary();
  }
}

/** 只重跑上一趟没成的那几个。点按钮时已经被删掉的就不管了，全删光了要说一声，不能点了没反应 */
async function canvasRetryFailed(kind, ids, where) {
  // 按钮点了没反应最糟：另一批还在跑、人不在原来那张画布上，都要说一声为什么没动
  if (canvasState.batch) { canvasToast("还有一批在跑，跑完再点重试。", "triangle-alert", "err"); return; }
  if (where && (canvasState.canvasName !== where.board || canvasState.workspaceName !== where.project)) {
    canvasToast("失败的节点在另一张画布上，切回去再点重试。", "triangle-alert", "err"); return;
  }
  const nodes = (ids || []).map((id) => canvasState.graph?.getCell?.(id)).filter(Boolean);
  if (!nodes.length) { canvasToast("失败的节点都已不在画布上。", "triangle-alert", "err"); return; }
  await canvasRunQueue(kind, nodes);
}

/**
 * 合成成片：把画布上的镜头真的拼成一条能播的片子。
 *
 * 三步，缺一不可：
 *   ① 先算方案，**摆出来给人看**——镜头排成什么顺序、哪一镜缺配音、会写出哪几个文件。
 *      排错顺序是这条链路上最贵的错：片子能播、时长也对，只有情节是乱的，
 *      没有任何一条报错会红，只有人看到第三分钟才发现。所以顺序必须先过一眼。
 *   ② 确认了才跑。跑的是服务端拼好的 ffmpeg 命令，一条一条来，跑到哪写到哪。
 *   ③ 跑完了认账：成片真的落盘才说成了，没落盘就说没落盘。
 * 中途能停。停下来已经拼好的片段都留着，下次接着拼不用重跑。
 */
async function canvasComposeOpen() {
  canvasState.progressOpen = true;
  canvasState.composePlan = "loading";
  canvasState.composeJob = null;
  canvasRenderProgress();
  const r = await fetch("/api/canvas/compose", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: canvasState.canvasName, subtitles: canvasState.composeSub, music: canvasState.composeBgm }),
  }).then((x) => x.json()).catch((e) => ({ error: String((e && e.message) || e) }));
  if (!r || !r.plan) {
    canvasState.composePlan = null; canvasRenderProgress();
    canvasToast("算不出合成方案：" + ((r && r.error) || "服务端没回话"), "circle-x", "err");
    return;
  }
  canvasState.composePlan = r.plan;
  canvasRenderProgress();
}

async function canvasComposeStart() {
  const plan = canvasState.composePlan;
  if (!plan || plan === "loading" || !plan.ready) return;
  // music 得跟预览那一枪（canvasComposeOpen）带同一个值：漏了它，服务端按「不垫配乐」拼，
  // 预览里勾着「垫上配乐」，出来的成片却是干的，而且没有任何一条报错
  const r = await fetch("/api/canvas/compose", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: canvasState.canvasName, subtitles: canvasState.composeSub, music: canvasState.composeBgm, run: true }),
  }).then((x) => x.json()).catch((e) => ({ error: String((e && e.message) || e) }));
  if (!r || !r.job) { canvasToast("没跑起来：" + ((r && r.error) || "服务端没回话"), "circle-x", "err"); return; }
  canvasState.composePlan = null;
  canvasState.composeJob = r.job;
  canvasRenderProgress();
  canvasComposePoll();
}

/** 盯着这条合成跑到哪了。1.2 秒问一次：ffmpeg 一条命令动辄几十秒，问太勤没有意义 */
function canvasComposePoll() {
  window.clearTimeout(canvasState.composeTimer);
  canvasState.composeTimer = window.setTimeout(async () => {
    const id = canvasState.composeJob && canvasState.composeJob.id;
    if (!id) return;
    const r = await fetch("/api/canvas/compose?job=" + encodeURIComponent(id)).then((x) => x.json()).catch(() => null);
    if (r && r.job) canvasState.composeJob = r.job;
    canvasRenderProgress();
    if (!r || !r.job || !r.job.done) return canvasComposePoll();
    const job = r.job;
    if (job.output) {
      canvasToast(`成片出来了：${job.subtitled || job.output}${job.wroteNode ? "，" + job.wroteNode : ""}`, "circle-check");
      if (typeof canvasComposeNotify === "function") canvasComposeNotify(job);   // 人切走了的话 toast 看不见，补一条系统通知
      canvasLoadLibrary();   // 素材台账、制片进度、节点上的那格视频，都等着这一下刷新
    } else {
      canvasToast("没拼成：" + (job.error || "不知道为什么，展开看看哪一步红了"), "circle-x", "err");
    }
  }, 1200);
}

async function canvasComposeStop() {
  const id = canvasState.composeJob && canvasState.composeJob.id;
  if (!id) return;
  await fetch("/api/canvas/compose", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cancel: id }),
  }).catch(() => null);
  canvasToast("正在停…已经拼好的片段都留着。", "info");
}

/** 起手模板里那几句占位文字。跟服务端 drama-pipeline.js 的 PLACEHOLDERS 是同一份口径 */
const CANVAS_PROMPT_PLACEHOLDERS = ["一句话概念、人物关系、冲突与结局…", "在这里写一句话概念、人物关系、冲突、对白和结局。", "还没有剧本内容", "镜头内容与运动…", "对白或旁白…", "人物外形、性格、目标与关系…", "地点、时间、天气、光线与氛围…", "这张图要保持的主体、风格与构图…", "描述你想生成的内容…", "对白、旁白或音乐说明…"];
function canvasIsPlaceholderPrompt(text) { const t = String(text || "").trim(); return !t || CANVAS_PROMPT_PLACEHOLDERS.includes(t); }

async function canvasLoadAssets() {
  const r = await fetch("/api/canvas/assets?name=" + encodeURIComponent(canvasState.canvasName)).then((x) => x.json()).catch(() => null);
  canvasState.assets = r && Array.isArray(r.assets) ? r : null;
  canvasRenderLibrary();
  // 检查器里「历史版本」的 v1…vN 是从台账里数的：台账后到，不重列的话开着的那一块缺版本、或者还是上一趟的
  canvasRefreshHistory();
}

/** 节点上所有装文件路径的字段。跟服务端 ASSET_REF_KEYS 是同一份口径 */
const CANVAS_REF_KEYS = ["path", "file", "url", "video", "audio", "image", "reference", "first_frame", "last_frame", "reference_video", "subtitled", "voice_file", "ref"];

/**
 * 把「清单里没有」的那批素材拿去问盘，问出来真没有的才算没有。
 *
 * 只问清单里找不到的那些——画布上大部分素材都在清单里，没必要为它们跑一趟。
 * 问完两头都写：盘说没有的进 missing（横幅这才画得出来），盘说有的从 missing 里拿掉
 * （用户把文件补回来之后，横幅得自己消失，不能等刷新整页）。
 */
async function canvasVerifyMissing() {
  const nodes = canvasState.graph?.getElements?.() || [];
  const inList = new Set(canvasState.files.map((f) => String(f.name || f.path || "")));
  const ask = new Set();
  for (const node of nodes) {
    const payload = canvasPayload(node) || {};
    for (const key of CANVAS_REF_KEYS) {
      const raw = String(payload[key] || "").trim();
      if (!raw || /^(https?:|data:|\/api\/files\/view\/)/i.test(raw)) continue;
      const resolved = canvasResolvedFileName(raw);
      if (!inList.has(resolved)) ask.add(resolved);
    }
  }
  // 清单里全找得着，就没什么可问的；顺手把上一轮留下的判决清掉
  if (!ask.size) { if (canvasState.missing.size) { canvasState.missing.clear(); nodes.forEach((n) => canvasRefreshNode(n)); } return; }
  const r = await fetch("/api/files/exists", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: [...ask] }),
  }).then((x) => x.json()).catch(() => null);
  // 问不到（断网、接口挂了）就维持「认在」——没问出结果不是给文件盖章的理由
  if (!r || !r.exists) return;
  let changed = false;
  for (const [path, ok] of Object.entries(r.exists)) {
    const had = canvasState.missing.has(path);
    if (ok && had) { canvasState.missing.delete(path); changed = true; }
    else if (!ok && !had) { canvasState.missing.add(path); changed = true; }
  }
  if (!changed) return;
  nodes.forEach((node) => canvasRefreshNode(node));
  if (canvasSelectedNode()) canvasRenderInspector(false);
}

async function canvasLoadLibrary() {
  const response = await fetch("/api/files").then((x) => x.json()).catch(() => []);
  canvasState.files = Array.isArray(response) ? response : [];
  canvasState.graph?.getElements?.().forEach((node) => canvasRefreshNode(node));
  canvasRenderLibrary(); canvasMaterializeResultNodes(); if (canvasSelectedNode()) canvasRenderInspector(false);
  canvasLoadAssets();   // 台账后到，到了再刷一次面板
  canvasLoadProgress();  // 制片进度跟素材台账一样后到，各刷各的，谁先到谁先显示
  canvasVerifyMissing(); // 缺失判决也后到：清单里没有的那几个，问过盘才敢说它没了
}

function canvasEmbeddedImage(payload, kind) {
  const value = kind === "character" ? (payload.reference || payload.image || payload.path) : (payload.image || payload.reference || payload.path);
  return canvasFileKind(value) === "image" ? String(value).trim() : "";
}

function canvasMaterializeResultNodes() {
  if (!canvasState.graph || !canvasState.files.length) return;
  const elements = canvasState.graph.getElements(), existing = new Set(elements.filter((node) => canvasKind(node) === "image").map((node) => canvasResolvedFileName(canvasMediaPath(canvasPayload(node)))));
  let created = 0;
  elements.filter((node) => ["character", "location"].includes(canvasKind(node))).forEach((source) => {
    const path = canvasResolvedFileName(canvasEmbeddedImage(canvasPayload(source), canvasKind(source)));
    if (!path || existing.has(path) || !canvasState.files.some((file) => String(file.name || file.path || "") === path)) return;
    const pos = source.position(), size = source.size(), title = path.split(/[\\/]/).pop();
    const image = canvasAddNode("image", { title, path, url: path, role: canvasKind(source) === "character" ? "角色定妆" : "场景参考", tags: canvasKind(source) === "character" ? "角色" : "场景", sourceId: source.id }, { x: pos.x + size.width + 70, y: pos.y }, { persist: false, skipSelect: true });
    if (image) { existing.add(path); canvasConnect(source, image); created++; }
  });
  if (created) canvasPersist();
}

/**
 * 盘上那份画布读不出来时，整页显示这个，而不是往下画。
 *
 * 往下画的后果很具体：JointJS 起来 → 铺一张空画布（或者拿本机副本铺）→ 用户随手一动 →
 * 自动保存。服务端现在会挡住这一下（PUT 不带 force 就不覆盖读不出来的文件），
 * 但用户看不见挡没挡住，只会以为一直在正常干活。所以这里把话说全：
 * 出了什么事、原件在哪、有哪几条路可以走。
 */
function canvasRenderBroken(page, world) {
  const local = canvasLoadSaved();
  const count = local ? local.nodes.length : 0;
  world.innerHTML = `<div class="canvas-empty canvas-broken"><div>
    <h3>这张画布现在读不出来</h3>
    <p class="canvas-broken-why">${esc(canvasState.remoteBroken)}</p>
    <p>未按空画布显示，以免自动保存覆盖原件。原件未改动。</p>
    <div class="canvas-broken-acts">
      <button class="ui-btn ui-btn--sm ui-btn--outline" data-canvas-broken-retry>重新读一次</button>
      ${count ? `<button class="ui-btn ui-btn--sm ui-btn--brand" data-canvas-broken-restore>用本机这份恢复（${count} 个节点）</button>` : ""}
    </div>
    <p class="canvas-broken-tip">${count ? "本机副本是这台机器上次打开时的样子，可能比项目里那份旧一点。" : "这台机器上没有本机副本，所以只能先修文件本身。"}把 .openworkbuddy 目录里的 canvas 备份（.bak / .坏了-*.bak）拷回去，也能救。</p>
  </div></div>`;
  world.querySelector("[data-canvas-broken-retry]").onclick = () => renderCanvasPage();
  world.querySelector("[data-canvas-broken-restore]")?.addEventListener("click", () => canvasRestoreFromLocal(local));
  // 这一页上别的按钮都没绑（下面那一大段绑定被跳过了），但换画布得留着：
  // 一张画布坏了不该把人锁死在这儿
  const select = page.querySelector("[data-canvas-board-select]");
  if (select) select.onchange = async (event) => { await canvasFlushRemoteWrite(); canvasState.canvasName = event.target.value || "main"; try { localStorage.setItem("openworkbuddy.canvas.name", canvasState.canvasName); } catch {} renderCanvasPage(); };
}

/** 拿本机副本盖掉那份读不出来的文件。只有用户自己点了才会走到这儿，且原件已经备份过。 */
async function canvasRestoreFromLocal(local) {
  if (!local || !local.nodes.length) return;
  if (!(await askConfirm({
    title: `用本机这份覆盖项目里那份读不出来的画布？`,
    hint: `本机这份有 ${local.nodes.length} 个节点。项目原文件已备份在 .openworkbuddy 目录。`,
    ok: "覆盖", danger: true,
  }))) return;
  const state = { version: Number(local.version) >= 2 ? 2 : 1, nodes: local.nodes, edges: local.edges || [], updatedAt: Date.now() };
  const response = await fetch("/api/canvas", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: canvasState.canvasName, state, force: true }) }).catch(() => null);
  const result = response ? await response.json().catch(() => ({})) : {};
  if (!response || !response.ok) { canvasToast(result.error || "恢复失败，项目里那份没有动", "circle-x", "err"); return; }
  canvasState.remoteBroken = ""; canvasState.remoteBrokenNotified = false;
  canvasToast("已用本机这份恢复", "circle-check");
  renderCanvasPage();
}

function canvasRestoreOrSeed(remote = null) {
  const local = canvasLoadSaved();
  // 拉到了盘上那份就先认它当 base（新建的画布是 updatedAt 0，照样算）：下面铺本机副本、铺起手卡之后
  // 那一趟存盘都照着它交，这中间别处要是先写了一笔，就撞 409 去合并，不再一把盖掉
  if (remote && Array.isArray(remote.nodes)) canvasState.remoteBase = { scope: canvasScope(), at: Number(remote.updatedAt) || 0, snapshot: remote };
  // 上回两边都改了、人点了「稍后再选」就走了：铺本机这份（盘上那份一铺，本机没交上去的改动就没了），
  // 拿当时的 base 去交，撞 409 重新合并、重新问。见 canvasSavePendingConflict
  const pending = canvasLoadPendingConflict();
  if (pending && local && local.nodes.length) {
    canvasState.remoteBase = { scope: canvasScope(), at: pending.at, snapshot: pending.snapshot };
    canvasApplySnapshot(local); return;
  }
  if (pending) canvasClearPendingConflict();
  const saved = remote && remote.nodes.length ? remote : local;
  if (saved && saved.nodes.length) {
    // 服务器那份直接铺、不回写；本机那份铺完要往上顶一次（这台机器上有、服务器上没有的改动）
    canvasApplySnapshot(saved, { fromRemote: saved === remote }); return;
  }
  // 起手那两张卡只给「从来没人动过」的画布。判据不能是「现在是空的」——用户把画布自己清空之后
  // 就正好是空的，于是每打开一次长回来两张，还连带存回服务器，换台机器打开看见的也是这两张。
  // 动过没有看两处：本机有没有存过这张画布，以及服务器那份的 updatedAt（新建出来的是 0）
  if (local || (remote && Number(remote.updatedAt) > 0)) {
    if (remote) canvasApplySnapshot(remote, { fromRemote: true });
    return;
  }
  // 刚从「新建短剧」表单过来的，填的画幅、时长、风格、模型记在这张起手剧本卡上（见 canvasCreateBoard）
  const seed = typeof canvasTakeSeedDrama === "function" ? canvasTakeSeedDrama() : null;
  const script = canvasAddNode("script", { title: "一句话概念", text: "在这里写一句话概念、人物关系、冲突、对白和结局。", ...(seed || {}) }, { x: 100, y: 110 }, { persist: false, skipSelect: true });
  const storyboard = canvasAddNode("storyboard", {}, { x: 510, y: 110 }, { persist: false, skipSelect: true });
  if (script && storyboard) canvasConnect(script, storyboard); canvasState.selected = null; canvasState.selectedIds = new Set(); canvasRenderInspector(false); canvasPersist();
}
