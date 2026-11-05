// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
/* 工程线：输入框上方的工作目录条，和看改动的面板。
 *
 * 改完代码最想知道的是「它到底动了什么」。以前只能回终端敲 git diff。
 * 这里只读 git 的现状，不记录哪一轮改的，所以看到的是工作区全部未提交的改动。
 */
let codeStatus = null;
let codeAsk = 0;

const CODE_STATE_TEXT = { modified: "修改", added: "新增", new: "新文件", deleted: "删除", renamed: "改名" };

async function codeRefresh() {
  const bar = document.getElementById("code-bar"); if (!bar) return;
  if (activeLane !== "cli") { bar.hidden = true; codeStatus = null; return; }
  const ask = ++codeAsk;
  const data = await fetch("/api/code/status").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (ask !== codeAsk || activeLane !== "cli") return;
  codeStatus = data;
  codeRenderBar();
}

function codeRenderBar() {
  const bar = document.getElementById("code-bar"); if (!bar) return;
  const data = codeStatus;
  if (!data) { bar.hidden = true; return; }
  const count = (data.files || []).length + (data.more || 0);
  bar.hidden = false;
  bar.innerHTML = `<button type="button" class="code-bar-dir" data-code-dir title="${esc(data.dir || "")}">${ic("folder")}<span>${esc(data.name || "")}</span></button>`
    + (data.repo
      ? `<span class="code-bar-branch">${ic("git-branch")}${esc(data.branch || "")}</span><button type="button" class="code-bar-changes" data-code-open ${count ? "" : "disabled"}>${esc(count ? I18N.t("{n} 个改动", { n: count }) : I18N.t("没有改动"))}</button>`
      : `<span class="code-bar-note">${esc(I18N.t("不是 git 仓库，看不了改动"))}</span>`);
  bar.querySelector("[data-code-dir]").addEventListener("click", () => document.getElementById("ws-btn")?.click());
  bar.querySelector("[data-code-open]")?.addEventListener("click", codeOpenReview);
}

function codeDiffHtml(text) {
  return String(text || "").split("\n").map((line) => {
    const cls = /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename |Binary )/.test(line) ? "cd-meta" : line.startsWith("@@") ? "cd-hunk" : line.startsWith("+") ? "cd-add" : line.startsWith("-") ? "cd-del" : "";
    return `<span class="cd-line ${cls}">${esc(line) || " "}</span>`;
  }).join("");
}

function codeCloseReview() { document.getElementById("code-review")?.remove(); document.removeEventListener("keydown", codeReviewKey, true); }
function codeReviewKey(event) { if (event.key === "Escape" && !imeKey(event) && !document.querySelector(".ask-mask")) { event.preventDefault(); codeCloseReview(); } }

async function codeShowFile(box, row) {
  box.querySelectorAll("[data-code-file]").forEach((el) => el.classList.toggle("on", el.dataset.codeFile === row.path));
  const head = box.querySelector(".code-diff-head"), body = box.querySelector(".code-diff-body");
  const canDrop = row.state === "modified" || row.state === "deleted";
  head.innerHTML = `<b title="${esc(row.path)}">${esc(row.path)}</b>${canDrop ? `<button type="button" class="ui-btn ui-btn--xs ui-btn--outline" data-code-discard>${esc(I18N.t("放弃这个文件的改动"))}</button>` : ""}`;
  head.querySelector("[data-code-discard]")?.addEventListener("click", () => codeDiscard(box, row));
  body.textContent = I18N.t("读取中…");
  const response = await fetch("/api/code/diff?path=" + encodeURIComponent(row.path)).catch(() => null);
  const data = response ? await response.json().catch(() => ({})) : {};
  if (!box.isConnected || !box.querySelector(`[data-code-file].on`) || box.querySelector(`[data-code-file].on`).dataset.codeFile !== row.path) return;
  if (!response?.ok) { body.textContent = data.error || I18N.t("读不出这个文件的改动"); return; }
  body.innerHTML = codeDiffHtml(data.text) + (data.truncated ? `<span class="cd-line cd-meta">${esc(I18N.t("改动太长，后面没有显示。"))}</span>` : "");
  body.scrollTop = 0;
}

async function codeDiscard(box, row) {
  const yes = await askConfirm({ title: I18N.t("放弃「{n}」的改动？", { n: row.path }), hint: "文件回到上次提交的样子，这些改动找不回来。", ok: "放弃改动", danger: true });
  if (!yes) return;
  const response = await fetch("/api/code/discard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: row.path }) }).catch(() => null);
  const data = response ? await response.json().catch(() => ({})) : {};
  if (!response?.ok) { toast(data.error || I18N.t("放弃改动失败"), "circle-x"); return; }
  await codeRefresh();
  if (!(codeStatus?.files || []).length) codeCloseReview(); else codeRenderReview(box);
}

function codeRenderReview(box) {
  const files = codeStatus?.files || [];
  box.querySelector(".code-files").innerHTML = files.map((row) => `<button type="button" data-code-file="${esc(row.path)}" title="${esc(row.path)}"><span class="code-file-name">${esc(row.path.split("/").pop())}</span><small>${esc(I18N.t(CODE_STATE_TEXT[row.state] || "修改"))}${row.add || row.del ? ` <i class="cd-n-add">+${row.add}</i> <i class="cd-n-del">−${row.del}</i>` : ""}</small></button>`).join("")
    + (codeStatus?.more ? `<p>${esc(I18N.t("还有 {n} 个文件没列出。", { n: codeStatus.more }))}</p>` : "");
  box.querySelectorAll("[data-code-file]").forEach((el) => el.addEventListener("click", () => codeShowFile(box, files.find((row) => row.path === el.dataset.codeFile))));
  if (files[0]) codeShowFile(box, files[0]);
}

function codeOpenReview() {
  if (!(codeStatus?.files || []).length) return;
  codeCloseReview();
  const box = document.createElement("div");
  box.id = "code-review"; box.className = "code-review"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-label", I18N.t("查看改动"));
  box.innerHTML = `<div class="code-review-card"><header><b>${esc(I18N.t("未提交的改动"))}</b><span>${esc(codeStatus.branch || "")}</span><button type="button" class="icon-btn" data-code-close aria-label="${esc(I18N.t("关闭"))}">${ic("x")}</button></header><div class="code-review-main"><nav class="code-files"></nav><section class="code-diff"><div class="code-diff-head"></div><pre class="code-diff-body"></pre></section></div></div>`;
  document.body.appendChild(box);
  box.addEventListener("click", (event) => { if (event.target === box) codeCloseReview(); });
  box.querySelector("[data-code-close]").addEventListener("click", codeCloseReview);
  document.addEventListener("keydown", codeReviewKey, true);
  codeRenderReview(box);
}

document.getElementById("lane-tabs")?.addEventListener("click", () => setTimeout(codeRefresh, 0));
codeRefresh();
