// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
// Opening never sends a prompt. Files become sandbox-accessible working copies;
// the user decides what the agent should do next in the normal conversation.
(() => {
  let busy = false;
  const button = document.getElementById("open-document");
  const expand = document.getElementById("pv-expand");
  if (expand) expand.onclick = () => {
    const on = document.getElementById("preview-panel").classList.toggle("pv-expanded");
    expand.setAttribute("aria-label", on ? "收起预览" : "展开预览"); expand.title = on ? "收起预览" : "展开预览"; expand.setAttribute("aria-expanded", String(on));
  };
  const picker = document.createElement("input"); picker.type = "file"; picker.multiple = true; picker.hidden = true;
  document.body.append(picker);
  const ready = () => !!settingsCache && (typeof currentUser === "undefined" || !!currentUser || settingsCache.solo);
  async function opened(items) {
    const first = items[0]; if (!first) return;
    await previewFile(first.path, first.root || "");
    inputEl.focus();
    toast("已打开工作副本，原文件未改动。可以直接描述修改要求", "file");
  }
  async function nativeOpen(token) {
    if (busy || !ready()) return;
    busy = true; if (button) button.disabled = true;
    try {
      // File opening starts a separate conversation so it cannot steer an
      // unrelated running task. The existing new-task flow preserves drafts.
      const sid = "s_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
      const { data, why } = await postJson("/api/desktop/open-files", { session: sid, ...(token ? { token } : { pick: true }) }, 16 * 60 * 1000);
      if (!data?.ok) throw Error(data?.error || why);
      for (const error of data.errors || []) toast(error.name + "：" + error.error, "circle-x");
      if (!data.files?.length) return;
      document.getElementById("new-task").click();
      sessionId = sid;
      if (typeof adoptTaskBillingScope === "function") adoptTaskBillingScope(sid);
      const attached = [];
      for (const file of data.files || []) {
        const item = makeAttachItem(file.name, { size: file.size }); addAttachChip(item);
        item.path = file.path; item.root = data.root || ""; item.sid = sid; memoAttach(sid, item.name, item.path); setAttachState(item, "done"); attached.push(item);
      }
      await opened(attached);
    } catch (error) { toast(error.message || "文件没能打开", "circle-x"); }
    finally { busy = false; if (button) button.disabled = false; }
  }
  window.owbOpenFiles = (token) => {
    if (!ready() || busy) return false;
    nativeOpen(token); return true;
  };
  picker.onchange = async () => {
    if (!picker.files.length) return;
    document.getElementById("new-task").click();
    await opened(await uploadFiles(picker.files)); picker.value = "";
  };
  const pick = () => { if (canOpenOnHost()) nativeOpen(""); else picker.click(); };
  if (button) button.onclick = pick;
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") { event.preventDefault(); pick(); }
  });
})();
