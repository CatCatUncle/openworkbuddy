// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 评测页的「评测集」：上传 CSV / Excel / TXT / JSON，或者在这里直接建。
 * 数据形状和判分规则都在 eval/custom-sets.js，这里只管摆表单。
 */

/** 表单里的一道题 ↔ 存盘的一道题。上传时带来的正则、页数这些表单摆不下的规则原样留着 */
const EV_FORM_TYPES = ["file", "contains", "not_contains"];
function evTaskToForm(t) {
  const of = (type, k) => (t.expect || []).filter((e) => e.type === type).map((e) => e[k]).join("; ");
  return {
    id: t.id || "", name: t.name || "", prompt: t.prompt || "", files: t.files || {},
    outputs: of("file", "name"), contains: of("contains", "text"), notContains: of("not_contains", "text"),
    criteria: (t.criteria || []).map((c) => `${c.text}:${c.must ? "!" : c.weight}`).join("\n"),
    other: (t.expect || []).filter((e) => !EV_FORM_TYPES.includes(e.type)),
  };
}
function evFormToTask(f) {
  const list = (s) => String(s || "").split(/[;；\n]+/).map((x) => x.trim()).filter(Boolean);
  const file = list(f.outputs)[0] || "";
  return {
    id: f.id, name: f.name || f.prompt.slice(0, 24), prompt: f.prompt, files: f.files,
    expect: [
      ...list(f.outputs).map((name) => ({ type: "file", name })),
      ...list(f.contains).map((text) => ({ type: "contains", text, file })),
      ...list(f.notContains).map((text) => ({ type: "not_contains", text, file })),
      ...f.other,
    ],
    criteria: String(f.criteria || "").split("\n").map((x) => x.trim()).filter(Boolean).map((line) => {
      const m = /^(.*?)\s*[:：]\s*(!|！|[-+]?\d+)\s*$/.exec(line);
      if (!m) return { text: line, weight: 1, must: false };
      return /^[!！]$/.test(m[2]) ? { text: m[1], weight: 5, must: true } : { text: m[1], weight: +m[2], must: false };
    }),
  };
}

function evTaskFormHtml(f, i) {
  return `<div class="ev-settask" data-i="${i}">
    <div class="ev-settask-h"><input class="st-name" placeholder="名称" value="${esc(f.name)}"><a href="#" class="link danger st-del">${ic("trash-2")}</a></div>
    <textarea class="st-prompt" rows="3" placeholder="题目">${esc(f.prompt)}</textarea>
    <div class="ev-settask-row">
      <input class="st-out" placeholder="必须有的文件" title="多个用分号隔开" value="${esc(f.outputs)}">
      <input class="st-in" placeholder="必须包含" title="多个用分号隔开" value="${esc(f.contains)}">
      <input class="st-not" placeholder="不能包含" title="多个用分号隔开" value="${esc(f.notContains)}">
    </div>
    <textarea class="st-crit" rows="3" placeholder="评分标准。一行一条。结尾写 :3 是权重，:! 是必须项，:-2 是扣分项">${esc(f.criteria)}</textarea>
  </div>`;
}

/** 表单现在的值读回来：加题、删题要重画，填到一半的不能丢 */
function evReadForms(box, forms) {
  box.querySelectorAll(".ev-settask").forEach((el) => {
    const f = forms[+el.dataset.i];
    if (!f) return;
    f.name = el.querySelector(".st-name").value.trim();
    f.prompt = el.querySelector(".st-prompt").value;
    f.outputs = el.querySelector(".st-out").value;
    f.contains = el.querySelector(".st-in").value;
    f.notContains = el.querySelector(".st-not").value;
    f.criteria = el.querySelector(".st-crit").value;
  });
}

