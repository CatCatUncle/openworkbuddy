// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 资料库的封面、正文摘录、收藏：
 *   POST /api/library/covers      一屏文件要封面：能给地址的给地址，要排队的排队，永远出不来的直接说用图标
 *   GET  /api/library/cover       封面图本身（按请求人的根重新解析、重算缓存键，对不上就 404）
 *   POST /api/library/excerpts    文本文件的开头几行（只读前 16KB）
 *   POST /api/library/favorite    收藏 / 取消收藏
 *   GET  /api/library/favorites   我收藏过的，文件没了的标 missing
 *
 * 两种来源、一套规矩：src "lib" 是资料库里的相对路径（按 libraryRootOf(请求人) 解析），
 * src "ws" 是工作区里的相对路径（跟 /api/files/view/ 同一条 rootedPath）。
 * 一律只在**请求人自己的**根下面找：`..`、绝对路径、软链接指到根外面的，统统拒绝——
 * safePathIn 只看字面，软链接它看不出来，所以最后再拿 realpath 复核一遍。
 *
 * 写法照 src/server/routes/canvas.js：路由写在顶层、依赖做成模块级变量，createLibraryRouter(deps) 一次填上
 * （测试按顶格函数名切源码，缩进进工厂函数就切不出来了）。依赖全从 server.js 递进来，不回头 require 它。
 */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const express = require("express");
const { StringDecoder } = require("string_decoder");
const libCover = require("../../domains/library/lib-cover");
const libFavs = require("../../domains/library/lib-favs");

// 下面这几个由 createLibraryRouter(deps) 填上
let libraryRootOf, rootedPath, rootOfResolved, getWorkspaceDir, safePathIn;
/** @type {ReturnType<typeof libCover.createCoverQueue> | null} */
let coverQueue = null;

const app = express.Router({ caseSensitive: true });

const EXCERPT_MAX_ITEMS = 40;
const EXCERPT_HEAD_BYTES = 16 * 1024;
const EXCERPT_MAX_LINES = 20;
const EXCERPT_MAX_CHARS = 1200;
// 比这还大的文本多半是日志、导出的数据：只读开头 16KB 本身不贵，可 iCloud「优化储存」的目录里
// 读一个字节就会把整份从云上拉下来。卡片上几行字不值得为它下载几百 MB
const EXCERPT_MAX_FILE_BYTES = 64 * 1024 * 1024;
// 这些后缀连开都不开：图片、压缩包、Office、音视频、字体、数据库。按内容判也判得出来，
// 但打开一个云盘上的 2GB 视频只为了看它是不是文本，不划算
const EXCERPT_BINARY_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|heic|heif|tiff?|psd|pdf|docx?|xlsx?|pptx?|key|pages|numbers|zip|rar|7z|gz|tgz|bz2|xz|tar|dmg|pkg|exe|dll|so|dylib|bin|iso|mp3|mp4|m4a|m4v|mov|webm|mkv|avi|wav|flac|aac|ogg|opus|woff2?|ttf|otf|eot|sqlite3?|db|class|jar|wasm)$/i;

/** 带一个 skip 原因的错：denied（不许看）/ missing（没有这个文件） */
function libItemSkip(skip, msg) {
  return Object.assign(new Error(msg), { skip });
}

/**
 * {src, path} → 请求人自己的根下面那个真实文件。
 * 拒绝：src 不认识、路径是绝对的、带 `..`、带控制字符；资料库那一支还拒绝点开头的段
 * （跟 server.js 的 libPath 一个口径：.favorites.json、.inspirations.json 不许被当成资料读出来）；
 * 最后按 realpath 复核一遍——根里一根软链接指到 ~/.ssh，字面上看它是在根里的。
 * @returns {{ src: string, rel: string, abs: string, real: string, root: string, st: fs.Stats }}
 */
