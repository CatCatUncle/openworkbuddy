"use strict";
/**
 * 终端里的显示宽度。
 *
 * 中日韩字符在等宽终端里占两列，而 String.prototype.padEnd 数的是码位。
 * 拿 padEnd 去对一列中文，结果是每一行都参差不齐——帮助文本和体检报告都栽过这个跟头。
 * 所以对齐一律走这里，两处共用一份，不各写各的。
 */

// 全角区间：中日韩、谚文、兼容表意、全角标点
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

/** 这串字在终端里占几列 */
const cols = (s) => Array.from(String(s)).reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);

/** 补空格补到 n 列宽（已经超了就原样返回，不截断——宁可这一行难看，也别把字吃掉） */
const padCols = (s, n) => String(s) + " ".repeat(Math.max(0, n - cols(s)));

module.exports = { cols, padCols, WIDE };
