// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 子进程输出（一块块 Buffer）→ 文字。
 *
 * 一般就是 UTF-8。但 Windows 上 cmd 自带的命令（dir、type、ping、systeminfo、net）和不少老程序
 * 往管道里写的是系统代码页，中文系统上是 GBK——按 UTF-8 解出来满屏 �，模型看不懂命令到底说了什么，
 * 只能瞎猜着重试。所以 Windows 上先按 UTF-8 严格解，碰到第一处不合法的字节，这条流剩下的
 * （连同这一块）全改按 GBK 解：同一条流不会两种编码混着写，切一次就够。
 * 别的系统只按 UTF-8，跟以前一样。
 *
 * 半个字被切在两块中间是常事：UTF-8 那段的残尾自己留着拼到下一块；改 GBK 时这段残尾也一起交过去，不丢。
 */
const { StringDecoder } = require("string_decoder");

/** buf 结尾那个没写完的 UTF-8 字从哪开始；结尾是完整的就返回 buf.length */
function utf8Cut(buf) {
  const n = buf.length;
  for (let back = 1; back <= Math.min(3, n); back++) {
    const b = buf[n - back];
    if ((b & 0xc0) === 0x80) continue; // 后续字节，接着往前找领头的
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? n - back : n;
  }
  return n;
}

/**
 * @param {{ win?: boolean, legacy?: string }} [opts] win 默认看本机；legacy 是 Windows 上兜底的编码
 * @returns {{ write: (chunk: Buffer|string) => string, end: () => string, encoding: () => string }}
 */
function outDecoder({ win = process.platform === "win32", legacy = "gbk" } = {}) {
  if (!win) {
    const d = new StringDecoder("utf8");
    return { write: (c) => d.write(Buffer.isBuffer(c) ? c : Buffer.from(String(c))), end: () => d.end(), encoding: () => "utf-8" };
  }
  const strict = new TextDecoder("utf-8", { fatal: true });
  /** @type {TextDecoder | null} */
  let alt = null;
  let carry = Buffer.alloc(0);
  const toAlt = () => {
    try { alt = new TextDecoder(legacy); } catch { alt = new TextDecoder("utf-8"); } // 这份 Node 不认 GBK：退回 UTF-8，至少不抛
  };
  return {
    write(c) {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
      if (alt) return alt.decode(buf, { stream: true });
      const all = carry.length ? Buffer.concat([carry, buf]) : buf;
      const cut = utf8Cut(all);
      try {
        const s = strict.decode(all.subarray(0, cut));
        carry = Buffer.from(all.subarray(cut));
        return s;
      } catch {
        carry = Buffer.alloc(0);
        toAlt();
        return /** @type {TextDecoder} */ (alt).decode(all, { stream: true });
      }
    },
    end() {
      if (alt) return alt.decode();
      if (!carry.length) return "";
      const rest = carry;
      carry = Buffer.alloc(0);
      return new TextDecoder("utf-8").decode(rest); // 流断在半个字上：剩下那几个字节就是 �，没法更好
    },
    encoding: () => (alt ? alt.encoding : "utf-8"),
  };
}

module.exports = { outDecoder, utf8Cut };