function evOpenSetEditor(set) {
  const box = document.getElementById("ev-set-editor");
  if (!box) return;
  const forms = (set.tasks || []).map(evTaskToForm);
  if (!forms.length) forms.push(evTaskToForm({}));
  const paint = () => {
    box.innerHTML = `<div class="ev-seteditor">
      <input id="ev-set-name" placeholder="评测集名称" value="${esc(set.name || "")}">
      ${forms.map(evTaskFormHtml).join("")}
      <div class="ev-jp-ops"><button class="btn-plain" id="ev-set-add">${ic("plus")} 加一道题</button><button class="btn-brand" id="ev-set-save">${ic("save")} 保存</button><button class="btn-plain" id="ev-set-cancel">取消</button></div>
    </div>`;
    box.querySelectorAll(".st-del").forEach((a) => (a.onclick = (e) => {
      e.preventDefault();
      evReadForms(box, forms);
      forms.splice(+a.closest(".ev-settask").dataset.i, 1);
      if (!forms.length) forms.push(evTaskToForm({}));
      paint();
    }));
    box.querySelector("#ev-set-add").onclick = () => { evReadForms(box, forms); forms.push(evTaskToForm({})); paint(); };
    box.querySelector("#ev-set-cancel").onclick = () => { box.innerHTML = ""; };
    box.querySelector("#ev-set-save").onclick = async () => {
      evReadForms(box, forms);
      set.name = box.querySelector("#ev-set-name").value.trim();
      const r = await fetch("/api/eval/sets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: set.id, name: set.name, tasks: forms.map(evFormToTask) }) }).then((x) => x.json()).catch(() => null);
      if (!r || r.error) return toast((r && r.error) || "保存失败", "circle-x");
      toast("评测集已保存", "circle-check");
      box.innerHTML = "";
      renderEvalSets(r.set.id);
    };
  };
  paint();
}

async function evImportSet(file) {
  const buf = await file.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const r = await fetch("/api/eval/sets/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: file.name, data: btoa(bin) }) }).then((x) => x.json()).catch(() => null);
  if (!r || r.error) return toast((r && r.error) || "导入失败", "circle-x");
  toast(`已导入 ${r.set.tasks.length} 道题${r.warnings && r.warnings.length ? `，${r.warnings.length} 行跳过` : ""}`, "circle-check");
  renderEvalSets(r.set.id);
}

async function renderEvalSets(pick) {
  const box = document.getElementById("ev-sets");
  const sel = document.getElementById("ev-set");
  if (!box || !sel) return;
  const d = await fetch("/api/eval/sets").then((r) => r.json()).catch(() => ({ sets: [] }));
  const sets = d.sets || [];
  const keep = pick !== undefined ? pick : sel.value;
  sel.innerHTML = `<option value="">内置题库</option>` + sets.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}（${s.tasks} 题）</option>`).join("");
  if (sets.some((s) => s.id === keep)) sel.value = keep;
  box.innerHTML = `<div class="ev-sec">评测集<span>用你自己的任务和标准来测 · CSV / Excel / TXT / JSON</span></div>
    <div class="ev-setbar">
      <label class="btn-plain">${ic("upload")} 导入文件<input type="file" id="ev-set-file" accept=".csv,.tsv,.xlsx,.txt,.md,.json" hidden></label>
      <a class="btn-plain" href="/api/eval/sets/template" download>${ic("download")} 下载模板</a>
      <button class="btn-plain" id="ev-set-new">${ic("plus")} 新建评测集</button>
    </div>
    ${sets.map((s) => `<div class="ev-setrow"><span>${esc(s.name)}</span><em>${s.tasks} 题</em><a href="#" class="link" data-set-edit="${esc(s.id)}">编辑</a><a href="#" class="link danger" data-set-del="${esc(s.id)}">删除</a></div>`).join("")}
    <div id="ev-set-editor"></div>`;
  box.querySelector("#ev-set-file").onchange = (e) => { const f = e.target.files[0]; if (f) evImportSet(f); };
  box.querySelector("#ev-set-new").onclick = () => evOpenSetEditor({ name: "", tasks: [] });
  box.querySelectorAll("[data-set-edit]").forEach((a) => (a.onclick = async (e) => {
    e.preventDefault();
    const r = await fetch("/api/eval/sets/" + encodeURIComponent(a.dataset.setEdit)).then((x) => x.json()).catch(() => null);
    if (r && r.set) evOpenSetEditor(r.set);
  }));
  box.querySelectorAll("[data-set-del]").forEach((a) => (a.onclick = async (e) => {
    e.preventDefault();
    if (!(await askConfirm({ title: "删掉这个评测集？", hint: "题目和标准都会删除，跑过的成绩还在。", ok: "删掉", danger: true }))) return;
    await fetch("/api/eval/sets/" + encodeURIComponent(a.dataset.setDel), { method: "DELETE" }).catch(() => null);
    renderEvalSets();
  }));
}

// ── 盲评：两轮成果并排看，不知道哪边是哪轮，选完才揭晓 ──────────────────────
function evBlindBar(hist) {
  const box = document.getElementById("ev-blind-bar"); if (!box) return;
  const runs = hist.filter((h) => h.dir);
  if (runs.length < 2) { box.innerHTML = ""; return; }
  const label = (h) => `${String(h.at || "").slice(0, 16).replace("T", " ")} · ${h.model || ""}`;
  const options = (pick) => runs.map((h, i) => `<option value="${esc(h.dir)}" ${i === pick ? "selected" : ""}>${esc(label(h))}</option>`).join("");
  box.innerHTML = `<div class="ev-setbar"><select id="ev-blind-a" aria-label="第一轮">${options(0)}</select><select id="ev-blind-b" aria-label="第二轮">${options(1)}</select><button class="btn-plain" id="ev-blind-go">${ic("scale")} 盲评这两轮</button></div>`;
  box.querySelector("#ev-blind-go").onclick = async () => {
    const r = await fetch("/api/eval/blind", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a: box.querySelector("#ev-blind-a").value, b: box.querySelector("#ev-blind-b").value }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) return toast(d.error || "盲评没开起来", "circle-x");
    evBlindOpen(d, runs);
  };
}

function evBlindSide(session, item, side) {
  const data = item[side];
  return `<section class="ev-blind-side"><h4>${side === "left" ? "A" : "B"}</h4><div class="ev-blind-text">${esc(data.text) || "（没有文字回复）"}</div>`
    + (data.files.length ? `<div class="ev-blind-files">${data.files.map((f) => `<button type="button" class="btn-plain" data-blind-file="${esc(f.name)}" data-side="${side}">${ic("file-text")} ${esc(f.name)}</button>`).join("")}</div><pre class="ev-blind-peek" data-peek="${side}" hidden></pre>` : "")
    + `</section>`;
}

function evBlindOpen(session, runs) {
  const mask = document.createElement("div");
  mask.className = "code-review ev-blind"; mask.setAttribute("role", "dialog"); mask.setAttribute("aria-modal", "true"); mask.setAttribute("aria-label", "盲评");
  document.body.appendChild(mask);
  const nameOf = (dir) => { const h = runs.find((x) => x.dir === dir); return h ? `${String(h.at || "").slice(0, 16).replace("T", " ")} · ${h.model || ""}` : dir; };
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (event) => { if (event.key === "Escape" && !imeKey(event)) close(); };
  document.addEventListener("keydown", onKey, true);
  let at = session.items.findIndex((item) => !item.pick); if (at < 0) at = 0;
  const showResult = (r) => {
    mask.innerHTML = `<div class="code-review-card ev-blind-card"><header><b>盲评结果</b><button type="button" class="icon-btn" data-close aria-label="关闭">${ic("x")}</button></header><div class="ev-blind-result">
      <p>${esc(nameOf(r.a.dir))}：<b>${r.a.wins}</b> 题更好</p><p>${esc(nameOf(r.b.dir))}：<b>${r.b.wins}</b> 题更好</p><p>差不多：${r.ties} 题</p>
      <p class="ev-blind-note">题少的时候差一两题说明不了问题，多比几轮再下结论。</p>
      <table class="ev-tab"><tbody>${r.items.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.winner ? esc(nameOf(x.winner)) : "差不多"}</td></tr>`).join("")}</tbody></table></div></div>`;
    mask.querySelector("[data-close]").onclick = close;
  };
  const paint = () => {
    const item = session.items[at];
    mask.innerHTML = `<div class="code-review-card ev-blind-card"><header><b>${esc(item.name)}</b><span>第 ${at + 1} / ${session.items.length} 题</span><button type="button" class="icon-btn" data-close aria-label="关闭">${ic("x")}</button></header>
      <div class="ev-blind-main">${evBlindSide(session, item, "left")}${evBlindSide(session, item, "right")}</div>
      <footer class="ev-blind-foot"><button class="btn-plain" data-pick="left">A 更好</button><button class="btn-plain" data-pick="tie">差不多</button><button class="btn-plain" data-pick="right">B 更好</button></footer></div>`;
    mask.querySelector("[data-close]").onclick = close;
    mask.querySelectorAll("[data-blind-file]").forEach((button) => (button.onclick = async () => {
      const side = button.dataset.side, peek = mask.querySelector(`[data-peek="${side}"]`);
      const d = await fetch(`/api/eval/blind/${session.id}/file?index=${at}&side=${side}&name=${encodeURIComponent(button.dataset.blindFile)}`).then((r) => r.json()).catch(() => ({}));
      peek.hidden = false;
      peek.textContent = d.binary ? "这是二进制文件，这里显示不了内容。" : d.text || d.error || "读不出来";
    }));
    mask.querySelectorAll("[data-pick]").forEach((button) => (button.onclick = async () => {
      const r = await fetch(`/api/eval/blind/${session.id}/vote`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ index: at, pick: button.dataset.pick }) }).catch(() => null);
      const d = r ? await r.json().catch(() => ({})) : {};
      if (!r || !r.ok) return toast(d.error || "没记上", "circle-x");
      item.pick = button.dataset.pick;
      if (d.result) return showResult(d.result);
      at = session.items.findIndex((row) => !row.pick);
      paint();
    }));
  };
  paint();
}