function libItemResolve(req, src, raw) {
  const s = String(src || "");
  if (s !== "lib" && s !== "ws") throw libItemSkip("denied", "src 只能是 lib 或 ws");
  const text = typeof raw === "string" ? raw : "";
  if (!text || text.length > 4096 || /[\u0000-\u001f]/.test(text)) throw libItemSkip("denied", "路径不合法");
  const norm = text.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm) || path.isAbsolute(text)) throw libItemSkip("denied", "只收相对路径");
  const parts = norm.split("/").filter((x) => x && x !== ".");
  if (!parts.length || parts.includes("..")) throw libItemSkip("denied", "路径不合法");
  if (s === "lib" && parts.some((x) => x.startsWith(".") || /[<>:"|?*]/.test(x))) throw libItemSkip("denied", "路径不合法");
  const rel = parts.join("/");
  let root, abs;
  try {
    if (s === "lib") { root = libraryRootOf(req.user); abs = safePathIn(root, rel); }
    else { abs = rootedPath(req, rel); root = rootOfResolved(abs, rel) || getWorkspaceDir(); }
  } catch { throw libItemSkip("denied", "路径越界"); }
  let realRoot, real;
  try { realRoot = fs.realpathSync(root); } catch { throw libItemSkip("missing", "文件不存在"); }
  try { real = fs.realpathSync(abs); } catch { throw libItemSkip("missing", "文件不存在"); }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw libItemSkip("denied", "路径越界");
  let st;
  try { st = fs.statSync(real); } catch { throw libItemSkip("missing", "文件不存在"); }
  if (!st.isFile()) throw libItemSkip("missing", "不是文件");
  return { src: s, rel, abs, real, root, st };
}

/**
 * 图片不用排队：直接给 /api/library/file/ 或 /api/files/view/ 的缩略图地址，v 跟 viewCacheHeader 对得上才长期缓存。
 * 多带一个 s=体积：只按秒记 mtime 的盘上（FAT / 部分网络盘），同一秒里重写一张图 mtime 不变，
 * 地址不变浏览器就一直拿 7 天缓存里的旧图；体积进了地址，内容一变地址就跟着变。
 */
function coverImageUrl(r, w) {
  const segs = r.rel.split("/").map(encodeURIComponent).join("/");
  const base = r.src === "lib" ? "/api/library/file/" : "/api/files/view/";
  return `${base}${segs}?thumb=${libCover.coverTarget(w)}&v=${encodeURIComponent(r.st.mtime.toISOString())}&s=${r.st.size}`;
}

/** 按文件头认图片类型：视频帧那条路出的可能是 JPEG，扩展名一律 .png，Content-Type 照实给 */
function coverMimeOf(head) {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "image/png";
}

app.post("/api/library/covers", async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.items)) return res.status(400).json({ error: "items 要是一个列表" });
  if (body.items.length > libCover.COVER_MAX_ITEMS) return res.status(400).json({ error: `一次最多问 ${libCover.COVER_MAX_ITEMS} 张封面` });
  const w = body.w == null ? 320 : Number(body.w);
  if (!libCover.COVER_WIDTHS.has(w)) return res.status(400).json({ error: "w 只能是 160、320、640" });
  const userRoot = libraryRootOf(req.user);
  const out = { ready: {}, queued: [], icon: [] };
  for (const it of body.items) {
    const id = it && (typeof it.id === "string" || typeof it.id === "number") ? String(it.id) : "";
    if (!id) continue;
    let r;
    try { r = libItemResolve(req, it.src, it.path); } catch { out.icon.push(id); continue; }
    if (libCover.coverKindOf(r.rel) === "image") { out.ready[id] = coverImageUrl(r, w); continue; }
    let a;
    try { a = await coverQueue.ask({ userRoot, src: r.src, rel: r.rel, abs: r.real, st: r.st, w, root: r.root }); } catch { a = { icon: true }; }
    if ("ready" in a) out.ready[id] = a.ready;
    else if ("queued" in a) out.queued.push(id);
    else out.icon.push(id);
  }
  res.json(out);
});

app.get("/api/library/cover", async (req, res) => {
  const q = req.query || {};
  const w = Number(q.w);
  if (!libCover.COVER_WIDTHS.has(w)) return res.status(400).send("w 只能是 160、320、640");
  let r;
  try { r = libItemResolve(req, q.src, q.path); } catch (e) {
    return res.status(e && e.skip === "missing" ? 404 : 400).send((e && e.message) || "路径不合法");
  }
  const file = coverQueue.cachedFile({ userRoot: libraryRootOf(req.user), src: r.src, abs: r.real, st: r.st, w });
  let head;
  try {
    const fh = await fsp.open(file, "r");
    try { const b = Buffer.alloc(12); const { bytesRead } = await fh.read(b, 0, 12, 0); head = b.subarray(0, bytesRead); } finally { await fh.close(); }
  } catch { return res.status(404).send("封面还没有出来"); }
  // 地址上的版本号对得上这一版文件才让浏览器留七天；文件改过，老地址每次回来核对
  res.set("Cache-Control", String(q.v || "") === libCover.coverVersion(r.st) ? "private, max-age=604800" : "private, no-cache");
  res.set("Content-Type", coverMimeOf(head));
  res.sendFile(file);
});

/**
 * 读开头 16KB，切成最多 20 行、总共 1200 字。行原样给（不 trim），\r\n 按一行算。
 * 有 NUL、或者解出来的乱码（U+FFFD）超过 2%，按二进制算。多字节字符被 16KB 那一刀切开的半个字不算乱码
 * （StringDecoder 会把它留着不吐出来）。
 */
