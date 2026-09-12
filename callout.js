"use strict";
/**
 * 正文里的提示条。服务端只写一种：`> [!warn] 正文`。
 *
 * 网页端的 markdown 渲染器把它画成带图标的提示条（public/js/app-01.js）；
 * 终端和 IM 那边没有图标，用 strip() 换成「注意 · 」这样的文字标签——
 * 别让用户在飞书里看见 [!warn] 这种记号。
 */
const LABEL = { warn: "注意", wait: "进行中", ok: "已完成", stop: "已中止" };
const KINDS = Object.keys(LABEL).join("|");

/** 拼一条提示条。agent.js 一次 emit 一整条，所以流式切片不会把记号切成两半 */
function line(kind, text) {
  return `\n\n> [!${kind}] ${text}\n\n`;
}

/** 把记号换成文字标签。认不出的记号原样留着，宁可露出来也别把正文吃掉 */
function strip(s) {
  return String(s == null ? "" : s).replace(
    new RegExp(`^([ \\t]*>[ \\t]?)\\[!(${KINDS})\\][ \\t]*`, "gm"),
    (_, quote, kind) => `${quote}${LABEL[kind]} · `
  );
}

module.exports = { LABEL, line, strip };
