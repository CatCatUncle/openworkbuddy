// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
window.OWBDocumentViewer = {
  async mount(host, url, kind, { signal } = {}) {
    const frame = document.createElement("iframe"); frame.className = "document-frame";
    frame.title = kind === "ofd" ? "OFD 版式预览" : "Word 版式预览";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.cssText = "display:block;width:100%;height:100%;min-height:450px;border:0;flex:1";
    const response = await fetch(url, { signal });
    if (!response.ok) throw Error(response.status === 404 ? "文件不存在" : "文档读取失败");
    const limit = 50 * 1024 * 1024;
    if (Number(response.headers.get("Content-Length")) > limit) { await response.body?.cancel(); throw Error("文件超过 50 MB，请使用本机办公软件打开"); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) { await reader.cancel(); throw Error("文件超过 50 MB，请使用本机办公软件打开"); } chunks.push(value);
    }
    if (!host.isConnected || signal?.aborted) return;
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); window.removeEventListener("message", onMessage); observer.disconnect(); signal?.removeEventListener("abort", aborted); };
      const aborted = () => { cleanup(); frame.remove(); resolve(null); };
      const onMessage = (event) => {
        if (event.source !== frame.contentWindow) return;
        if (event.data?.type === "owb-document-frame") frame.contentWindow.postMessage({ type: "owb-document", kind, bytes: bytes.buffer }, "*", [bytes.buffer]);
        if (event.data?.type === "owb-document-ready") { cleanup(); resolve(frame); }
        if (event.data?.type === "owb-document-error") { cleanup(); reject(Error(event.data.message)); }
      };
      const observer = new MutationObserver(() => { if (!frame.isConnected) { cleanup(); resolve(null); } });
      observer.observe(host, { childList: true });
      signal?.addEventListener("abort", aborted, { once: true });
      window.addEventListener("message", onMessage);
      frame.src = "/document-preview.html?lang=" + (typeof I18N !== "undefined" ? I18N.getLang() : "zh"); host.replaceChildren(frame);
      timer = setTimeout(() => { cleanup(); reject(Error("版式预览超时，可以切换到文字视图或用本机软件打开")); }, 45000);
    });
  },
};