async function excerptRead(real, st) {
  const n = Math.min(EXCERPT_HEAD_BYTES, st.size);
  const buf = Buffer.alloc(n);
  let got = 0;
  const fh = await fsp.open(real, "r");
  try { got = (await fh.read(buf, 0, n, 0)).bytesRead; } finally { await fh.close(); }
  const head = buf.subarray(0, got);
  if (head.includes(0)) return { skip: "binary" };
  let text = new StringDecoder("utf8").write(head);
  const bad = (text.match(/�/g) || []).length;
  if (bad > Math.max(4, text.length * 0.02)) return { skip: "binary" };
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const whole = got >= st.size;
  const all = text.split(/\r?\n/);
  if (whole && all.length > 1 && all[all.length - 1] === "") all.pop(); // 文件以换行结尾：最后那个空串不是一行
  const lines = [];
  let chars = 0;
  let truncated = !whole;
  for (let i = 0; i < all.length; i++) {
    if (lines.length >= EXCERPT_MAX_LINES) { truncated = true; break; }
    const room = EXCERPT_MAX_CHARS - chars;
    if (room <= 0) { truncated = true; break; }
    const line = all[i];
    if (line.length > room) { lines.push(line.slice(0, room)); truncated = true; break; }
    lines.push(line);
    chars += line.length;
  }
  return { lines, truncated };
}

app.post("/api/library/excerpts", async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.items)) return res.status(400).json({ error: "items 要是一个列表" });
  if (body.items.length > EXCERPT_MAX_ITEMS) return res.status(400).json({ error: `一次最多要 ${EXCERPT_MAX_ITEMS} 份摘录` });
  const items = {};
  for (const it of body.items) {
    const id = it && (typeof it.id === "string" || typeof it.id === "number") ? String(it.id) : "";
    if (!id) continue;
    let r;
    try { r = libItemResolve(req, it.src, it.path); } catch (e) { items[id] = { skip: (e && e.skip) || "denied" }; continue; }
    if (EXCERPT_BINARY_RE.test(r.rel)) { items[id] = { skip: "binary" }; continue; }
    if (r.st.size > EXCERPT_MAX_FILE_BYTES) { items[id] = { skip: "too_big" }; continue; }
    try { items[id] = await excerptRead(r.real, r.st); } catch { items[id] = { skip: "missing" }; }
  }
  res.json({ items });
});

app.post("/api/library/favorite", async (req, res) => {
  const body = req.body || {};
  if (typeof body.on !== "boolean") return res.status(400).json({ error: "on 要是 true 或 false" });
  let rel = typeof body.path === "string" ? body.path : "";
  const meta = {};
  if (body.on) {
    // 收藏要求文件此刻就在：收藏一个解析不出来的路径，列表里就是一条永远点不开的
    let r;
    try { r = libItemResolve(req, body.src, body.path); } catch (e) {
      return res.status(e && e.skip === "missing" ? 404 : 400).json({ error: (e && e.message) || "路径不合法" });
    }
    rel = r.rel;
    meta.mtime = r.st.mtime.toISOString();
    meta.size = r.st.size;
  }
  // 取消收藏不查文件在不在：文件没了（missing）的那几条正是最需要能取消的
  try {
    const fav = await libFavs.setFav(libraryRootOf(req.user), { src: body.src, path: rel, on: body.on, ...meta });
    res.json({ ok: true, fav });
  } catch (e) {
    res.status((e && e.status) || 500).json({ error: (e && e.message) || "收藏没存上" });
  }
});

app.get("/api/library/favorites", (req, res) => {
  const items = libFavs.listFavs(libraryRootOf(req.user), (src, rel) => {
    try { return !!libItemResolve(req, src, rel); } catch { return false; }
  });
  res.json({ items });
});

/**
 * @param {{ libraryRootOf: Function, rootedPath: Function, rootOfResolved: Function, getWorkspaceDir: Function,
 *           safePathIn: Function, thumbsDir: string, busy: () => boolean }} deps
 */
function createLibraryRouter(deps) {
  ({ libraryRootOf, rootedPath, rootOfResolved, getWorkspaceDir, safePathIn } = deps);
  coverQueue = libCover.createCoverQueue({ cacheDir: deps.thumbsDir, busy: deps.busy });
  return app;
}

module.exports = { createLibraryRouter, libFavKeys: libFavs.favKeys, libItemResolve, excerptRead, coverImageUrl, EXCERPT_MAX_ITEMS, EXCERPT_HEAD_BYTES, EXCERPT_MAX_LINES, EXCERPT_MAX_CHARS };
