"use strict";
/**
 * 任务历史的检索：算分、摘要、命中片段。
 *
 * 侧栏那个放大镜一直只筛标题。而人回头找一段对话，记得住的往往不是标题——
 * 标题是任务跑完自动起的，他从没读过；他记得的是「我当时让它把那个 csv 里重复的行挑出来」，
 * 或者「最后导出来那个 PPT」。按标题筛，这两种记法一个都找不着，于是只能一条条点开看，
 * 点到第五条就放弃了。
 *
 * 所以这儿按三种命中找，而且**每条都说清楚是哪种命中**：
 *   字面   —— 标题 / 产出文件名 / 对话正文里真出现了这个词
 *   词面   —— 中文二元组重合（打错一个字、词序反了还能捞回来）
 *   意思相近 —— 向量余弦，配了嵌入渠道才有
 * 不说清楚的话，语义那几条看起来就是「凭空冒出来的不相干任务」，人会觉得搜索坏了。
 * 宁可让它显得笨一点，也不能让人以为它在乱来。
 *
 * 这一层是纯的：不碰 fs、不碰网络、不打印。喂什么算什么，所以测得动。
 * 摘要怎么落盘、向量什么时候算，在 server.js 那边。
 */

const MAX_DIGEST = 4000;   // 一条会话摘这么多字拿去搜。再多就是在给一条会话陪几百倍的钱
const MAX_EMBED = 500;     // 拿去算向量的那一小段：开头几句最能代表这趟是在干嘛
const SNIP_PAD = 24;       // 命中片段前后各留这些字
const LIT_BAND = 1;        // 字面命中比词面 / 语义高出的那一整档（见 rank 里的算分）

/** 把一轮助手回复里的文字抠出来。事件流那种形状（events[]）和老的 {text} 都认 */
function assistantText(turn) {
  if (!turn) return "";
  if (typeof turn.text === "string") return turn.text;
  const evs = Array.isArray(turn.events) ? turn.events : [];
  const out = [];
  for (const e of evs) {
    if (!e) continue;
    if (e.type === "text" && e.delta) out.push(String(e.delta));
  }
  return out.join("");
}

/** 这趟产出过哪些文件。人记得住文件名的概率，比记得住标题高得多 */
function filesOf(sess) {
  const names = new Set();
  for (const turn of (Array.isArray(sess && sess.transcript) ? sess.transcript : [])) {
    for (const e of (Array.isArray(turn && turn.events) ? turn.events : [])) {
      if (e && e.type === "files") for (const f of (Array.isArray(e.files) ? e.files : [])) {
        if (f && f.name) names.add(String(f.name));
      }
    }
  }
  return [...names];
}

/**
 * 一条会话摘成一段能搜的文字。
 * 人说的话排在前面、一句不删（到上限为止）——他要找的就是自己说过的那句；
 * 助手的回复只各取个开头，那是最啰嗦也最不好记的部分，整段收进来只会把人自己的话挤出去。
 */
function digestOf(sess, max = MAX_DIGEST) {
  const t = Array.isArray(sess && sess.transcript) ? sess.transcript : [];
  const mine = [];
  const theirs = [];
  for (const turn of t) {
    if (!turn) continue;
    if (turn.type === "user" && turn.text) mine.push(String(turn.text).trim());
    else if (turn.type === "assistant") {
      const s = assistantText(turn).trim();
      if (s) theirs.push(s.slice(0, 160));
    }
  }
  const files = filesOf(sess);
  const parts = [];
  if (files.length) parts.push(files.join(" "));
  parts.push(...mine, ...theirs);
  let out = "";
  for (const p of parts) {
    const sep = out ? "\n" : "";
    const room = max - out.length - sep.length;   // 分隔符也占位：不减它的话说好 4000，实际每多一段就超一个字
    if (room <= 0) break;
    out += sep + p.slice(0, room);
  }
  return out;
}

/** 拿去算向量的那一小段：标题 + 最早说的那几句。结尾那几句多半是「好的」「再改改」，代表不了这趟活儿 */
function embedTextOf(row, max = MAX_EMBED) {
  const head = [String((row && row.title) || ""), String((row && row.digest) || "")]
    .filter(Boolean).join("\n");
  return head.slice(0, max);
}

function normalize(text) {
  return String(text == null ? "" : text).toLowerCase().replace(/\s+/g, "");
}
/** 中文没有空格分词，二元组是零依赖下最稳的召回单位（跟 memory.js 同一套口径） */
function bigrams(text) {
  const s = normalize(text);
  const g = new Set();
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  return g;
}
function keywordScore(qGrams, text) {
  if (!qGrams || !qGrams.size) return 0;
  const g = bigrams(text);
  if (!g.size) return 0;
  let hit = 0;
  for (const x of g) if (qGrams.has(x)) hit++;
  return hit / Math.sqrt(g.size) / Math.sqrt(qGrams.size); // 余弦式归一，长会话不吃亏
}
function cosine(u, v) {
  if (!Array.isArray(u) || !Array.isArray(v) || u.length !== v.length || !u.length) return 0;
  let dot = 0, nu = 0, nv = 0;
  for (let i = 0; i < u.length; i++) { dot += u[i] * v[i]; nu += u[i] * u[i]; nv += v[i] * v[i]; }
  return nu && nv ? dot / Math.sqrt(nu) / Math.sqrt(nv) : 0;
}

