// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
// This frame has an opaque origin. Only the parent supplies bytes; document links
// and resources cannot access application cookies, local files or the network.
(() => {
  const english = new URL(location.href).searchParams.get("lang") === "en";
  if (english) {
    document.documentElement.lang = "en";
    document.getElementById("fit").textContent = "Fit width";
    document.getElementById("less").setAttribute("aria-label", "Zoom out"); document.getElementById("more").setAttribute("aria-label", "Zoom in");
    document.querySelector("body>footer").textContent = "Layout preview · Missing fonts may affect appearance";
  }
  const ofdModuleURL = new URL("/vendor/ofd/index.js", document.currentScript.src).href;
  const msdocBaseURL = new URL("/vendor/msdoc/", document.currentScript.src).href;
  const pages = document.getElementById("pages"), status = document.getElementById("status"), scroll = document.getElementById("scroll");
  let zoom = 1, fit = true, width = 800, accepted = false;
  function resize() {
    const z = fit ? Math.min(1, (scroll.clientWidth - 16) / width) : zoom;
    pages.style.zoom = String(Math.max(.15, z));
    document.getElementById("fit").textContent = fit ? (english ? "Fit width" : "适合宽度") : Math.round(z * 100) + "%";
  }
  document.getElementById("fit").onclick = () => { fit = true; resize(); };
  for (const [id, delta] of [["less", -.1], ["more", .1]]) document.getElementById(id).onclick = () => {
    zoom = Math.max(.2, Math.min(2.5, (fit ? Number(pages.style.zoom) || 1 : zoom) + delta)); fit = false; resize();
  };
  new ResizeObserver(resize).observe(scroll);
  addEventListener("message", async (event) => {
    const m = event.data;
    if (event.source !== parent || accepted || !m || m.type !== "owb-document" || !(m.bytes instanceof ArrayBuffer)) return;
    accepted = true;
    try {
      if (m.bytes.byteLength > 50 * 1024 * 1024) throw Error("文件超过 50 MB，请使用本机办公软件打开。");
      if (m.kind === "ofd") {
        const lib = await import(ofdModuleURL);
        const doc = await lib.readOfd(new Uint8Array(m.bytes));
        const count = lib.getPageCount(doc);
        if (!count || count > 300) throw Error("OFD 页数为空或超过 300 页预览上限。");
        const first = await lib.getPageDimensions(doc, 0);
        width = Math.max(1, first.width * 96 / 25.4);
        const observer = new IntersectionObserver((entries) => {
          for (const entry of entries) if (entry.isIntersecting) {
            observer.unobserve(entry.target);
            const i = Number(entry.target.dataset.page);
            lib.renderPageToCanvas(doc, i, entry.target, { dpi: 96 }).catch(() => { status.textContent = "部分页面无法还原，请用原阅读器核对"; });
          }
        }, { root: scroll, rootMargin: "800px" });
        for (let i = 0; i < count; i++) {
          const size = await lib.getPageDimensions(doc, i);
          if (size.width * size.height > 4e6) throw Error("页面尺寸超出预览上限。");
          const canvas = document.createElement("canvas"); canvas.dataset.page = String(i);
          canvas.style.width = size.width * 96 / 25.4 + "px"; canvas.style.height = size.height * 96 / 25.4 + "px";
          pages.append(canvas); observer.observe(canvas);
        }
        status.textContent = english ? "OFD · " + count + " pages · Signatures not verified" : "OFD · " + count + " 页 · 印章显示不代表已验签";
      } else if (m.kind === "msdoc" || m.kind === "html-doc") {
        const paper = document.createElement("section"); paper.className = "legacy-paper";
        paper.style.cssText = "background:#fff;color:#111;width:794px;min-height:1123px;padding:72px;box-shadow:0 2px 12px #0002;overflow-wrap:anywhere";
        const shadow = paper.attachShadow({ mode: "open" });
        if (m.kind === "msdoc") {
          const [{ parseMsDoc }, { renderMsDoc }] = await Promise.all([import(msdocBaseURL + "msdoc/parser.js"), import(msdocBaseURL + "render/html.js")]);
          const data = renderMsDoc(parseMsDoc(m.bytes), { externalLinkPolicy: "block", externalResourcePolicy: "block" });
          shadow.innerHTML = `<style>${data.css}</style><div class="msdoc-root">${data.html}</div>`;
        } else {
          const head = new TextDecoder().decode(new Uint8Array(m.bytes).slice(0, 1024));
          const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] || "utf-8";
          const doc = new DOMParser().parseFromString(new TextDecoder(charset).decode(m.bytes), "text/html");
          for (const el of doc.querySelectorAll("script,iframe,frame,object,embed,form,link,meta,base")) el.remove();
          for (const el of doc.querySelectorAll("*")) for (const a of [...el.attributes]) if (/^on/i.test(a.name) || /^(href|srcdoc|action|formaction)$/i.test(a.name) || (a.name === "src" && !/^data:image\//i.test(a.value))) el.removeAttribute(a.name);
          for (const style of doc.head.querySelectorAll("style")) shadow.append(style);
          shadow.append(...doc.body.childNodes);
        }
        pages.append(paper); width = 794; status.textContent = english ? "DOC · Compatibility preview" : "DOC · 兼容版式预览";
      } else {
        await window.docx.renderAsync(m.bytes, pages, null, {
          className: "docx", inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false,
          renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
          useBase64URL: true, renderAltChunks: false, experimental: false,
        });
        const sheets = pages.querySelectorAll("section.docx");
        width = Math.max(1, ...[...sheets].map(s => s.offsetWidth));
        // External relationships remain inert even when a renderer emits links.
        for (const a of pages.querySelectorAll("a")) a.removeAttribute("href");
        status.textContent = "Word · " + sheets.length + (english ? " pages" : " 页");
      }
      resize();
      parent.postMessage({ type: "owb-document-ready" }, "*");
    } catch (error) {
      status.textContent = "版式预览未完成";
      pages.replaceChildren(); const message = document.createElement("div"); message.className = "doc-error";
      message.textContent = error.message || "这个文档暂时无法还原版式"; pages.append(message);
      parent.postMessage({ type: "owb-document-error", message: message.textContent }, "*");
    }
  });
  parent.postMessage({ type: "owb-document-frame" }, "*");
})();
