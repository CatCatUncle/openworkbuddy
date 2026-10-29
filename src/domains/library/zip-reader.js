// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const fs = require("fs"), zlib = require("zlib");
const LIMITS = { zipBytes: 200 * 1024 * 1024, entries: 5000 };
// ---------------- 最小 zip 读取器 ----------------
// OOXML 就是 zip：读中央目录拿到条目表，按需 inflate 单个条目。只支持 stored(0) 和 deflate(8)，
// 这两种覆盖了 Word/Excel/PowerPoint/我们自己用 docx 与 pptxgenjs 生成的全部文件。
// zip64 也认：有的导出工具不管文件多小都写成 zip64，以前这类文件一律打不开。
function readZip(file) {
  const st = fs.statSync(file);
  if (st.size > LIMITS.zipBytes) throw new Error(`文件太大（${(st.size / 1048576).toFixed(0)} MB），没法在应用内展开`);
  const buf = fs.readFileSync(file);
  // 尾部 22 字节是 EOCD，但后面可能挂着注释，所以从尾巴往前扫（注释最长 65535）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 zip / Office 文件（找不到中央目录）");
  let count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff || count === 0xffff) {
    // zip64：EOCD 前面 20 字节是定位记录，指向真正的 zip64 目录尾
    const loc = eocd - 20;
    const z = loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50 ? Number(buf.readBigUInt64LE(loc + 8)) : -1;
    if (z < 0 || z + 56 > buf.length || buf.readUInt32LE(z) !== 0x06064b50) throw new Error("zip64 目录尾损坏，读不出这个文件");
    count = Number(buf.readBigUInt64LE(z + 32));
    off = Number(buf.readBigUInt64LE(z + 48));
  }

  const entries = [];
  let expanded = 0;
  for (let k = 0; k < count && k < LIMITS.entries; k++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const nlen = buf.readUInt16LE(off + 28);
    const xlen = buf.readUInt16LE(off + 30);
    const e = {
      method: buf.readUInt16LE(off + 10),
      csize: buf.readUInt32LE(off + 20),
      size: buf.readUInt32LE(off + 24),
      lho: buf.readUInt32LE(off + 42),
      name: buf.toString("utf8", off + 46, off + 46 + nlen),
    };
    if (e.size === 0xffffffff || e.csize === 0xffffffff || e.lho === 0xffffffff) {
      // 真实的大小/位置在扩展字段 0x0001 里，只放了那几个写成 0xffffffff 的，顺序固定
      for (let x = off + 46 + nlen, end = x + xlen; x + 4 <= end;) {
        const id = buf.readUInt16LE(x), len = buf.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          const next = () => { const v = q + 8 <= x + 4 + len ? Number(buf.readBigUInt64LE(q)) : -1; q += 8; return v; };
          if (e.size === 0xffffffff) e.size = next();
          if (e.csize === 0xffffffff) e.csize = next();
          if (e.lho === 0xffffffff) e.lho = next();
          break;
        }
        x += 4 + len;
      }
    }
    e.dir = e.name.endsWith("/");
    entries.push(e);
    off += 46 + nlen + xlen + buf.readUInt16LE(off + 32);
  }

  const read = (e) => {
    if (!e || e.dir) return null;
    if (e.lho < 0 || e.lho + 30 > buf.length || buf.readUInt32LE(e.lho) !== 0x04034b50) throw new Error("zip 局部头损坏：" + e.name);
    // 局部头里的名字/扩展字段长度可能和中央目录不一样，必须以局部头为准
    const start = e.lho + 30 + buf.readUInt16LE(e.lho + 26) + buf.readUInt16LE(e.lho + 28);
    if (!Number.isSafeInteger(e.size) || e.size < 0 || e.size > 32 * 1024 * 1024 || start + e.csize > buf.length) throw new Error("文档条目过大或目录损坏，无法安全预览");
    const raw = buf.subarray(start, start + e.csize);
    let out;
    if (e.method === 0) out = Buffer.from(raw);
    else if (e.method === 8) out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size + 1) });
    else throw new Error(`条目 ${e.name} 用了不支持的压缩方式 ${e.method}`);
    if (out.length !== e.size || (expanded += out.length) > 256 * 1024 * 1024) throw new Error("文档展开内容超出预览预算或大小不匹配");
    return out;
  };
  const byName = new Map(entries.map((e) => [e.name, e]));
  return {
    entries,
    read,
    get: (n) => read(byName.get(n)),
    text: (n) => { const b = read(byName.get(n)); return b ? b.toString("utf8") : null; },
    has: (n) => byName.has(n),
  };
}


module.exports = { readZip };
