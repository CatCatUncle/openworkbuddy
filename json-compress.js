"use strict";
/**
 * 动态 JSON 响应的压缩层。
 *
 * static-compress.js 只管磁盘上的静态文件，那段注释里写死了一句
 * 「一个字节的动态响应都不经过它」——当时是对的，因为这台服务器上跑着 SSE，
 * 通用压缩中间件会把流攒成块，「正在打字」变成「卡住不动然后哗一下全出来」。
 *
 * 可代价是最大的那几个响应全裸奔。2026-09-17 实测本机真实数据：
 *
 *     GET /api/session/:id   936 KB   ← 一次切任务就是这么多，每切一次重来一遍
 *       gzip(6)              258 KB   压到 28%，服务端花 17 ms
 *       brotli(5)            189 KB   压到 20%
 *
 * 936 KB 在回环地址上确实看不出来。但网页版真正被用的场景是 SSH 隧道、手机流量、
 * 局域网另一头那台机器——那就是实打实的等，而且**每切一次任务等一次**。
 *
 * 为什么这一层可以不碰 SSE：它只包 `res.json`。SSE 三个端点（cli-live、chat、
 * chat/stream）在挂上 `text/event-stream` 之后一律走 `res.write`，一次都不会调
 * `res.json`——它们调 json 的地方全在设头之前的 early return（未登录、404）。
 * 也就是说「不碰流」不是靠约定，是结构上就够不着。保险起见再看一眼 Content-Type，
 * 已经是 event-stream 的直接原样放行。
 *
 * 缓存语义交回 express：压完的 Buffer 照样走 res.send，ETag / Content-Length
 * 由它按最终字节算。这一层只改「路上传多少字节」。
 */

const zlib = require("zlib");
const { _internals } = require("./static-compress");
const { pickEncoding } = _internals;

/** 比这个小就别压了：省下的字节还不够那两行响应头，CPU 倒是白烧 */
const MIN_BYTES = 2048;
/**
 * brotli 质量。静态那边用 5（压一次缓存住，慢点无所谓）；这里是**每个请求现压**，
 * 4 比 5 快一截而体积只差百分之几，动态响应更该省这口 CPU。
 */
const BR_QUALITY = 4;
const GZIP_LEVEL = 6;

/**
 * 压缩一律走异步。
 *
 * 这一条是硬要求，不是风格偏好：brotliCompressSync 压那 936 KB 实测要 33 ms，
 * 而这 33 ms 是**卡在事件循环上**的。同一时刻多半正有一条 SSE 在往外吐字——
 * 于是「用户切了下任务」就变成「所有人的正在打字卡一下」。修好一个慢换来一个更难受的
 * 慢，static-compress.js 开头拒绝通用压缩中间件就是为了躲这个，这里不能自己踩回去。
 * 异步版跑在 libuv 线程池上，主线程该推流推流。
 */
function compress(buf, enc, cb) {
  if (enc === "br") {
    return zlib.brotliCompress(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: BR_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    }, cb);
  }
  return zlib.gzip(buf, { level: GZIP_LEVEL }, cb);
}

/**
 * @param {{minBytes?: number}} [opts]
 * @returns {import("express").RequestHandler}
 */
function createJsonCompress(opts) {
  const minBytes = (opts && opts.minBytes) || MIN_BYTES;
  return function jsonCompress(req, res, next) {
    const orig = res.json.bind(res);
    res.json = (body) => {
      let enc = null;
      let buf = null;
      try {
        // 已经是流了（理论上到不了这儿，见文件头）：原样放行，绝不插手
        const ct = String(res.getHeader("Content-Type") || "");
        if (ct.includes("event-stream")) return orig(body);
        // 上游自己已经定了编码（比如原样转发一段压好的内容）：别压第二遍
        if (res.getHeader("Content-Encoding")) return orig(body);
        enc = pickEncoding(req.headers["accept-encoding"]);
        if (!enc) return orig(body);
        const json = JSON.stringify(body);
        if (json === undefined) return orig(body);
        buf = Buffer.from(json, "utf8");
        if (buf.length < minBytes) return orig(body);
      } catch {
        // 序列化出任何岔子都退回原来的路：宁可不压，不许把一个正常响应搞没了
        return orig(body);
      }
      compress(buf, enc, (err, out) => {
        // 压不出来就退回原文。这里只能走 orig(body)：res.json 已经被换掉了，
        // 调它自己会绕回来无限套娃
        if (err || res.writableEnded) {
          if (!res.writableEnded) { res.removeHeader("Content-Encoding"); orig(body); }
          return;
        }
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Encoding", enc);
        // 同一个 URL 压过和没压过是两份字节，中间任何一层缓存都必须按这个头分开存
        res.vary("Accept-Encoding");
        res.send(out);
      });
      return res;
    };
    next();
  };
}

module.exports = { createJsonCompress, _internals: { compress, MIN_BYTES, BR_QUALITY } };
