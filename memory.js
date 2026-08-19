"use strict";
/**
 * 长期记忆。
 *
 * 原来这儿只有一个 data/memory.md：用户自己在设置里敲字，全局一份，所有账号共用，
 * 整份原样塞进系统提示词。三个毛病：**agent 自己记不住任何东西**（每次任务从零开始，
 * 用户说过"报告别写废话开场白"下次照写）、**多人共用一台机器时你的偏好会串到别人头上**、
 * 以及**没有上限**，写长了每一条任务都要为它付一遍 token。
 *
 * 现在分成两层：
 *   - 手写区（data/memory.md）：用户自己写的，全局共享，界面上原样编辑；
 *   - 条目区（data/memories.json）：agent 用 remember 工具自己记的，一条一条带归属，
 *     能去重、能删、能按账号隔离、超量丢最旧的（并且留痕，不闷声吞）。
 *
 * 注入提示词时只给「共享 + 当前这个账号自己的」，别人的记忆不会串过来。
 */

const fs = require("fs");
const path = require("path");
const store = require("./store");

const DATA_DIR = process.env.WB_DATA_DIR || path.join(__dirname, "data");
const ITEMS_FILE = path.join(DATA_DIR, "memories.json");
const MANUAL_FILE = path.join(DATA_DIR, "memory.md");

const SHARED = "*"; // 共享作用域：所有账号都看得到
const MAX_TEXT = 400; // 单条上限：记忆是一句话结论，不是任务日志
const MAX_PER_SCOPE = 120; // 每个作用域最多留多少条
const MAX_PROMPT_CHARS = 6000; // 注入提示词的总预算，超了截断并明说

/**
 * 不该被记下来的东西。记忆文件是明文 JSON，还会原样进每一次请求的系统提示词——
 * 密钥落进来等于既写盘又外发，而且用户根本不知道。宁可拒记。
 */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i,
  /(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*\S{6,}/i,
  /(密码|口令|密钥)\s*(是|为|:|：)\s*\S{4,}/,
];

function looksSecret(text) {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/** 去重用的归一化：大小写、空白、句末标点不同不算两条 */
function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[。．.！!？?，,、；;：:"'"'（）()]/g, "");
}

function load() {
  const raw = store.readJson(ITEMS_FILE, { items: [] });
  const items = Array.isArray(raw) ? raw : Array.isArray(raw && raw.items) ? raw.items : [];
  return items.filter((x) => x && typeof x.text === "string");
}

function save(items) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  store.writeJsonAtomic(ITEMS_FILE, { items }, { pretty: true });
}

function scopeOf(user, shared) {
  if (shared) return SHARED;
  const u = String(user || "").trim();
  return u || SHARED; // 没有登录态（CLI/IM/定时任务没传用户）就记到共享里，总比丢了强
}

/**
 * 记一条。
 * @returns { ok, id?, note, dropped? }  note 是给 agent 看的一句话回执——
 *   去重了、超量丢了旧的、被拒了，都要在这句话里说清楚，不能让它以为记住了其实没有。
 */
function add({ text, user, shared = false, source = "agent" }) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  if (!t) return { ok: false, note: "记忆内容是空的" };
  if (t.length > MAX_TEXT) return { ok: false, note: `一条记忆最多 ${MAX_TEXT} 字，这条 ${t.length} 字。记结论，别记过程。` };
  if (looksSecret(t)) {
    return { ok: false, note: "这条像是密钥/密码/令牌，拒绝记入。记忆是明文存的、每次任务都会进系统提示词，凭据只该放在配置里。" };
  }
  const scope = scopeOf(user, shared);
  const items = load();
  const dup = items.find((x) => x.scope === scope && normalize(x.text) === normalize(t));
  if (dup) return { ok: true, id: dup.id, note: "已经记过一模一样的了，没有重复写入" };

  const id = "m_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36);
  items.push({ id, text: t, scope, source, created_at: new Date().toISOString() });

  // 超量丢最旧的。丢东西必须留痕：日志里写清楚丢了哪条，回执里也告诉 agent。
  let dropped = 0;
  const mine = items.filter((x) => x.scope === scope);
  if (mine.length > MAX_PER_SCOPE) {
    const kill = new Set(mine.slice(0, mine.length - MAX_PER_SCOPE).map((x) => x.id));
    for (const x of items) if (kill.has(x.id)) console.warn(`[记忆] ${scope} 超过 ${MAX_PER_SCOPE} 条，丢弃最旧的一条：${x.text.slice(0, 60)}`);
    dropped = kill.size;
    for (let i = items.length - 1; i >= 0; i--) if (kill.has(items[i].id)) items.splice(i, 1);
  }
  save(items);
  return {
    ok: true,
    id,
    dropped,
    note: dropped ? `记住了（${scope === SHARED ? "共享" : scope}）。这个作用域超过 ${MAX_PER_SCOPE} 条，已丢弃最旧的 ${dropped} 条` : `记住了（${scope === SHARED ? "共享" : scope}）`,
  };
}

