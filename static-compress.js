"use strict";
/**
 * 静态资源压缩。
 *
 * 首屏要下将近 1.9 MB 的文本：index.html 245 KB、八个 app-0*.js 加起来 900 KB、
 * i18n 词典 90 KB，再加上 JointJS 463 KB 和 Dagre 95 KB。express.static 原样发送，
 * 一个字节都不压。
 *
 * 在本机看不出问题——回环地址上 1.9 MB 是两毫秒的事。可一旦它要穿过一条 SSH 隧道、
 * 一根手机信号，或者别人家那台按带宽计费的服务器，这 1.9 MB 就是实打实的十几秒白等，
 * 而且**每开一个新标签页都要再等一次**。这些全是文本，压完只剩三成。
 *
 * 为什么不挂一层通用压缩中间件（compression 那种）：这台服务器上跑着 SSE——
 * 对话是一个字一个字推下去的。通用中间件会把流攒成块再发，于是「正在打字」变成
 * 「卡住不动，然后哗一下全出来」。修好一个慢，换来一个更难受的慢，不划算。
 * 所以这一层**只碰磁盘上的静态文本文件**，一个字节的动态响应都不经过它。
 *
 * 缓存语义原样照抄 express.static（同样的弱 ETag、同样的 public, max-age=0、
 * 同样的 Last-Modified）：这一层只改「路上传多少字节」，不改「浏览器存不存、存多久」。
 * 那是另一件事，要动得单独动。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/** 只压这几类。二进制（图片、字体、wasm）本来就压过了，再压一遍是纯烧 CPU */
const TYPES = {
  ".html": "text/html; charset=UTF-8",
  ".js": "text/javascript; charset=UTF-8",
  ".mjs": "text/javascript; charset=UTF-8",
  ".css": "text/css; charset=UTF-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=UTF-8",
  ".map": "application/json; charset=UTF-8",
  ".txt": "text/plain; charset=UTF-8",
  ".md": "text/markdown; charset=UTF-8",
};
const MIN_BYTES = 1024;             // 比一个 TCP 包还小的东西，省下的还不够那几行响应头
const MAX_BYTES = 16 * 1024 * 1024; // 再大的不往内存里塞，原样交给 express.static
const BR_QUALITY = 5;               // 5 的体积已经很接近 11，耗时只有它的几十分之一

const cache = new Map(); // 绝对路径 → { key, type, etag, mtime, enc: { br?, gzip? } }

/**
 * 客户端认不认这个编码。得看 q 值：`br;q=0` 是「明确不要」，
 * 只按子串判的话会给一个说了不要的客户端发 brotli，那边直接看到乱码。
 */
function accepts(header, enc) {
  const m = new RegExp("(?:^|,)\\s*" + enc + "\\s*(?:;\\s*q\\s*=\\s*([0-9.]+))?(?:\\s|,|;|$)", "i")
    .exec(String(header || ""));
  if (!m) return false;
  return parseFloat(m[1] === undefined ? "1" : m[1]) > 0;
}
function pickEncoding(header) {
  if (accepts(header, "br")) return "br";
  if (accepts(header, "gzip")) return "gzip";
  return null;
}
function compress(buf, enc) {
  return enc === "br"
    ? zlib.brotliCompressSync(buf, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: BR_QUALITY,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
        },
      })
    : zlib.gzipSync(buf, { level: 6 });
}

/**
 * @param roots  [{ prefix, dir }]：URL 前缀 → 磁盘目录。按顺序匹配，第一个命中的算数。
 *   vendor 那两个库不在 public 底下（直接从 node_modules 原样提供），所以要单列。
 */
function createStaticCompress(roots) {
  // 长前缀排前面。不排的话 "/" 会吃掉所有路径——/vendor/joint/joint.min.js 会被
  // 当成 public/vendor/joint/joint.min.js 去找，找不到就放行，于是首屏最大的那 463 KB
  // 一个字节都没压到，而外面看起来一切正常。
  const table = roots
    .map((r) => ({
      prefix: r.prefix.endsWith("/") ? r.prefix : r.prefix + "/",
      dir: path.resolve(r.dir),
    }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  return function staticCompress(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const enc = pickEncoding(req.headers["accept-encoding"]);
    if (!enc) return next();

    let urlPath;
    try { urlPath = decodeURIComponent(req.path); } catch { return next(); }
    if (urlPath.endsWith("/")) urlPath += "index.html";
    const ext = path.extname(urlPath).toLowerCase();
    if (!TYPES[ext]) return next();

    const hit = table.find((r) => urlPath.startsWith(r.prefix));
    if (!hit) return next();
    const file = path.resolve(hit.dir, "." + urlPath.slice(hit.prefix.length - 1));
    // 往上穿目录的请求（..、%2e%2e 之类）到这儿为止：不在挂载目录底下的一律交回去，
    // 由后面的 express.static 按它自己的规矩拒绝。这一层不负责发拒绝信，只负责不参与
    if (file !== hit.dir && !file.startsWith(hit.dir + path.sep)) return next();

    let st;
    try { st = fs.statSync(file); } catch { return next(); }
    if (!st.isFile() || st.size < MIN_BYTES || st.size > MAX_BYTES) return next();

    const key = st.size + ":" + st.mtimeMs;
    let e = cache.get(file);
    if (!e || e.key !== key) {
      // 文件被改过（开发态改一行 js、或者装了新版本）→ 旧的压缩结果连同 ETag 一起作废。
      // 不比对 mtime 的话，改完代码刷新页面拿到的还是上一版，能把人调试到怀疑人生
      e = {
        key,
        type: TYPES[ext],
        // 形状跟 express.static 对齐（整数毫秒）：同一个文件换不换这条中间件，ETag 都一样，
        // 浏览器里已经存着的那份不会因为升级白白作废一次
        etag: `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`,
        mtime: st.mtime.toUTCString(),
        enc: {},
      };
      cache.set(file, e);
    }

    res.setHeader("Content-Type", e.type);
    res.setHeader("ETag", e.etag);
    res.setHeader("Last-Modified", e.mtime);
    res.setHeader("Cache-Control", "public, max-age=0");
    // 少了这行，中间任何一层缓存都可能把压过的那份发给不认压缩的客户端
    res.setHeader("Vary", "Accept-Encoding");
    if (req.headers["if-none-match"] === e.etag) return res.status(304).end();

    if (!e.enc[enc]) e.enc[enc] = compress(fs.readFileSync(file), enc);
    const body = e.enc[enc];
    res.setHeader("Content-Encoding", enc);
    res.setHeader("Content-Length", String(body.length));
    if (req.method === "HEAD") return res.end();
    res.end(body);
  };
}

module.exports = { createStaticCompress, _internals: { accepts, pickEncoding, compress, TYPES, cache } };
