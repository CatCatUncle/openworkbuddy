"use strict";
/**
 * 各 IM 渠道共用的「收附件」底座。
 *
 * 以前只有飞书能收文件，微信/QQ/企微/公众号都是一句「本版暂不下载」的占位——用户在手机上
 * 发过来一份 PDF，agent 只看见一行字，用户以为发到了、其实什么都没收到。更糟的是表情包、
 * 语音这类消息在渠道层直接 return 掉，机器人一声不吭，看起来像死了。
 *
 * 这里统一三件事：
 *   1. 把附件落到工作目录（重名不覆盖、路径穿越挡掉、超大文件不收）；
 *   2. 认不出扩展名的按文件头补一个（微信 CDN 下来的图片是裸字节，没名字）；
 *   3. 给 agent 拼一句人话说明「用户发了什么、存哪了」。
 *
 * 微信 iLink 的附件走腾讯 CDN：正文是 AES-128-ECB 密文，密钥在消息体的 aes_key 里，
 * 协议细节跟 CatClaw 的 wechat-crypto.ts 同源（已在真实微信上跑通）。
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_INBOUND_BYTES = 30 * 1024 * 1024; // 收进来的单个附件上限，超了只留一句说明
const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/** 文件头认扩展名：CDN 下来的是裸字节，没有文件名也没有 Content-Type */
function sniffExt(buf) {
  if (!buf || buf.length < 4) return "";
  const b = buf;
  const ascii = (n) => b.slice(0, n).toString("latin1");
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
  if (ascii(8) === "\x89PNG\r\n\x1a\n") return ".png";
  if (ascii(3) === "GIF") return ".gif";
  if (ascii(4) === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP") return ".webp";
  if (ascii(2) === "BM") return ".bmp";
  if (ascii(4) === "%PDF") return ".pdf";
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7)) return ".zip"; // docx/xlsx/pptx 也是 zip，有原名时用原名
  if (ascii(4) === "\x1aE\xdf\xa3") return ".webm";
  if (b.slice(4, 8).toString("latin1") === "ftyp") return ".mp4";
  if (ascii(4) === "OggS") return ".ogg";
  if (ascii(5) === "#!AMR") return ".amr";
  if (ascii(3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return ".mp3";
  if (ascii(2) === "\x1f\x8b") return ".gz";
  return "";
}

/** 只留最后一段文件名，挡掉 ../ 和控制字符；太长的名字截断但保住扩展名 */
function safeBaseName(name) {
  let n = String(name || "").split(/[\\/]/).pop() || "";
  // eslint-disable-next-line no-control-regex
  n = n.replace(/[\x00-\x1f\x7f]/g, "").replace(/^\.+/, "").trim();
  if (!n) return "";
  if (n.length > 120) {
    const dot = n.lastIndexOf(".");
    const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : "";
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

function stamp(now = Date.now()) {
  return new Date(now).toISOString().slice(11, 19).replace(/:/g, "");
}

const KIND_CN = { image: "图片", file: "文件", voice: "语音", video: "视频", sticker: "表情" };

/** 没有原始文件名时按「渠道+类型+时间」起一个，例如 微信图片_101259.png */
function defaultName(channel, kind, ext, now) {
  return `${channel}${KIND_CN[kind] || "文件"}_${stamp(now)}${ext || ""}`;
}

/**
 * 落盘到工作目录：重名不覆盖（加时间戳），路径穿越挡掉，返回相对文件名。
 * 目录由调用方给（测试里就是临时目录），这个模块不认识 config。
 */
function saveInbound(dir, name, buf, { now = Date.now(), fallback = "" } = {}) {
  if (!buf || !buf.length) throw new Error("内容是空的");
  if (buf.length > MAX_INBOUND_BYTES) {
    throw new Error(`文件 ${(buf.length / 1048576).toFixed(1)}MB，超过 ${MAX_INBOUND_BYTES / 1048576}MB 上限`);
  }
  let base = safeBaseName(name);
  const ext = sniffExt(buf);
  if (!base) base = safeBaseName(fallback) || defaultName("", "file", ext, now);
  // 名字没扩展名、但认得出文件头 → 补上，不然用户下载下来双击打不开
  if (ext && !path.extname(base)) base += ext;
  fs.mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, base);
  if (path.dirname(dest) !== path.resolve(dir)) throw new Error(`文件名不合法: ${name}`);
  if (fs.existsSync(dest)) {
    const dot = base.lastIndexOf(".");
    base = dot > 0 ? `${base.slice(0, dot)}_${stamp(now)}${base.slice(dot)}` : `${base}_${stamp(now)}`;
    dest = path.join(dir, base);
    // 同一秒内连发两张同名图：再撞就挂个序号，别把上一张覆盖了
    for (let i = 2; fs.existsSync(dest); i++) {
      const d2 = base.lastIndexOf(".");
      const nth = d2 > 0 ? `${base.slice(0, d2)}(${i})${base.slice(d2)}` : `${base}(${i})`;
      dest = path.join(dir, nth);
      if (!fs.existsSync(dest)) { base = nth; break; }
    }
  }
  fs.writeFileSync(dest, buf);
  return base;
}

/** 普通 HTTP 附件（QQ / 企微 / 公众号）：下回来变 Buffer，超大的当场拒绝 */
async function fetchBuffer(url, { headers = {}, timeoutMs = 60000, maxBytes = MAX_INBOUND_BYTES, fetchImpl = fetch } = {}) {
  const u = /^https?:\/\//i.test(url) ? url : `https://${String(url).replace(/^\/+/, "")}`;
  const resp = await fetchImpl(u, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
  const len = Number(resp.headers.get("content-length") || 0);
  if (len && len > maxBytes) throw new Error(`文件 ${(len / 1048576).toFixed(1)}MB，超过 ${maxBytes / 1048576}MB 上限`);
  // 腾讯的 media/get 出错时不改状态码，改成回一段 JSON —— 按图片存下来就是个打不开的坏文件
  const ct = String(resp.headers.get("content-type") || "");
  const buf = Buffer.from(await resp.arrayBuffer());
  if (/application\/json/i.test(ct) && buf.length < 4096) {
    let d = {};
    try { d = JSON.parse(buf.toString("utf8")); } catch {}
    if (d.errcode) throw new Error(`${d.errmsg || "接口报错"}（${d.errcode}）`);
  }
  if (buf.length > maxBytes) throw new Error(`文件 ${(buf.length / 1048576).toFixed(1)}MB，超过 ${maxBytes / 1048576}MB 上限`);
  return { buf, fileName: fileNameFromHeaders(resp.headers) };
}

/** Content-Disposition 里的文件名（企微/公众号的 media/get 靠这个给原名） */
function fileNameFromHeaders(headers) {
  const cd = String((headers && headers.get && headers.get("content-disposition")) || "");
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (star) { try { return safeBaseName(decodeURIComponent(star[1].replace(/^["']|["']$/g, ""))); } catch {} }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? safeBaseName(plain[1]) : "";
}

// ---------- 微信 iLink：CDN 密文附件 ----------

/**
 * aes_key 的规范编码是 base64(16 字节密钥的 32 位十六进制字符串)，解出来是 32 字节 ASCII；
 * 老消息里也见过直接 base64(裸 16 字节)，两种都认。
 */
function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(String(aesKeyBase64 || ""), "base64");
  if (decoded.length === 32) {
    const key = Buffer.from(decoded.toString("utf8"), "hex");
    if (key.length === 16) return key;
  }
  if (decoded.length === 16) return decoded;
  throw new Error(`aes_key 不合法：解出来 ${decoded.length} 字节，应为 16 或 32`);
}

function decryptAesEcb(ciphertext, key) {
  const d = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl) {
  return `${(cdnBaseUrl || DEFAULT_CDN_BASE_URL).replace(/\/$/, "")}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/** 从微信 CDN 取密文并解密 */
async function downloadWechatCdn(media, { cdnBaseUrl, timeoutMs = 90000, maxBytes = MAX_INBOUND_BYTES, fetchImpl = fetch } = {}) {
  const param = media && (media.encrypt_query_param || media.encryptQueryParam);
  const key = media && (media.aes_key || media.aesKey);
  if (!param || !key) throw new Error("这条消息没带 CDN 下载信息（可能是转发或过期消息）");
  const resp = await fetchImpl(buildCdnDownloadUrl(param, cdnBaseUrl), { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`CDN 下载失败 HTTP ${resp.status}`);
  const cipher = Buffer.from(await resp.arrayBuffer());
  if (cipher.length > maxBytes) throw new Error(`文件 ${(cipher.length / 1048576).toFixed(1)}MB，超过 ${maxBytes / 1048576}MB 上限`);
  const buf = decryptAesEcb(cipher, parseAesKey(key));
  if (!buf.length) throw new Error("解出来是空文件");
  return buf;
}

// ---------- 微信 iLink：把成果文件发回聊天（上传是下载的逆过程） ----------

function encryptAesEcb(plaintext, key) {
  const c = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([c.update(plaintext), c.final()]);
}

/** PKCS7 一定会补 1~16 字节，所以密文永远比明文长 */
function aesEcbPaddedSize(plainSize) {
  return Math.ceil((plainSize + 1) / 16) * 16;
}

function buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }) {
  return `${(cdnBaseUrl || DEFAULT_CDN_BASE_URL).replace(/\/$/, "")}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

/**
 * 把明文加密后 POST 给 CDN，拿回下载用的 x-encrypted-param。
 * 大文件传一半断很常见，重试 3 次；每次都是整体重传（CDN 不支持断点续传）。
 */
async function uploadCdnCiphertext({ buf, uploadParam, filekey, cdnBaseUrl, aesKey, timeoutMs = 120000, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const encrypted = encryptAesEcb(buf, aesKey);
  const url = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(encrypted),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) throw new Error(`CDN 上传失败 HTTP ${resp.status}`);
      const param = resp.headers.get("x-encrypted-param");
      if (!param) throw new Error("CDN 上传没回 x-encrypted-param");
      return param;
    } catch (e) {
      last = e;
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
  }
  throw last || new Error("CDN 上传失败");
}

// ---------- 拼给 agent 看的说明 ----------

/**
 * @param {string} channel  渠道中文名（微信/QQ/飞书…）
 * @param {Array}  saved    [{ kind, name }] 已落盘的附件
 * @param {Array}  failed   [{ kind, name, why }] 没收下来的
 * @param {string} text     用户随附件一起发的文字
 */
function inboundNote({ channel, saved = [], failed = [], text = "" }) {
  const parts = [];
  if (saved.length) {
    const list = saved.map((s) => `${KIND_CN[s.kind] || "文件"} ${s.name}`).join("、");
    parts.push(
      `[我在${channel}发来 ${saved.length} 个附件，已存进你的工作目录：${list}]` +
        `（文件就在工作目录里，直接按这个文件名读它；我没说要做什么的话，就打开看一眼、确认收到并简述内容）`
    );
  }
  for (const f of failed) {
    parts.push(`[我在${channel}发了一个${KIND_CN[f.kind] || "附件"}${f.name ? `「${f.name}」` : ""}，但没收下来：${f.why}。请直接告诉我这件事，别装作收到了]`);
  }
  if (text) parts.push(text);
  return parts.join("\n").trim();
}

// ---------- 报错进聊天之前：抹掉本机绝对路径 ----------
// 各渠道发附件 / 收附件出错时，那句话会原样进聊天（或交给 agent 让它转告）。fs 的原文、ffmpeg 的 stderr
// 都带绝对路径（/Users/<名字>/…）——聊天记录会被转发、截图，本机的用户名和目录结构不该跟着出去。
// 所有渠道共用这一份，飞书那边（im-feishu-media.js）也从这儿拿。

/**
 * 读要发出去的那个文件出错：换成不带路径的一句，只说事实（找不到 / 没权限 / 错误码）。
 * 不是 fs 的错（网络、接口拒绝）原样返回。
 * @param {any} e @param {string} abs 要发的那个文件
 * @param {boolean} [own] 报错一定出自读 abs 这一下（readFileSync 读到目录时报 EISDIR，不带 path）
 */
function fsFail(e, abs, own = false) {
  if (!(e && typeof e.code === "string" && e.syscall)) return e;
  const mine = own || e.path === abs;
  if (mine && e.code === "ENOENT") return new Error("工作目录里找不到这个文件");
  if (mine && (e.code === "EACCES" || e.code === "EPERM")) return new Error("没权限读这个文件");
  return new Error(`${mine ? "读这个文件" : "读写临时文件"}出错（${e.code}）`);
}

/** 读要发的那个文件；出错换成 fsFail 那句 @param {string} abs @returns {Buffer} */
function readForSend(abs) {
  try { return fs.readFileSync(abs); } catch (e) { throw fsFail(e, abs, true); }
}

// 认得出的目录以外还剩的绝对路径：/a/b/c.pdf、C:\a\b\c.pdf。前面紧挨着字母数字、冒号、斜杠、点、
// 「…」的不算——那是网址（https://x/y）、比例（1/2）或者已经抹过的相对名（…/报告.pdf）。
// 目录名可以带空格（My Drive、Alice Smith、Program Files (x86)）：空格后面那截只要紧跟着下一个分隔符
// 就算同一节目录，最多续 3 截；那截里不许有句读，免得把路径后面跟着的话吞进去。
// 以前在空格处断开，前半截抹了、后半截目录原样漏进聊天。
const ABS_POSIX = /(?<![\w:/.~\-…])\/(?:[^\s'"`()（）「」<>/\\]+(?: [^\s'"`()（）「」<>/\\,，。;；:：!！?？、]+){0,3}\/)+[^\s'"`()（）「」<>/\\,，。;；:：]*/g;
const ABS_WIN = /(?<![\w…])[A-Za-z]:\\(?:[^\s'"`()（）「」<>\\/|?*:]+(?: [^\s'"`（）「」<>\\/|?*:,，。;；!！？、]+){0,3}\\)+[^\s'"`()（）「」<>\\/|?*:,，。;；]*/g;
// 引号里的整段绝对路径（node 的 fs 报错就是 open '/x/y z/a.pdf' 这样）：引号就是边界，里面有空格也整段抹，文件名带空格也留得住
const QUOTED_ABS = /'((?:\/|[A-Za-z]:\\)[^\s'\\/][^'\n]*?[\\/][^'\n]*)'|"((?:\/|[A-Za-z]:\\)[^\s"\\/][^"\n]*?[\\/][^"\n]*)"|`((?:\/|[A-Za-z]:\\)[^\s`\\/][^`\n]*?[\\/][^`\n]*)`|「((?:\/|[A-Za-z]:\\)[^\s」\\/][^」\n]*?[\\/][^」\n]*)」/g;
/** 剩下的那段绝对路径：像文件名（带扩展名）的留名字，别的整段换成「…」——/home/<名字> 的最后一节就是用户名 */
const tailOnly = (/** @type {string} */ m) => {
  const last = m.split(/[\\/]/).filter(Boolean).pop() || "";
  return /^[^.].*\.[A-Za-z0-9]{1,8}$/.test(last) ? `…/${last}` : "…";
};

/**
 * 往聊天里送的话：先把 dirs（工作目录、临时目录）和家目录换成「…」，工作目录下的文件就剩相对名
 * （…/out/报告.pdf），用户照样认得是哪个；再把剩下的绝对路径抹掉。不截断，长度由调用方定。
 * @param {unknown} s @param {Array<string | null | undefined>} [dirs]
 * @returns {string}
 */
function scrubPaths(s, dirs = []) {
  let t = String(s == null ? "" : s);
  // 长的先抹：工作目录在家目录底下，先抹家目录的话工作目录就认不出来了，剩一串 …/startup_get/…
  const known = [...dirs, os.homedir()].filter((d) => typeof d === "string" && d.length > 1).sort((a, b) => b.length - a.length);
  for (const d of known) t = t.split(d).join("…");
  t = t.replace(QUOTED_ABS, (m, a, b, c, d) => {
    const inner = a ?? b ?? c ?? d;
    return m[0] + tailOnly(inner) + m[m.length - 1];
  });
  return t.replace(ABS_POSIX, tailOnly).replace(ABS_WIN, tailOnly);
}

module.exports = {
  MAX_INBOUND_BYTES,
  DEFAULT_CDN_BASE_URL,
  KIND_CN,
  sniffExt,
  safeBaseName,
  defaultName,
  saveInbound,
  fetchBuffer,
  fileNameFromHeaders,
  parseAesKey,
  decryptAesEcb,
  buildCdnDownloadUrl,
  downloadWechatCdn,
  encryptAesEcb,
  aesEcbPaddedSize,
  buildCdnUploadUrl,
  uploadCdnCiphertext,
  inboundNote,
  fsFail,
  readForSend,
  scrubPaths,
};
