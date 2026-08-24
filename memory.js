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
const VEC_FILE = path.join(DATA_DIR, "memory_vectors.json"); // 向量单独存：memories.json 保持人能读

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

// ---------- 向量召回层 ----------
// embedder 由 server 启动时注入（llm.createEmbedder），可能是 null（没有可用的
// embeddings 渠道）。null 时打分退回中文二元组关键词匹配，promptBlock 照常工作。
let embedder = null;
function setEmbedder(fn) { embedder = typeof fn === "function" ? fn : null; }

function vecLoad() {
  const raw = store.readJson(VEC_FILE, { model: "", vecs: {} });
  return raw && typeof raw === "object" && raw.vecs ? raw : { model: "", vecs: {} };
}
function vecSave(v) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  store.writeJsonAtomic(VEC_FILE, v); // 不 pretty：一条向量上千个数，pretty 会把文件撑大三倍
}

let vecJobRunning = false;
/**
 * 给还没有向量的条目补算向量（启动时、换嵌入模型后、新记一条后都会被调）。
 * 尽力而为：embeddings 挂了就下次再说，绝不阻塞记忆写入，也绝不抛出。
 */
async function ensureVectors() {
  if (!embedder || vecJobRunning) return { computed: 0 };
  vecJobRunning = true;
  try {
    const items = load();
    let vs = vecLoad();
    if (vs.model !== embedder.model) vs = { model: embedder.model, vecs: {} }; // 换了嵌入模型：旧向量全部作废重算
    const alive = new Set(items.map((x) => x.id));
    for (const id of Object.keys(vs.vecs)) if (!alive.has(id)) delete vs.vecs[id]; // 条目删了向量也别留
    const todo = items.filter((x) => !vs.vecs[x.id]);
    let computed = 0;
    for (let i = 0; i < todo.length; i += 16) {
      const batch = todo.slice(i, i + 16);
      const out = await embedder(batch.map((x) => x.text));
      if (!out) break; // embedder 自己会记失败次数并停用，这里不重试
      batch.forEach((x, j) => { vs.vecs[x.id] = out[j].map((n) => Math.round(n * 1e5) / 1e5); });
      computed += batch.length;
    }
    if (computed || Object.keys(vs.vecs).length !== items.length) vecSave(vs);
    return { computed };
  } finally {
    vecJobRunning = false;
  }
}

/** 中文没有空格分词，二元组（bigram）是零依赖下最稳的召回单位 */
function bigrams(text) {
  const s = normalize(text);
  const g = new Set();
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  return g;
}
function keywordScore(hintGrams, text) {
  if (!hintGrams.size) return 0;
  const g = bigrams(text);
  if (!g.size) return 0;
  let hit = 0;
  for (const x of g) if (hintGrams.has(x)) hit++;
  return hit / Math.sqrt(g.size) / Math.sqrt(hintGrams.size); // 余弦式归一，长句不吃亏
}
function cosine(u, v) {
  if (!Array.isArray(u) || !Array.isArray(v) || u.length !== v.length) return 0;
  let dot = 0, nu = 0, nv = 0;
  for (let i = 0; i < u.length; i++) { dot += u[i] * v[i]; nu += u[i] * u[i]; nv += v[i] * v[i]; }
  return nu && nv ? dot / Math.sqrt(nu) / Math.sqrt(nv) : 0;
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
  if (embedder) setImmediate(() => ensureVectors().catch(() => {})); // 后台补向量，不拖慢写入
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
 * 拼成系统提示词里的那一段。
 * 装得下就全量注入，一条不筛；装不下才启动召回：按「与本次任务的相关度」挑条目，
 * 而不是从尾巴上盲切——盲切吃掉的恰好是最新记的那些。挑没挑、挑了多少，都明说。
 * @param hint 本次任务的线索（通常是用户最后一条消息的前几百字），用来算相关度
 */
async function promptBlock(user, hint) {
  let md = manual();
  const items = list(user);
  if (!md && !items.length) return "";
  const line = (x) => `- ${x.text}${x.scope === SHARED && user ? "（共享）" : ""}`;

  let body = "";
  if (md) body += `${md}\n`;
  if (items.length) body += (md ? "\n" : "") + items.map(line).join("\n");
  let note = "";

  if (body.length > MAX_PROMPT_CHARS) {
    // 手写区是用户亲手敲的，优先级最高；但它自己超预算也得截，并明说
    if (md.length > MAX_PROMPT_CHARS) {
      const cut = md.length - MAX_PROMPT_CHARS;
      md = md.slice(0, MAX_PROMPT_CHARS);
      note = `\n（手写记忆太长，截掉了最后 ${cut} 字；条目区一条都没放进来。请去设置 → 记忆里精简一下）`;
      body = md;
    } else {
      // 条目按相关度排：有向量用「余弦为主 + 关键词兜底」，没向量纯关键词，连线索都没有就按新旧
      let ranked;
      if (hint) {
        const hg = bigrams(hint);
        let hintVec = null;
        if (embedder) {
          const vs = vecLoad();
          if (Object.keys(vs.vecs).length) {
            const r = await embedder([String(hint).slice(0, 500)]);
            hintVec = (r && r[0]) || null;
            if (hintVec) {
              ranked = items
                .map((x) => {
                  const kw = keywordScore(hg, x.text);
                  const v = vs.vecs[x.id];
                  return { x, s: v ? 0.7 * cosine(hintVec, v) + 0.3 * kw : kw };
                })
                .sort((a, b) => b.s - a.s);
            }
          }
        }
        if (!ranked) ranked = items.map((x) => ({ x, s: keywordScore(hg, x.text) })).sort((a, b) => b.s - a.s);
      } else {
        ranked = items.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map((x) => ({ x }));
      }
      const budget = MAX_PROMPT_CHARS - md.length;
      const picked = [];
      let used = 0;
      for (const { x } of ranked) {
        const l = line(x);
        if (used + l.length + 1 > budget) continue; // 这条装不下，试试后面更短的
        picked.push(x);
        used += l.length + 1;
      }
      // 展示按记入时间排，读起来稳定；挑选才按相关度
      picked.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      body = (md ? md + "\n\n" : "") + picked.map(line).join("\n");
      note = `\n（记忆条目共 ${items.length} 条装不下，这里按${hint ? "与本次任务的相关度" : "新旧"}挑了 ${picked.length} 条；要看全部请去设置 → 记忆）`;
    }
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
  setEmbedder,
  ensureVectors,
  _internals: { normalize, looksSecret, load, save, ITEMS_FILE, MANUAL_FILE, VEC_FILE, bigrams, keywordScore, cosine, vecLoad },
};
