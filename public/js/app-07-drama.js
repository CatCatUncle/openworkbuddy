/* AI 短剧画布（第二期最小闭环）
 *
 * 这不是另一套分镜数据：画布只读/回写 short-drama 技能定义的 JSON。
 * 节点是普通 DOM，因而主题、字体、无障碍和现有工作台保持一致；拖拽/滚轮只是视口变换，
 * 不会改动分镜表里的内容。真正会写盘的动作只有「单格重跑」成功后的产物路径回写。
 */
let dramaState = { name: "", data: null, busy: new Set(), scale: 1, x: 0, y: 0, graph: null, paper: null, wheelHandler: null };

function dramaFileUrl(name) {
  return "/api/files/view/" + String(name || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}
function dramaBaseName(name) { return String(name || "").split(/[\\/]/).pop() || ""; }
function dramaShotId(shot, scene, i) { return String((shot && shot.id) || `${scene && scene.id || "S"}-${String(i + 1).padStart(2, "0")}`); }
function dramaChars(data) {
  return new Map((Array.isArray(data && data.characters) ? data.characters : []).map((c) => [String(c.id), c]));
}
function dramaAllShots(data) {
  const out = [];
  for (const scene of Array.isArray(data && data.scenes) ? data.scenes : []) {
    for (const [i, shot] of (Array.isArray(scene.shots) ? scene.shots : []).entries()) out.push({ scene, shot, i });
  }
  return out;
}
function dramaToast(text, icon, kind) {
  if (typeof toast === "function") return toast(text, icon || (kind === "err" ? "circle-x" : "circle-check"));
  console[kind === "err" ? "error" : "log"](text);
}

async function dramaList() {
  const r = await fetch("/api/drama/storyboards").then((x) => x.json());
  if (!r || !Array.isArray(r.storyboards)) throw new Error(r && r.error || "分镜表列表读取失败");
  return r.storyboards;
}
async function dramaLoad(name) {
  const q = "/api/drama/storyboard?name=" + encodeURIComponent(name);
  const r = await fetch(q).then((x) => x.json());
  if (!r || !r.data) throw new Error(r && r.error || "分镜表读取失败");
  dramaState.name = r.name;
  dramaState.data = r.data;
  return r.data;
}
async function dramaSave() {
  const r = await fetch("/api/drama/storyboard", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: dramaState.name, data: dramaState.data }),
  }).then((x) => x.json());
  if (!r || !r.ok) throw new Error(r && r.error || "分镜表回写失败");
}
/**
 * 重跑一格之后，只把这一格跑出来的字段写回去。
 *
 * 以前这儿走的是整份 PUT，写回去的是**打开这个页面那一刻**的副本。中间在无限画布上把十二镜
 * 生完（画布现在也会回写分镜表了），这一次重跑就会连带把那十二笔一起抹掉——界面上显示的是
 * 「重跑成功」，实际干的事是把别处刚做完的活儿删了，而且要等下次重跑白花一遍钱才看得出来。
 *
 * 分镜表里那一镜没有 id 的时候指不着（schema 要求有，手改坏的表会缺），这时候退回整份写：
 * 丢一笔总比这一格干脆不落盘强，但会在控制台说一声为什么退回。
 *
 * 绝不抛：这个函数是在钱已经花掉、图已经落盘之后才跑的。让它把异常掀到 dramaRerun 的 catch，
 * 界面上就会显示「重跑失败」——那是假红，人会以为白花了钱去再点一次，于是真的又花一次。
 * 回不去就把回不去这件事单独说清楚。
 */
