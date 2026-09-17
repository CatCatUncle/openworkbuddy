"use strict";
/**
 * 对外发的 API Key（虚拟 Key）—— 中转站的门票。
 *
 * 场景：公司统一买了几家模型的额度，填在这台机器上。现在业务方要接：
 * 小程序后台要调、数据组的脚本要调、外包团队也要调一点。
 * 把上游那把真 Key 发给他们是不行的——发出去就收不回来，也分不清谁花的钱，
 * 更没法只给他一个型号、只给他 200 块的额度。
 *
 * 所以发的是虚拟 Key：长得跟 OpenAI 的 sk- 一样，用法也一样
 * （`base_url` 指到这台机器的 /v1，`api_key` 填这一把），但它：
 *   · 有自己的额度（花完就停，不牵连别人）
 *   · 有有效期（外包做完三个月自动作废，不用记得去收）
 *   · 只能用指定的几个型号（别拿 Opus 跑批量清洗）
 *   · 能限定来源 IP
 *   · 随时能吊销，上游那把真 Key 一个字节都不用换
 *
 * ── 存法：只存哈希，不存原文 ──────────────────────────────────────
 * 跟密码同一个规矩。原文只在**创建那一次**返回，之后任何接口、任何日志、
 * 任何导出都拿不到它。丢了就重发一把——这比「随时能看回来」安全得多：
 * 一个能看回全部下游 Key 的后台，本身就是最值钱的攻击目标。
 *
 * 为什么用 sha256 而不是 bcrypt（密码那边用的）：这串是我们自己发的 40 位随机数，
 * 不是人想出来的口令，没有字典可以撞，不需要故意算得慢；而每个请求都要验一次，
 * bcrypt 那个量级的开销会直接变成网关的吞吐上限。
 */

const crypto = require("crypto");
const path = require("path");
const { dataPath } = require("./paths");
const store = require("./store");

const DATA_DIR = process.env.OPENWORKBUDDY_DATA_DIR || dataPath("data");
const FILE = path.join(DATA_DIR, "vkeys.json");

/** 前缀写死 owb-sk-：一眼看得出是哪儿发的，日志里误贴出来也知道该去哪儿吊销 */
const PREFIX = "owb-sk-";
const BODY_LEN = 40;
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function hash(raw) { return crypto.createHash("sha256").update(String(raw)).digest("hex"); }

function load() {
  const db = store.readJson(FILE, { keys: [] }, { strict: true });
  if (!db || !Array.isArray(db.keys)) return { keys: [] };
  return db;
}
// 0600：这份文件里是哈希不是原文，但也够画出「哪个组织发了几把、给谁、多少额度」这张图
function save(db) { store.writeJsonAtomic(FILE, db, { pretty: true, mode: 0o600 }); }

