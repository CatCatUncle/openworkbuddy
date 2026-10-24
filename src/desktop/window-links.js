// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"use strict";

/** 工作台链接交回主窗口；成果预览和外部链接仍走各自的打开方式。 */
function workbenchLink(url, origin) {
  try {
    const u = new URL(url);
    if (u.origin !== origin) return null;
    const pathname = decodeURIComponent(u.pathname).replace(/\/{2,}/g, "/");
    if (pathname !== "/" && pathname !== "/index.html") return null;
    const sid = u.searchParams.get("s") || "";
    return { sessionId: /^[\w-]{1,80}$/.test(sid) ? sid : "" };
  } catch { return null; }
}

module.exports = { workbenchLink };
