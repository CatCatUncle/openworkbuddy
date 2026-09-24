// @ts-check
"use strict";
/**
 * 中转站产出的文件：图、视频、语音落在这儿，凭虚拟 Key 取回。
 *
 * ── 为什么要有这么个东西 ──────────────────────────────────────────
 *
 * 对话那条路是纯文本，转发完就完了。生图 / 生视频 / 语音合成不是：上游给的是一个
 * **几分钟后就失效**的临时地址（万相的 OSS 链接 24 小时过期，火山的更短），
 * 把那个地址原样回给业务方，他明天再来取就是一个 404，而那一趟已经计过费了。
 * 所以产出必须先落到我们这边，再发一个我们自己说了算的地址出去。
 *
 * ── 三条规矩 ──────────────────────────────────────────────────
 *
 * 1) **取文件要带 Key。** 不是"链接猜不到就算安全"。这里存的是企业自己生成的东西——
 *    产品图、宣传片、会议录音的合成稿。一条不设防的链接只要出现在一次日志、一个
 *    截图、一封转发的邮件里，就永久地公开了。id 依然是 16 字节随机数（防的是遍历），
 *    但真正把门的是那把 Key，而且必须是**同一个组织**发出去的 Key。
 *
 * 2) **过期就删，删了就是删了。** 默认存 24 小时。中转站不是网盘：业务方拿到文件
 *    就该存进自己的系统，我们这儿只是一段交接。留着不删的唯一结果是磁盘满了之后
 *    整个服务写不进账——那时候丢的是**账**，比丢文件严重得多。
 *
 * 3) **总量有上限。** 满了先删最老的。视频一条几十兆，一个脚本跑歪能在一夜之间把盘
 *    填满；到那时连"服务器没空间了"这句话都写不进日志。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { dataPath } = require("./paths");

const DATA_DIR = process.env.OPENWORKBUDDY_DATA_DIR || dataPath("data");
const DIR = path.join(DATA_DIR, "relay-files");
/** 存多久。够业务方在自己那边落库了，又不至于把这儿当网盘用 */
const TTL_MS = 24 * 3600 * 1000;
/** 总量上限。超了从最老的开始删——删的是已经交付过的产出，比写不进账轻 */
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

const EXT_TYPE = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".opus": "audio/ogg",
  ".txt": "text/plain; charset=utf-8", ".srt": "text/plain; charset=utf-8", ".json": "application/json",
};
function typeOf(name) {
  return EXT_TYPE[path.extname(String(name || "")).toLowerCase()] || "application/octet-stream";
}

function ensure() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
}

/** 一条记录在盘上是两个文件：<id>.bin 是字节，<id>.json 是它属于谁、什么时候过期 */
const binOf = (id) => path.join(DIR, id + ".bin");
const metaOf = (id) => path.join(DIR, id + ".json");
/** id 只认 32 位十六进制。路径拼接前先卡死形状，`..` 这种东西根本进不来 */
const okId = (id) => /^[0-9a-f]{32}$/.test(String(id || ""));

function readMeta(id) {
  if (!okId(id)) return null;
  try { return JSON.parse(fs.readFileSync(metaOf(id), "utf8")); } catch { return null; }
}

/**
 * 存一份产出。返回的 meta 直接能塞进 HTTP 响应。
 * `name` 只用来挑 content-type 和给下载起个人看的名字，不参与路径——
 * 上游给的文件名是不可信输入，拿它拼路径就是一个目录穿越。
 */
function save(buf, { name = "file.bin", cap = "", org = "", vkey = "", model = "", now = Date.now() } = {}) {
  ensure();
  const id = crypto.randomBytes(16).toString("hex");
  const meta = {
    id,
    name: path.basename(String(name || "file.bin")).slice(0, 120) || "file.bin",
    bytes: buf.length,
    content_type: typeOf(name),
    cap: String(cap || ""),
    org: String(org || ""),
    vkey: String(vkey || ""),
    model: String(model || ""),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + TTL_MS).toISOString(),
  };
  fs.writeFileSync(binOf(id), buf);
  fs.writeFileSync(metaOf(id), JSON.stringify(meta));
  sweep(now);
  return meta;
}

/**
 * 取一份产出。`org` 传进来就核一遍归属。
 *
 * 核的是**组织**不是那把具体的 Key：同一家公司常常是一把 Key 生图、另一把 Key 的
 * 后台程序去取。按 Key 核会把这种再正常不过的用法挡在外面，而按组织核已经挡住了
 * 真正要挡的那件事——别家公司的 Key 拿着一个 id 来取。
 */
function get(id, { org = null, now = Date.now() } = {}) {
  const m = readMeta(id);
  if (!m) return { err: "没有这个文件（可能已经过期被清掉了）", status: 404 };
  if (Date.parse(m.expires_at) <= now) { remove(id); return { err: "这个文件已经过期（中转站只留 24 小时）", status: 404 }; }
  // 归属不对，回的也是 404 而不是 403：说「这个文件存在，只是不给你」，
  // 等于替人确认了一个 id 是真的。
  if (org != null && m.org && m.org !== org) return { err: "没有这个文件", status: 404 };
  let buf = null;
  try { buf = fs.readFileSync(binOf(id)); } catch { return { err: "文件不见了", status: 404 }; }
  return { meta: m, buf };
}

function remove(id) {
  if (!okId(id)) return;
  try { fs.unlinkSync(binOf(id)); } catch {}
  try { fs.unlinkSync(metaOf(id)); } catch {}
}

/**
 * 清一遍：过期的删掉，还超上限就接着从最老的删。
 * 每次 save 顺手跑一次，不另起定时器——这条路上没有写入就没有增长，
 * 一个常年不用中转站的实例不该为它多一个常驻的 timer。
 */
function sweep(now = Date.now()) {
  ensure();
  let names;
  try { names = fs.readdirSync(DIR); } catch { return { removed: 0, bytes: 0 }; }
  const live = [];
  let removed = 0;
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const id = n.slice(0, -5);
    const m = readMeta(id);
    if (!m) { remove(id); continue; }
    if (Date.parse(m.expires_at) <= now) { remove(id); removed++; continue; }
    live.push(m);
  }
  let bytes = live.reduce((s, m) => s + (+m.bytes || 0), 0);
  if (bytes > MAX_BYTES) {
    live.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    while (bytes > MAX_BYTES && live.length) {
      const m = live.shift();
      remove(m.id); removed++; bytes -= +m.bytes || 0;
    }
  }
  return { removed, bytes };
}

/** 后台那张表要用：这个组织现在压着多少东西 */
function list({ org = null, now = Date.now() } = {}) {
  ensure();
  let names = [];
  try { names = fs.readdirSync(DIR); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const m = readMeta(n.slice(0, -5));
    if (!m) continue;
    if (Date.parse(m.expires_at) <= now) continue;
    if (org != null && m.org !== org) continue;
    out.push(m);
  }
  return out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

module.exports = { save, get, remove, sweep, list, typeOf, DIR, TTL_MS, MAX_BYTES, _internals: { okId, readMeta, binOf, metaOf } };