async function dramaSaveShot(scene, shot, fields) {
  try {
    if (!shot || !String(shot.id || "").trim()) {
      console.warn("[短剧] 这一镜在分镜表里没有镜头号，指不着单格回写，只能整份写回：", scene && scene.id);
      await dramaSave();
      return "";
    }
    const r = await fetch("/api/drama/storyboard/output", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: dramaState.name, scene: String((scene && scene.id) || ""), shot: String(shot.id), fields }),
    }).then((x) => x.json()).catch(() => ({}));
    if (!r || !r.ok) return `没能写回分镜表（${String((r && r.error) || "接口没应答").slice(0, 120)}）——这一格下次打开还是老样子，再点重跑会再花一次钱`;
    return "";
  } catch (e) {
    return `没能写回分镜表（${String(e.message || e).slice(0, 120)}）——这一格下次打开还是老样子，再点重跑会再花一次钱`;
  }
}
async function dramaRerun(scene, shot, kind) {
  const id = dramaShotId(shot, scene, 0);
  const key = `${id}:${kind}`;
  if (dramaState.busy.has(key)) return;
  if (kind === "video" && !shot.first_frame) return dramaToast(`镜头 ${id} 还没有首帧，先重跑首帧`, "triangle-alert", "err");
  dramaState.busy.add(key);
  const page = document.getElementById("assist-page");
  page && page.classList.add("drama-busy");
  try {
    await dramaSnapBefore(shot, kind === "image" ? "重跑首帧之前" : "重跑视频之前");
    const chars = dramaChars(dramaState.data);
    const style = String(dramaState.data.style || "").trim();
    let input;
    if (kind === "image") {
      input = {
        prompt: [dramaState.data.aspect ? `${dramaState.data.aspect} 画幅` : "", style, scene.place, scene.time, shot.shot_size, shot.frame_prompt].filter(Boolean).join("，"),
        reference_images: dramaShotRefs(shot, chars),
        filename: dramaShotFilename(shot, "image"), no_cache: true,
      };
    } else {
      input = {
        prompt: String(shot.motion_prompt || "保持画面稳定，动作自然，镜头轻微推进").trim(),
        first_frame: shot.first_frame,
        ...(shot.last_frame ? { last_frame: shot.last_frame } : {}),
        filename: dramaShotFilename(shot, "video"), no_cache: true,
      };
    }
    const resp = await fetch("/api/tool/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: kind === "image" ? "generate_image" : "generate_video", input }),
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok || result.isError || result.ok === false) throw new Error(result.error || result.content || "生成失败");
    const file = String(result.file || "").trim();
    if (!file) throw new Error("生成接口成功，但没有返回产物路径");
    if (kind === "image") shot.first_frame = file;
    else shot.video = file;
    shot.note = `${shot.note ? shot.note + "；" : ""}${kind === "image" ? "首帧" : "视频"}已重跑${result.cached ? "（命中缓存）" : ""}`;
    const back = await dramaSaveShot(scene, shot, { ...(kind === "image" ? { first_frame: file } : { video: file }), note: shot.note });
    const made = `${id} ${kind === "image" ? "首帧" : "视频"}已生成：${dramaBaseName(file)}`;
    if (back) dramaToast(`${made}，但${back}`, "triangle-alert", "err");
    else dramaToast(made, "circle-check", "ok");
    renderDramaCanvas();
  } catch (e) {
    dramaToast(`${id} 重跑失败：${String(e.message || e).slice(0, 180)}`, "circle-x", "err");
  } finally {
    dramaState.busy.delete(key);
    page && page.classList.remove("drama-busy");
  }
}

/**
 * 「版本」：这一镜有过哪些样子，一键退回去。
 *
 * 首帧是按「镜头_<镜头号>_首帧.png」这个固定名字落盘的，重跑一次就是原地盖掉——
 * 所以退回去靠的是当初留下的**字节**，不是路径，缩略图也只能从留底里取。
 * 反过来说，留底被清掉的那一版是真回不来了：按钮直接点不动，旁边写明是哪一种回不来，
 * 让人点一下再失败等于骗他一次。
 *
 * 面板做成整页浮层，不塞进卡片：卡片长在 JointJS 的 foreignObject 里，跟着画布缩放和裁切，
 * 塞进去的弹层会被切掉半边。
 */