/**
 * 命中片段：给 UI 一段「为什么是它」。
 * 返回的是下标不是拼好的 HTML——拼 HTML 得转义，而转义这件事只该有一个地方负责。
 * 找不到字面命中就返回开头那一截：总比一行标题孤零零摆着强，人至少看得出这趟在聊什么。
 */
function snippet(text, q, pad = SNIP_PAD) {
  const s = String(text == null ? "" : text);
  const w = String(q == null ? "" : q).trim();
  if (!s) return null;
  const at = w ? s.toLowerCase().indexOf(w.toLowerCase()) : -1;
  if (at < 0) {
    const head = s.split("\n").find((x) => x.trim()) || s;
    return { text: head.slice(0, pad * 3).trim(), at: -1, len: 0, head: true };
  }
  // 片段不跨行取：跨过去就把两轮不相干的话粘成一句，读的人会以为当时真这么说的
  let from = s.lastIndexOf("\n", at) + 1;
  let to = s.indexOf("\n", at); if (to < 0) to = s.length;
  const lo = Math.max(from, at - pad);
  const hi = Math.min(to, at + w.length + pad);
  const cut = s.slice(lo, hi);
  return { text: (lo > from ? "…" : "") + cut + (hi < to ? "…" : ""), at: at - lo + (lo > from ? 1 : 0), len: w.length, head: false };
}

const WHY = { title: "标题", file: "产出文件", body: "对话里", kw: "词面接近", vec: "意思相近" };

/**
 * 排序。rows 形如 { id, title, digest, files, at, vec }，vec 没有就没有。
 * 权重是刻意让「字面命中」压住「意思相近」的：人打一个词进去，first 的位置得留给真写着这个词的那条，
 * 不然他会觉得搜索在跟他较劲。语义只负责把「一个字都没对上但确实是那件事」的捞进来垫底。
 */
function rank(rows, q, o = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const w = String(q == null ? "" : q).trim();
  if (!w) return [];
  const lw = w.toLowerCase();
  const qg = bigrams(w);
  const qVec = Array.isArray(o.qVec) ? o.qVec : null;
  const vecMin = typeof o.vecMin === "number" ? o.vecMin : 0.35;
  const kwMin = typeof o.kwMin === "number" ? o.kwMin : 0.12;
  const limit = Math.max(1, Number(o.limit) || 30);

  const hits = [];
  for (const r of list) {
    if (!r) continue;
    const title = String(r.title || "");
    const digest = String(r.digest || "");
    const files = (Array.isArray(r.files) ? r.files : []).join(" ");
    const inTitle = title.toLowerCase().includes(lw);
    const inFile = !inTitle && files.toLowerCase().includes(lw);
    const inBody = !inTitle && !inFile && digest.toLowerCase().includes(lw);
    const lit = inTitle ? 1 : inFile ? 0.75 : inBody ? 0.6 : 0;
    const kw = keywordScore(qg, title + "\n" + title + "\n" + digest); // 标题算两遍：它是人唯一可能读过的那行
    const vec = qVec && Array.isArray(r.vec) ? cosine(qVec, r.vec) : 0;
    // 字面命中单独占一档。词面最高 1、语义最高 1，加权后顶天 0.5 + 0.8 = 1.3；
    // 最弱的那种字面命中（正文里写着）落在 LIT_BAND + 0.6 = 1.6，语义再满也够不着。
    // 不这么分档的话，一条「意思相近」满分会压过一条正文里真写着这个词的，
    // 而人打一个词进去，first 的位置得留给真写着这个词的那条——不然他会觉得搜索在跟他较劲。
    const score = (lit ? LIT_BAND + lit : 0) + 0.5 * kw + 0.8 * (vec >= vecMin ? vec : 0);
    if (!lit && kw < kwMin && vec < vecMin) continue;  // 一种都没沾上就别硬凑，凑出来的每一条都是让人多点一次
    const why = inTitle ? WHY.title : inFile ? WHY.file : inBody ? WHY.body : (vec >= vecMin && vec * 0.8 >= kw * 0.5 ? WHY.vec : WHY.kw);
    hits.push({
      id: r.id, row: r, score, why,
      lit, kw: Math.round(kw * 1000) / 1000, vec: Math.round(vec * 1000) / 1000,
      snippet: snippet(inTitle ? digest : (inFile ? files : digest), inTitle ? "" : w),
    });
  }
  // 分数一样就新的在前：同样贴题的两条，人要的几乎总是刚干过的那条
  hits.sort((a, b) => (b.score - a.score) || (Number(b.row.at || 0) - Number(a.row.at || 0)));
  return hits.slice(0, limit);
}

/** 搜完之后跟人交代一句实话：这次是靠什么找的，没靠上的那部分为什么没靠上 */
function searchNote(o = {}) {
  const n = Number(o.total) || 0;
  const semantic = !!o.semantic;
  const why = String(o.why || "");
  if (semantic) return `在 ${n} 条任务里找，标题、对话正文、产出文件名和意思相近的都算`;
  return `在 ${n} 条任务里找，标题、对话正文、产出文件名都算——${why || "这台机器没有可用的嵌入渠道"}，所以「意思相近」这一路这次没走`;
}

module.exports = {
  MAX_DIGEST, MAX_EMBED, LIT_BAND, WHY,
  assistantText, filesOf, digestOf, embedTextOf,
  normalize, bigrams, keywordScore, cosine, snippet, rank, searchNote,
};