function genRaw() {
  const buf = crypto.randomBytes(BODY_LEN);
  let s = "";
  for (let i = 0; i < BODY_LEN; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return PREFIX + s;
}

/** 给人看的那一截：前 6 后 4，中间点掉。够在列表里认出是哪一把，又拼不回原文 */
function maskOf(raw) {
  const body = raw.slice(PREFIX.length);
  return `${PREFIX}${body.slice(0, 6)}…${body.slice(-4)}`;
}

/**
 * 发一把。**返回值里的 secret 是这辈子唯一一次能拿到原文的机会**，调用方必须当场交给用户。
 */
function create({ name, org, user, budget_yuan, expires_at, models, caps, ips, by } = {}) {
  const db = load();
  const raw = genRaw();
  const k = {
    id: "vk_" + crypto.randomBytes(8).toString("hex"),
    name: String(name || "").trim().slice(0, 60) || "未命名",
    hash: hash(raw),
    mask: maskOf(raw),
    org: String(org || "default"),
    // 归到某个人名下：账才算得清「谁花的」，这个人离职时 lifecycle.js 也才知道要把哪几把收回去
    user: String(user || "").slice(0, 60),
    budget_yuan: numOrZero(budget_yuan),
    expires_at: String(expires_at || "").slice(0, 10),   // YYYY-MM-DD，空 = 不过期
    models: cleanList(models, 40),                        // 空 = 不限型号
    // 能用哪几路能力（chat/embedding/image/video/tts/asr/search）。空 = 全开。
    // 为什么跟型号白名单分开：一把发给外包做文案的 Key，该限的不是「哪个型号」
    // 而是「不准生视频」——视频是最贵的一路，而且型号名一个月一变，
    // 拿型号白名单去拦能力，下个月上游改一个 id 就漏了。
    caps: cleanCaps(caps),
    ips: cleanList(ips, 20),                              // 空 = 不限来源
    enabled: true,
    created_at: new Date().toISOString(),
    created_by: String((by && by.username) || by || "").slice(0, 60),
    last_used_at: "", calls: 0,
  };
  db.keys.push(k);
  save(db);
  return { key: publicOf(k), secret: raw };
}

function numOrZero(x) {
  const n = typeof x === "string" ? parseFloat(x) : x;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}
function cleanList(v, max) {
  if (!Array.isArray(v)) v = String(v || "").split(/[\s,，]+/);
  return [...new Set(v.map((x) => String(x || "").trim()).filter(Boolean))].slice(0, max);
}

/**
 * 中转站对外开的全部能力。这张表就是开关的全集：
 * 认不出的名字直接丢，别让一个拼错的字（"vedio"）惄惄住进 Key 里——
 * 它会让这把 Key 看着限住了，实际一路都没限住。
 */
const CAPS = ["chat", "embedding", "image", "video", "tts", "asr", "search"];
const CAP_CN = {
  chat: "对话", embedding: "向量化", image: "生图", video: "生视频",
  tts: "语音合成", asr: "语音转写", search: "联网搜索",
};
function cleanCaps(v) {
  const want = new Set(cleanList(v, 20).map((x) => x.toLowerCase()));
  const out = CAPS.filter((c) => want.has(c));
  // 全选等于不限，存成空数组。否则以后新增一路能力，
  // 今天这批「全选」的 Key 会莫名其妙地用不了新那一路。
  return out.length === CAPS.length ? [] : out;
}
/** 这把 Key 能不能走这一路。空白名单 = 全开 */
function capAllowed(list, cap) {
  if (!Array.isArray(list) || !list.length) return true;
  return list.includes(String(cap || "").toLowerCase());
}

/** 对外的样子：**永远**不含 hash。列表、单查、审计全走它，免得哪天漏一处把哈希发出去 */
function publicOf(k) {
  const { hash: _h, ...rest } = k;
  return rest;
}

function list({ org } = {}) {
  return load().keys.filter((k) => !org || k.org === org).map(publicOf);
}

/**
 * 拿原文换一把 Key。查不到返回 null；查到了但不能用，返回 { key, reason }。
 *
 * 「不能用」和「查不到」分开返回，是因为这两件事对上层的意义完全不同：
 * 查不到的那种，调用方只该收到一句「这把 Key 不对」（说「不存在」等于帮人一把一把试出
 * 哪些是真的）；查得到、只是不让用的那种，reason 要原样回给他——他已经握着这把 Key 了，
 * 这时候含糊其辞只会让他对着一句「不对」查半天，而真正的原因是上个月到期了。
 * 日志那边也是两条不同的记录：「一把已吊销的 Key 还在被调」是要有人去处理的事，
 * 「随机字符串撞门」不是。
 */
function verify(raw, { ip = "", model = "", cap = "", now = new Date() } = {}) {
  const s = String(raw || "").trim();
  if (!s.startsWith(PREFIX)) return null;
  const h = hash(s);
  const k = load().keys.find((x) => x.hash === h);
  if (!k) return null;
  const pub = publicOf(k);
  if (!k.enabled) return { key: pub, reason: "这把 Key 已经被停用了" };
  if (k.expires_at && localDay(now) > k.expires_at) return { key: pub, reason: `这把 Key 已于 ${k.expires_at} 到期` };
  if (k.models.length && model && !modelAllowed(k.models, model)) {
    return { key: pub, reason: `这把 Key 不能用 ${model}，只开了：${k.models.join("、")}` };
  }
  if (cap && !capAllowed(k.caps, cap)) {
    return { key: pub, reason: `这把 Key 没开「${CAP_CN[cap] || cap}」，只开了：${k.caps.map((c) => CAP_CN[c] || c).join("、")}` };
  }
  if (k.ips.length && ip && !ipAllowed(k.ips, ip)) return { key: pub, reason: `这把 Key 不认这个来源地址（${ip}）` };
  return { key: pub };
}

/**
 * 型号白名单支持尾部 *：`gpt-4*` 放行 gpt-4o / gpt-4.1。
 * 不支持正则——白名单写成正则，写错一个字符就从「只给这几个」变成「全放」，
 * 而这种写错不会报错，只会在账单上出现。
 */
function modelAllowed(list, model) {
  const m = String(model || "").toLowerCase();
  return list.some((p) => {
    const s = String(p).toLowerCase();
    return s.endsWith("*") ? m.startsWith(s.slice(0, -1)) : m === s;
  });
}

/** IP 白名单：整个地址，或者 CIDR（192.168.1.0/24），或者前缀写法 10.1.* */
function ipAllowed(list, ip) {
  const a = String(ip || "").replace(/^::ffff:/, "");
  return list.some((rule) => {
    const r = String(rule).trim();
    if (r === a) return true;
    if (r.endsWith("*")) return a.startsWith(r.slice(0, -1));
    if (r.includes("/")) return inCidr(a, r);
    return false;
  });
}
function inCidr(ip, cidr) {
  const [net, bitsRaw] = cidr.split("/");
  const bits = parseInt(bitsRaw, 10);
  if (!(bits >= 0 && bits <= 32)) return false;
  const n = v4(net), x = v4(ip);
  if (n === null || x === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (n & mask) >>> 0 === (x & mask) >>> 0;
}
function v4(s) {
  const p = String(s).split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    const d = Number(x);
    if (!Number.isInteger(d) || d < 0 || d > 255) return null;
    n = (n << 8) | d;
  }
  return n >>> 0;
}

function localDay(d) {
  const t = new Date(d);
  return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** 改一把（名字 / 额度 / 有效期 / 型号 / 来源 / 停用）。改不到原文，也改不了归属组织 */
function update(id, patch = {}) {
  const db = load();
  const k = db.keys.find((x) => x.id === id);
  if (!k) throw new Error("没有这把 Key");
  if (patch.name !== undefined) k.name = String(patch.name).trim().slice(0, 60) || k.name;
  if (patch.budget_yuan !== undefined) k.budget_yuan = numOrZero(patch.budget_yuan);
  if (patch.expires_at !== undefined) k.expires_at = String(patch.expires_at || "").slice(0, 10);
  if (patch.models !== undefined) k.models = cleanList(patch.models, 40);
  if (patch.caps !== undefined) k.caps = cleanCaps(patch.caps);
  if (patch.ips !== undefined) k.ips = cleanList(patch.ips, 20);
  if (patch.enabled !== undefined) k.enabled = !!patch.enabled;
  if (patch.user !== undefined) k.user = String(patch.user || "").slice(0, 60);
  save(db);
  return publicOf(k);
}

/**
 * 吊销 = 停用，不是删除。
 *
 * 删掉的话，这把 Key 花过的钱在后台就变成了一个查不到主人的数字——而「这三千块是谁花的」
 * 正是出事之后第一个要问的问题。所以停用留档，真要清理，`remove` 得单独调，
 * 而且只清没花过钱的。
 */
function revoke(id, by) {
  const db = load();
  const k = db.keys.find((x) => x.id === id);
  if (!k) throw new Error("没有这把 Key");
  k.enabled = false;
  k.revoked_at = new Date().toISOString();
  k.revoked_by = String((by && by.username) || by || "");
  save(db);
  return publicOf(k);
}

function remove(id) {
  const db = load();
  const k = db.keys.find((x) => x.id === id);
  if (!k) throw new Error("没有这把 Key");
  if (k.calls > 0) throw new Error("这把 Key 用过，只能停用不能删——删了它花过的钱就成了无主账");
  db.keys = db.keys.filter((x) => x.id !== id);
  save(db);
  return true;
}

/** 用过一次就记一下。写盘不等调用方，失败也绝不能把一次成功的调用搅黄 */
function touch(id) {
  try {
    const db = load();
    const k = db.keys.find((x) => x.id === id);
    if (!k) return;
    k.calls = (k.calls || 0) + 1;
    k.last_used_at = new Date().toISOString();
    save(db);
  } catch {}
}

/** 某个人名下的所有 Key。离职流程要用——人走了，他发出去的门票得跟着收 */
function ofUser(username) {
  return load().keys.filter((k) => k.user === username && k.enabled).map(publicOf);
}

module.exports = {
  create, list, verify, update, revoke, remove, touch, ofUser, publicOf,
  PREFIX, FILE, CAPS, CAP_CN, capAllowed,
  _internals: { hash, genRaw, maskOf, modelAllowed, ipAllowed, inCidr, cleanList, cleanCaps, load, save },
};