const DRAMA_FIELD_CN = {
  first_frame: "首帧", last_frame: "尾帧", video: "视频", audio: "配音",
  line: "台词", speaker: "说话人", shot_size: "景别", frame_prompt: "画面提示词",
  motion_prompt: "运镜提示词", duration: "时长", note: "备注", cast: "出场角色",
  ref: "定妆照", name: "名字", look: "外形", voice: "音色", id: "编号",
};
const dramaFieldCn = (k) => DRAMA_FIELD_CN[k] || k;
function dramaHistDiff(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const out = [];
  for (const k of keys) if (JSON.stringify((a || {})[k]) !== JSON.stringify((b || {})[k])) out.push(dramaFieldCn(k));
  return out;
}
function dramaHistWhen(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return String(ts || "");
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function dramaHistClose() {
  const el = document.getElementById("drama-hist");
  if (el) el.remove();
  document.removeEventListener("keydown", dramaHistKey, true);
}
function dramaHistKey(e) { if (e.key === "Escape") { e.stopPropagation(); dramaHistClose(); } }
function dramaHistBlob(name, kind, id, version, field) {
  return "/api/drama/shot-history/blob?name=" + encodeURIComponent(name) + "&kind=" + encodeURIComponent(kind)
    + "&id=" + encodeURIComponent(id) + "&version=" + encodeURIComponent(version) + "&field=" + encodeURIComponent(field);
}
function dramaHistRow(v, next, name, kind, id) {
  const pic = v.files && v.files.first_frame;
  const thumb = pic && pic.kept
    ? `<img class="drama-hist-thumb" src="${esc(dramaHistBlob(name, kind, id, v.id, "first_frame"))}" alt="这一版的首帧" loading="lazy">`
    : `<div class="drama-hist-thumb drama-hist-nopic">${esc(pic ? "首帧没留住" : "无首帧")}</div>`;
  // 「改了什么」比时间戳有用得多：挑版本的人心里想的是「我要退回改台词之前那一版」
  const diff = next ? dramaHistDiff(next.fields, v.fields) : [];
  const gone = Object.entries(v.files || {}).filter(([, s]) => s && !s.kept);
  return `<li class="drama-hist-item${v.same ? " is-now" : ""}" data-ver="${esc(v.id)}">
    ${thumb}
    <div class="drama-hist-body">
      <div class="drama-hist-when">${esc(dramaHistWhen(v.ts))}${v.same ? ' <b class="drama-hist-now">现在这一版</b>' : ""}</div>
      <div class="drama-hist-why">${esc(v.why || "改动之前")}${diff.length ? " · 这一版之后改了：" + esc(diff.join("、")) : ""}</div>
      <div class="drama-hist-line">${v.fields && v.fields.line ? "“" + esc(String(v.fields.line).slice(0, 60)) + "”" : '<span class="muted">无人声镜头</span>'}</div>
      ${gone.length ? `<div class="drama-hist-gone">${esc(gone.map(([f, s]) => dramaFieldCn(f) + "：" + s.why).join("；"))}</div>` : ""}
    </div>
    <button class="ui-btn ui-btn--xs ${v.same ? "ui-btn--ghost" : "ui-btn--outline"}" data-restore="${esc(v.id)}"
      ${v.same ? "disabled" : ""}>${v.same ? "当前" : v.restorable ? "退到这一版" : "退（缺素材）"}</button>
  </li>`;
}
async function dramaHistRender(box, scene, shot) {
  const kind = "shot", id = dramaShotId(shot, scene, 0);
  const body = box.querySelector(".drama-hist-list");
  body.innerHTML = '<li class="drama-hist-loading">读取留底…</li>';
  const q = "/api/drama/shot-history?name=" + encodeURIComponent(dramaState.name) + "&kind=" + kind + "&id=" + encodeURIComponent(id);
  let r;
  try { r = await fetch(q).then((x) => x.json()); } catch (e) { r = { error: String(e.message || e) }; }
  if (!r || !r.ok) { body.innerHTML = `<li class="drama-hist-loading">${esc((r && r.error) || "留底读不出来")}</li>`; return; }
  const vs = r.versions || [];
  if (!vs.length) {
    // 空不是故障：这一镜从建表到现在一次没改过。说清楚下一张什么时候会有，别让人以为功能坏了
    body.innerHTML = '<li class="drama-hist-loading">这一镜还没有留底。每次重跑或保存之前会自动留一张，退回来就靠它。</li>';
    return;
  }
  body.innerHTML = vs.map((v, i) => dramaHistRow(v, vs[i - 1] || null, dramaState.name, kind, id)).join("");
  body.querySelectorAll("[data-restore]").forEach((btn) => btn.addEventListener("click", async () => {
    const ver = btn.dataset.restore;
    btn.disabled = true; btn.textContent = "退回中…";
    try {
      const res = await fetch("/api/drama/shot-history/restore", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: dramaState.name, kind, id, version: ver }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.error || "退回失败");
      await dramaLoad(dramaState.name);
      // 半截的要单独说：界面上「退回成功」配着一张没换的图，是这功能最坏的一种错法
      const miss = (out.files || []).filter((f) => f.action === "missing");
      if (miss.length) dramaToast(`${id} 已退回，但${miss.map((f) => dramaFieldCn(f.field) + "（" + f.why + "）").join("、")}没能一起回来`, "triangle-alert", "err");
      else dramaToast(`${id} 已退到 ${dramaHistWhen((vs.find((v) => v.id === ver) || {}).ts)} 那一版`, "circle-check", "ok");
      renderDramaCanvas();
      await dramaHistRender(box, scene, dramaAllShots(dramaState.data).map((x) => x.shot).find((s) => String(s.id || "") === id) || shot);
    } catch (e) {
      dramaToast(`${id} 退回失败：${String(e.message || e).slice(0, 180)}`, "circle-x", "err");
      btn.disabled = false; btn.textContent = "退到这一版";
    }
  }));
}
function dramaHistory(scene, shot) {
  dramaHistClose();
  const id = dramaShotId(shot, scene, 0);
  const box = document.createElement("div");
  box.id = "drama-hist";
  box.className = "drama-hist";
  box.innerHTML = `<div class="drama-hist-panel" role="dialog" aria-label="镜头 ${esc(id)} 的版本">
    <header class="drama-hist-head"><b>${esc(id)} 的版本</b><span>退回去是整镜换回那一版，不是只换图</span><button class="ui-btn ui-btn--ghost ui-btn--xs" id="drama-hist-x">关闭</button></header>
    <ul class="drama-hist-list"></ul>
  </div>`;
  box.addEventListener("click", (e) => { if (e.target === box) dramaHistClose(); });
  document.body.appendChild(box);
  box.querySelector("#drama-hist-x").onclick = dramaHistClose;
  document.addEventListener("keydown", dramaHistKey, true);
  dramaHistRender(box, scene, shot);
}