/** 按 id 删。返回删掉的条数 */
function remove(id) {
  const items = load();
  const left = items.filter((x) => x.id !== id);
  if (left.length === items.length) return 0;
  save(left);
  return items.length - left.length;
}

/**
 * 按内容删（给 forget 工具用）：只在"共享 + 自己"这两个作用域里找，
 * 别人的记忆不能被顺手删掉。
 */
function forget({ text, user }) {
  const q = normalize(text);
  if (!q) return { removed: 0, note: "要忘掉什么没说清楚" };
  const scope = scopeOf(user, false);
  const items = load();
  const hit = items.filter((x) => (x.scope === scope || x.scope === SHARED) && (normalize(x.text) === q || normalize(x.text).includes(q)));
  if (!hit.length) return { removed: 0, note: "没找到匹配的记忆条目（可以先用记忆面板看看都记了什么）" };
  const kill = new Set(hit.map((x) => x.id));
  save(items.filter((x) => !kill.has(x.id)));
  return { removed: hit.length, note: `忘掉了 ${hit.length} 条：${hit.map((x) => x.text.slice(0, 40)).join("；")}` };
}

/** 改登录名时把归属搬过去，不然那个人的记忆当场变成孤儿 */
function renameScope(from, to) {
  const items = load();
  let n = 0;
  for (const x of items) if (x.scope === from) { x.scope = to; n++; }
  if (n) save(items);
  return n;
}

/** 列出某个账号看得到的（共享 + 自己）；不传 user 就是全部（给管理面板用） */
function list(user) {
  const items = load().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  if (user === undefined) return items;
  const scope = scopeOf(user, false);
  return items.filter((x) => x.scope === SHARED || x.scope === scope);
}

function manual() {
  try {
    return fs.readFileSync(MANUAL_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

function saveManual(content) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MANUAL_FILE, String(content || ""), "utf8");
}

/**
 * 拼成系统提示词里的那一段。超预算时**截断并明说截了多少**——
 * 假装全都看得见，模型会照着一条其实没进上下文的偏好去做事。
 */
function promptBlock(user) {
  const md = manual();
  const items = list(user);
  if (!md && !items.length) return "";
  let body = "";
  if (md) body += `${md}\n`;
  if (items.length) {
    const lines = items.map((x) => `- ${x.text}${x.scope === SHARED && user ? "（共享）" : ""}`);
    body += (md ? "\n" : "") + lines.join("\n");
  }
  let note = "";
  if (body.length > MAX_PROMPT_CHARS) {
    const cut = body.length - MAX_PROMPT_CHARS;
    body = body.slice(0, MAX_PROMPT_CHARS);
    note = `\n（记忆太长，这里截掉了最后 ${cut} 字。要用全部记忆请去设置 → 记忆里精简一下）`;
  }
  return `\n\n## 长期记忆（跨任务保留，优先级高于你的默认习惯）\n${body}${note}`;
}

module.exports = {
  SHARED,
  MAX_TEXT,
  MAX_PER_SCOPE,
  add,
  remove,
  forget,
  list,
  renameScope,
  manual,
  saveManual,
  promptBlock,
  _internals: { normalize, looksSecret, load, save, ITEMS_FILE, MANUAL_FILE },
};