/**
 * 重跑之前，先把这一镜现在的样子留一张。
 *
 * 必须在发生成请求**之前**：图一落盘，上一版就已经被同名盖掉了，那时候再留，留下的是新的那张。
 * 留不成不挡着重跑——用户点的是「重跑」，留底是附带的事；但要在控制台留一句，
 * 不然「怎么退不回上一版」会变成一桩查不出原因的怪事。
 */
async function dramaSnapBefore(shot, why) {
  try {
    const id = String((shot && shot.id) || "").trim();
    if (!id || !dramaState.name) return;
    await fetch("/api/drama/shot-history/snapshot", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: dramaState.name, kind: "shot", id, why }),
    });
  } catch (e) { console.warn("[短剧] 重跑前留底没做成，这一版之后可能退不回来：", e); }
}

function dramaCard(scene, shot, i, chars) {
  const id = dramaShotId(shot, scene, i);
  const busyImage = dramaState.busy.has(`${id}:image`), busyVideo = dramaState.busy.has(`${id}:video`);
  const frame = shot.first_frame || "";
  const thumb = frame ? `<img class="drama-shot-thumb" src="${esc(dramaFileUrl(frame))}" alt="${esc(id)} 首帧" loading="lazy">` : `<div class="drama-shot-empty">暂无首帧</div>`;
  const line = shot.line ? `<div class="drama-shot-line">“${esc(shot.line)}”${shot.speaker ? ` <span>· ${esc(shot.speaker)}</span>` : ""}</div>` : "<div class=\"drama-shot-line muted\">无人声镜头</div>";
  return `<article class="drama-shot" data-shot="${esc(id)}">
    <div class="drama-shot-top"><b>${esc(id)}</b><span>${esc(shot.shot_size || "镜头")}</span>${shot.duration ? `<span>${esc(String(shot.duration))}s</span>` : ""}</div>
    ${thumb}
    <div class="drama-shot-copy"><div class="drama-shot-place">${esc(scene.place || "未写地点")} · ${esc(scene.time || "未写时间")}</div>${line}</div>
    <div class="drama-shot-actions">
      <button class="ui-btn ui-btn--xs ui-btn--outline" data-drama-act="image" ${busyImage ? "disabled" : ""}>${busyImage ? "生成中…" : "重跑首帧"}</button>
      <button class="ui-btn ui-btn--xs ui-btn--ghost" data-drama-act="video" ${busyVideo ? "disabled" : ""}>${busyVideo ? "生成中…" : "重跑视频"}</button>
      <button class="ui-btn ui-btn--xs ui-btn--ghost" data-drama-act="history" title="这一镜有过哪些样子，可以退回去">版本</button>
    </div>
  </article>`;
}
function dramaScene(scene, si, chars) {
  const shots = Array.isArray(scene.shots) ? scene.shots : [];
  return `<section class="drama-scene" style="--drama-col:${si % 4};height:100%">
    <header class="drama-scene-head"><span class="drama-scene-id">${esc(scene.id || `S${si + 1}`)}</span><div><b>${esc(scene.place || "未命名场次")}</b><small>${esc(scene.time || "")}</small></div><span class="drama-scene-count">${shots.length} 镜</span></header>
    <div class="drama-shot-list">${shots.map((s, i) => dramaCard(scene, s, i, chars)).join("") || '<div class="drama-empty-shot">这场还没有镜头</div>'}</div>
  </section>`;
}
let dramaJointSceneType = null;
function dramaJointType(J) {
  if (dramaJointSceneType) return dramaJointSceneType;
  dramaJointSceneType = J.dia.Element.define("openworkbuddy.DramaScene", {
    attrs: {
      body: { width: "calc(w)", height: "calc(h)", fill: "transparent", stroke: "transparent", pointerEvents: "none" },
      foreignObject: { width: "calc(w)", height: "calc(h)", overflow: "visible" },
    },
  }, {
    markup: [{
      tagName: "rect", selector: "body",
    }, {
      tagName: "foreignObject", selector: "foreignObject", attributes: { overflow: "visible" },
      children: [{
        tagName: "div", namespaceURI: "http://www.w3.org/1999/xhtml", selector: "card", className: "drama-joint-scene",
      }],
    }],
  });
  return dramaJointSceneType;
}
function dramaJointZoom(page, value) {
  const paper = dramaState.paper;
  if (!paper) return;
  dramaState.scale = Math.max(.55, Math.min(1.45, value));
  paper.scale(dramaState.scale, dramaState.scale);
  const z = page.querySelector("#drama-zoom"); if (z) z.textContent = Math.round(dramaState.scale * 100) + "%";
}
function dramaJointPan(page) {
  const paper = dramaState.paper, world = page.querySelector("#drama-world");
  if (!paper || !world) return;
  let drag = null;
  paper.on("blank:pointerdown", (evt) => {
    if (evt.button !== undefined && evt.button !== 0) return;
    drag = { x: evt.clientX, y: evt.clientY, tx: dramaState.x, ty: dramaState.y };
    world.classList.add("dragging");
  });
  paper.on("blank:pointermove", (evt) => {
    if (!drag) return;
    dramaState.x = drag.tx + evt.clientX - drag.x;
    dramaState.y = drag.ty + evt.clientY - drag.y;
    paper.translate(dramaState.x, dramaState.y);
  });
  paper.on("blank:pointerup", () => { drag = null; world.classList.remove("dragging"); });
  if (dramaState.wheelHandler) world.removeEventListener("wheel", dramaState.wheelHandler);
  dramaState.wheelHandler = (evt) => {
    evt.preventDefault();
    dramaJointZoom(page, dramaState.scale * (evt.deltaY > 0 ? .92 : 1.08));
  };
  world.addEventListener("wheel", dramaState.wheelHandler, { passive: false });
}
function renderDramaCanvas() {
  const page = document.getElementById("assist-page");
  if (!page || !dramaState.data) return;
  const data = dramaState.data, chars = dramaChars(data), all = dramaAllShots(data), J = typeof joint !== "undefined" ? joint : null;
  const totalDur = all.reduce((n, x) => n + (+x.shot.duration || 0), 0);
  const world = page.querySelector("#drama-world");
  if (!world) return;
  if (!J || !J.dia || !J.dia.Paper) {
    world.innerHTML = '<div class="drama-empty-shot">画布组件加载失败，请刷新页面。</div>';
    return;
  }
  if (dramaState.graph) dramaState.graph.clear();
  if (!dramaState.paper) {
    dramaState.graph = new J.dia.Graph({}, { cellNamespace: J.shapes });
    dramaState.paper = new J.dia.Paper({
      el: world,
      model: dramaState.graph,
      width: world.clientWidth || 1200,
      height: world.clientHeight || 640,
      gridSize: 16,
      drawGrid: { name: "dot", args: { color: "var(--owb-text-3)", thickness: 1, gap: 22 } },
      background: { color: "transparent" },
      cellViewNamespace: J.shapes,
      interactive: { elementMove: true, linkMove: false, labelMove: false, addLinkFromMagnet: false },
    });
  }
  const Scene = dramaJointType(J), scenes = Array.isArray(data.scenes) ? data.scenes : [];
  const rowHeights = [];
  scenes.forEach((scene, si) => {
    const shots = Array.isArray(scene.shots) ? scene.shots : [];
    const h = 78 + Math.max(1, shots.length) * 141;
    const row = Math.floor(si / 2), col = si % 2;
    rowHeights[row] = Math.max(rowHeights[row] || 0, h);
    const y = 32 + rowHeights.slice(0, row).reduce((n, v) => n + v + 28, 0);
    const node = new Scene({ position: { x: 36 + col * 570, y }, size: { width: 520, height: h } });
    node.set("dramaSceneId", String(scene.id || `S${si + 1}`));
    dramaState.graph.addCell(node);
    const view = node.findView(dramaState.paper);
    const root = view && view.el && view.el.querySelector(".drama-joint-scene");
    if (!root) return;
    root.innerHTML = dramaScene(scene, si, chars);
    root.querySelectorAll("[data-drama-act]").forEach((btn) => btn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const shot = shots.find((s, i) => dramaShotId(s, scene, i) === btn.closest("[data-shot]")?.dataset.shot) || shots[0];
      // 「版本」只是翻旧账，不许跟重跑共用一条路：手一抖点错就是真花一次钱
      if (btn.dataset.dramaAct === "history") dramaHistory(scene, shot);
      else dramaRerun(scene, shot, btn.dataset.dramaAct);
    }));
  });
  dramaState.paper.scale(dramaState.scale, dramaState.scale);
  dramaState.paper.translate(dramaState.x, dramaState.y);
  dramaJointPan(page);
  page.querySelector("#drama-count").textContent = `${data.scenes ? data.scenes.length : 0} 场 · ${all.length} 镜${totalDur ? ` · ${totalDur.toFixed(1)} 秒` : ""}`;
}
async function renderDramaPage() {
  const page = document.getElementById("assist-page");
  if (!page) return;
  if (dramaState.paper) dramaState.paper.remove();
  dramaState.paper = null; dramaState.graph = null; dramaState.wheelHandler = null;
  page.innerHTML = '<div class="drama-loading">加载分镜表…</div>';
  try {
    const rows = await dramaList();
    if (!rows.length) {
      page.innerHTML = `<div class="drama-empty"><div class="drama-empty-icon">${ic("clapperboard")}</div><h2>还没有分镜表</h2><p>先在任务里 use_skill short-drama，写出 <code>分镜表.json</code> 并让用户确认；确认后这里会自动出现。</p><button class="ui-btn ui-btn--default" id="drama-start">去创建分镜表</button></div>`;
      page.querySelector("#drama-start").onclick = () => { closeAssistView(); document.getElementById("new-task").click(); inputEl.value = "用 short-drama 技能先帮我写一份分镜表，先不要生成任何图片或视频。"; inputEl.focus(); };
      return;
    }
    const selected = rows.some((x) => x.name === dramaState.name) ? dramaState.name : rows[0].name;
    await dramaLoad(selected);
    page.innerHTML = `<div class="drama-head"><div><div class="drama-kicker">AI 短剧 · 分镜唯一真源</div><h1>${esc(dramaState.data.title || selected)}</h1><div class="drama-sub">${esc(dramaState.data.logline || "画布只展示分镜表；重跑单格后会把产物路径写回 JSON")}</div></div><div class="drama-head-actions"><select id="drama-select" class="ui-select"></select><button class="ui-btn ui-btn--outline ui-btn--sm" id="drama-refresh">${ic("refresh-cw")}刷新</button></div></div>
      <div class="drama-toolbar"><span id="drama-count"></span><span class="drama-toolbar-hint">拖动画布 · 滚轮缩放 · 重跑会真实调用生成模型</span><span class="drama-zoom-box"><button class="ui-btn ui-btn--ghost ui-btn--xs" id="drama-zoom-out">−</button><span id="drama-zoom">100%</span><button class="ui-btn ui-btn--ghost ui-btn--xs" id="drama-zoom-in">+</button><button class="ui-btn ui-btn--ghost ui-btn--xs" id="drama-reset">${ic("target")}复位</button></span></div>
      <div id="drama-viewport" class="drama-viewport"><div id="drama-world" class="drama-world"></div></div>`;
    const sel = page.querySelector("#drama-select");
    sel.innerHTML = rows.map((x) => `<option value="${esc(x.name)}">${esc(x.title)} · ${x.shots} 镜</option>`).join(""); sel.value = selected;
    sel.onchange = async () => { await dramaLoad(sel.value); renderDramaPage(); };
    page.querySelector("#drama-refresh").onclick = () => renderDramaPage();
    page.querySelector("#drama-zoom-in").onclick = () => { dramaState.scale = Math.min(1.45, dramaState.scale + .1); renderDramaCanvas(); page.querySelector("#drama-zoom").textContent = Math.round(dramaState.scale * 100) + "%"; };
    page.querySelector("#drama-zoom-out").onclick = () => { dramaState.scale = Math.max(.55, dramaState.scale - .1); renderDramaCanvas(); page.querySelector("#drama-zoom").textContent = Math.round(dramaState.scale * 100) + "%"; };
    page.querySelector("#drama-reset").onclick = () => { dramaState.scale = 1; dramaState.x = 0; dramaState.y = 0; renderDramaCanvas(); page.querySelector("#drama-zoom").textContent = "100%"; };
    // JointJS 画布创建后会在 renderDramaCanvas 内绑定拖拽和滚轮；这里不能先调用旧的
    // 旧的手写 DOM 视口绑定已移除；旧页面仅保留作迁移参考。
    renderDramaCanvas();
  } catch (e) { page.innerHTML = `<div class="drama-empty"><div class="drama-empty-icon">${ic("circle-x")}</div><h2>分镜表读取失败</h2><p>${esc(e.message || e)}</p><button class="ui-btn ui-btn--outline" id="drama-retry">重试</button></div>`; page.querySelector("#drama-retry").onclick = renderDramaPage; }
}
