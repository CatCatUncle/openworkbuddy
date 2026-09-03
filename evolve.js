"use strict";
/**
 * 自进化：把「翻日志找毛病 → 改一句提示词 → 看数字有没有下去」这条我一直手工在走的路，
 * 变成应用自己每天跑的机制。
 *
 * 为什么要有这一层：这个应用已经攒了 100+ 个真实会话，里面写着它到底败在哪儿——
 * 模型幻觉出一个不存在的工具（`未知工具: directory_tree`）、edit_file 的锚点老对不上、
 * run_shell 一跑就超时、用户中途按停。这些都是**可数的**，但没人天天去数，
 * 于是同一个坑一个月踩四遍。
 *
 * 五段，每一段的产物都能单独看：
 *   1. 信号  mineSignals()   —— 从会话事件和用户反馈里数出「哪类毛病、几次、哪几次」
 *   2. 提案  proposeEdits()  —— 只给数量过线的信号提**最小**改动，并且必须说清怎么验证
 *   3. 闸门  gateProposal()  —— 代码侧先枪毙一批：证据不够、和现有规则重复、超预算
 *   4. 人审  decideProposal()—— 永不自动生效。采纳是人点的，驳回的理由会喂回给下一轮
 *   5. 复盘  scoreRules()    —— 规则生效后目标信号的频次有没有真的降下来，没降就提议下架
 *
 * 三条纪律，是踩过的坑换来的，写死在代码里而不是写在提示词里：
 *   - **归类比数不比措辞**：信号按「工具名 + 错误形状」归一化聚类，不按报错原文。
 *     措辞换三版而数字没变，等于什么都没发生。
 *   - **不是所有毛病都该用提示词治**。渠道欠费是配置问题，工具不存在是代码问题，
 *     给它们加一条「请注意余额」只是自我安慰。所以每个信号带 actionable：
 *     prompt / config / code，只有 prompt 那一档才允许长成规则。
 *   - **规则有预算、会过期**。上限 12 条 / 4000 字；想加第 13 条就必须指名下架一条。
 *     没让数字下去的规则会被标出来提议下架——提示词只许越用越准，不许越堆越长。
 */

const fs = require("fs");
const path = require("path");
const { dataPath } = require("./paths");
const store = require("./store");

const DATA_DIR = process.env.WB_DATA_DIR || dataPath("data");
const SESS_DIR = path.join(DATA_DIR, "sessions");
const FEEDBACK_FILE = path.join(DATA_DIR, "feedback.json");
const PROPOSALS_FILE = path.join(DATA_DIR, "proposals.json");
const RUNS_FILE = path.join(DATA_DIR, "evolve_runs.json");
const RULES_DIR = path.join(DATA_DIR, "learned");

const CAPS = {
  rules: 12,          // 同时生效的规则条数上限
  ruleChars: 400,     // 单条规则字数上限——一条规则是一句能照做的话，不是一篇小作文
  blockChars: 4000,   // 注入系统提示词的总预算
  minEvidence: 3,     // 少于这么多次的毛病不许提规则：一次是偶然，三次才是模式
  window: 14,         // 默认统计窗口（天）
};

const ensureDir = (d) => { try { fs.mkdirSync(d, { recursive: true }); } catch {} };
const nowIso = () => new Date().toISOString();
const uid = (p) => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ============================ 1. 信号 ============================

/**
 * 把一条工具报错归成一类。**按形状归类，不按原文**：原文里有路径、有行号、有时间戳，
 * 照原文聚类的话同一个毛病会散成几十个"只出现过一次"的条目，永远过不了证据门槛。
 */
function classifyToolError(name, preview) {
  const p = String(preview || "");
  const m = /未知工具[:：]\s*([A-Za-z0-9_.-]+)/.exec(p);
  // 模型凭空叫一个不存在的工具：这是代码侧的事（要么补上这个工具，要么工具清单没讲清楚），
  // 加一条"请不要调用不存在的工具"的提示词纯属自我安慰
  if (m) return { kind: "unknown_tool", key: "unknown_tool:" + m[1], actionable: "code", label: `模型调用了不存在的工具 ${m[1]}` };
  if (name === "edit_file" && /没找到 old_text|old_text/.test(p))
    return { kind: "edit_anchor_miss", key: "edit_anchor_miss", actionable: "prompt", label: "edit_file 的 old_text 和文件里的真实内容对不上" };
  // 写完自检把产物顶回来（JS 语法坏了 / 网页标签没闭合 / 用了没定义的 CSS 变量）。
  // 这类和"改文件失败"是两码事：文件写进去了，是**内容不合格**。混在 tool_error:edit_file 那个
  // 大杂烩里的话，19 次会跟"路径是目录"之类挤成一堆"edit_file 报错"，等于没归类。
  // 按形状分而不是按工具分：三种报错文案不同，毛病是同一个——一次没写完整就交，然后反复打补丁
  if (/语法没过|语法坏了|页面结构有问题/.test(p) && /已修改|已写入|已生成|已创建/.test(p))
    return { kind: "selfcheck_reject", key: "selfcheck_reject:" + name, actionable: "prompt", label: `${name} 写完自检没过（语法/页面结构），产物被顶回来` };
  if (/执行超时被终止|timed? ?out/i.test(p))
    return { kind: "tool_timeout", key: "tool_timeout:" + name, actionable: "prompt", label: `${name} 跑到超时被掐断` };
  if (/命令未获批准/.test(p))
    return { kind: "approval_denied", key: "approval_denied:" + name, actionable: "prompt", label: `${name} 要的审批被拒或超时` };
  if (/安全中心拦截|路径越界|Access denied|permission denied/i.test(p))
    return { kind: "blocked", key: "blocked:" + name, actionable: "config", label: `${name} 撞上安全策略的目录白名单` };
  // check_page 的报错要拆开看，不然 27 次全挤在"check_page 报错"里，等于没归类：
  // 引外链和控制台报错是产物真的有毛病（提示词能治），Electron 自己的安全警告是工具误报（得改代码）
  if (name === "check_page") {
    if (/引了 \d+ 个外部资源/.test(p))
      return { kind: "external_resource", key: "external_resource", actionable: "prompt", label: "产出的网页引了外部资源，断网就白屏" };
    // 「控制台报错 1 条」而那一条就是 Electron 自己的 CSP 警告——这是预览容器的噪音，不是页面的毛病。
    // 真报错必须让位在前面：一个页面同时有真错和这条噪音时，归成误报就等于把真问题藏了
    const cn = /控制台报错\s*(\d+)\s*条/.exec(p);
    if (cn && +cn[1] === 1 && /Electron Security Warning/i.test(p))
      return { kind: "tool_false_alarm", key: "tool_false_alarm:check_page", actionable: "code", label: "check_page 把预览容器自己的 Electron 安全警告当成页面报错" };
    if (cn) return { kind: "page_console_error", key: "page_console_error", actionable: "prompt", label: "产出的网页一打开控制台就报错" };
  }
  // shell 里最常见的三种死法分开数：命令写错 ≠ 脚本自己崩 ≠ 通配符被 zsh 吃了
  if (/no matches found|zsh: no matches/i.test(p))
    return { kind: "zsh_glob", key: "zsh_glob", actionable: "prompt", label: "通配符没加引号，被 zsh 当场拒掉" };
  if (/Traceback \(most recent call last\)|SyntaxError|NameError|ModuleNotFoundError/.test(p))
    return { kind: "script_error", key: "script_error:" + name, actionable: "prompt", label: `${name} 跑的脚本自己崩了` };
  if (/EISDIR|is a directory|是一个目录，不是文件/i.test(p))
    return { kind: "path_is_dir", key: "path_is_dir:" + name, actionable: "prompt", label: `${name} 把目录当文件读写` };
  if (/ENOENT|no such file/i.test(p))
    return { kind: "missing_file", key: "missing_file:" + name, actionable: "prompt", label: `${name} 找不到文件` };
  if (/接口错误 5\d\d|InternalServiceError|Service is too busy/i.test(p))
    return { kind: "upstream_5xx", key: "upstream_5xx:" + name, actionable: "config", label: `${name} 的上游服务出错` };
  return { kind: "tool_error", key: "tool_error:" + name, actionable: "prompt", label: `${name} 报错` };
}

/** 非工具类事件（上限、中断、验收打回）也归一化成同一套信号 */
function classifyEvent(e) {
  if (e.type === "limit") {
    const n = String(e.note || "");
    // 用户按停是最硬的负反馈：比 👎 还直接——他不是不满意结果，是当场就看不下去了
    if (/手动停止/.test(n)) return { kind: "stopped_by_user", key: "stopped_by_user", actionable: "prompt", label: "用户中途手动停止" };
    if (/超时|没有任何输出/.test(n)) return { kind: "llm_timeout", key: "llm_timeout", actionable: "config", label: "模型响应超时" };
    if (/步数/.test(n)) return { kind: "max_steps", key: "max_steps", actionable: "prompt", label: "步数用尽被收尾" };
    if (/运行时间/.test(n)) return { kind: "max_runtime", key: "max_runtime", actionable: "prompt", label: "跑到最大运行时间被收尾" };
    return null;
  }
  if (e.type === "error") {
    const m2 = String(e.message || "");
    if (/余额不足|Insufficient Balance|more credits|402/i.test(m2))
      return { kind: "provider_credit", key: "provider_credit", actionable: "config", label: "渠道余额不足，模型不给跑" };
    if (/被关闭或重启/.test(m2)) return { kind: "app_restart", key: "app_restart", actionable: "code", label: "任务执行中应用被关掉，这一轮断了" };
    return { kind: "run_error", key: "run_error", actionable: "code", label: "任务出错中断" };
  }
  // 验收打回：目标验收员判定没达标又踢回去重做。打回轮次多 = 第一遍交的东西不合格
  if (e.type === "interject" && /验收/.test(String(e.text || "")))
    return { kind: "acceptance_bounce", key: "acceptance_bounce", actionable: "prompt", label: "产物没过验收被打回重做" };
  return null;
}

function readSessions(dir = SESS_DIR) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      d._id = f.replace(/\.json$/, "");
      out.push(d);
    } catch {} // 单个会话文件坏了不该让整套体检哑掉
  }
  return out;
}

/**
 * 数出这段时间里各类毛病出现了几次、分别在哪几个会话。
 * 每个信号都带**能点回去的证据**（会话 id + 第几轮 + 原文摘录）——
 * 没有证据的信号只是观点，改了也没法验。
 */
function mineSignals({ days = CAPS.window, dir = SESS_DIR, feedbackFile = FEEDBACK_FILE, now = Date.now(), datedOnly = false } = {}) {
  const since = now - days * 86400e3;
  const map = new Map();
  const bump = (c, ev) => {
    if (!c) return;
    let s = map.get(c.key);
    if (!s) map.set(c.key, (s = { key: c.key, kind: c.kind, actionable: c.actionable, label: c.label, count: 0, dated: 0, undated: 0, sessions: new Set(), samples: [], firstAt: null, lastAt: null }));
    s.count++;
    if (ev.session) s.sessions.add(ev.session);
    if (s.samples.length < 4) s.samples.push(ev);
    // 只有真带时间的回合才有资格决定 firstAt/lastAt。老数据没有逐轮时间，
    // 拿会话的 updated_at 顶上去会**编出一个精确到毫秒的假日期**——正是它让
    // "这个毛病还在犯吗"这个最该问的问题变得没法回答。宁可留 null。
    if (!ev.dated) { s.undated++; return; }
    s.dated++;
    if (!s.firstAt || ev.at < s.firstAt) s.firstAt = ev.at;
    if (!s.lastAt || ev.at > s.lastAt) s.lastAt = ev.at;
  };

  let turns = 0;
  let undatedTurns = 0;
  for (const sess of readSessions(dir)) {
    const sessAt = Date.parse(sess.updated_at || "") || 0;
    // updated_at 不会早于任何一轮，所以它在窗口外就代表整个会话都在窗口外，可以整个跳过。
    // 反过来不成立——它在窗口内**不代表**里面每一轮都在窗口内，那得逐轮看。
    if (sessAt && sessAt < since) continue;
    (sess.transcript || []).forEach((t, i) => {
      if (t.type !== "assistant") return;
      const turnAt = Date.parse(t.at || "") || 0;
      if (turnAt && turnAt < since) return; // 这一轮自己带时间，且落在窗口外
      if (!turnAt && datedOnly) return;     // 打分要问"生效之后"，没时间的回合答不了这个问题
      turns++;
      if (!turnAt) undatedTurns++;
      const ask = (sess.transcript[i - 1] || {}).text || "";
      for (const e of t.events || []) {
        const ev = { session: sess._id, turn: i, at: turnAt || sessAt, dated: !!turnAt, task: String(ask).slice(0, 120), excerpt: "" };
        if (e.type === "tool_result" && e.isError) {
          ev.excerpt = String(e.preview || "").slice(0, 200);
          bump(classifyToolError(e.name, e.preview), ev);
        } else {
          const c = classifyEvent(e);
          if (c) { ev.excerpt = String(e.note || e.message || e.text || "").slice(0, 200); bump(c, ev); }
        }
      }
    });
  }

  // 用户显式反馈：👎 是最贵也最准的信号，一条顶十条推断
  for (const fb of readFeedback(feedbackFile)) {
    const at = Date.parse(fb.at || "") || 0;
    if (at && at < since) continue;
    if (fb.verdict !== "down") continue;
    bump(
      { kind: "thumbs_down", key: "thumbs_down", actionable: "prompt", label: "用户点了「没帮助」" },
      { session: fb.session || "", turn: fb.turn, at, dated: !!at, task: String(fb.task || "").slice(0, 120), excerpt: String(fb.note || "（没写理由）").slice(0, 200) }
    );
  }

  const signals = [...map.values()]
    .map((s) => ({ ...s, sessions: [...s.sessions], rate: turns ? +(s.count / turns).toFixed(4) : 0 }))
    .sort((a, b) => b.count - a.count);
  return { since: new Date(since).toISOString(), days, turns, undatedTurns, signals };
}

// ============================ 反馈落盘 ============================
// 原来界面上的 👍👎 点了只是换个高亮色，一个字节都没往外送——按了等于没按。
// 反馈要在"干活的地方"零摩擦地收，收不到就没有后面这一整条链。

function readFeedback(file = FEEDBACK_FILE) { return store.readJson(file, []); }

function recordFeedback({ user = "", session = "", turn = null, verdict, note = "", task = "", reply = "" } = {}) {
  if (verdict !== "up" && verdict !== "down") throw new Error("verdict 只能是 up 或 down");
  const list = readFeedback();
  // 同一轮反复点：改判而不是攒一堆重复记录（用户改主意很正常）
  const i = list.findIndex((x) => x.session === session && x.turn === turn);
  const rec = {
    id: i >= 0 ? list[i].id : uid("fb"), at: nowIso(), user, session, turn, verdict,
    note: String(note).slice(0, 500), task: String(task).slice(0, 300), reply: String(reply).slice(0, 800),
  };
  if (i >= 0) list[i] = rec; else list.push(rec);
  ensureDir(DATA_DIR);
  store.writeJsonAtomic(FEEDBACK_FILE, list.slice(-2000), { pretty: true });
  return rec;
}

// ============================ 规则库 ============================
// 一条规则一个文件：人能直接读、能直接改、撤销就是删一个文件，不用回滚一个大 JSON。

function activeRules() {
  if (!fs.existsSync(RULES_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(RULES_DIR)) {
    if (!f.endsWith(".md")) continue;
    try {
      const raw = fs.readFileSync(path.join(RULES_DIR, f), "utf8");
      const meta = /^<!--\s*(\{[\s\S]*?\})\s*-->\s*/.exec(raw);
      out.push({ id: f.replace(/\.md$/, ""), text: raw.slice(meta ? meta[0].length : 0).trim(), meta: meta ? JSON.parse(meta[1]) : {} });
    } catch {}
  }
  return out.sort((a, b) => String(a.meta.at || "").localeCompare(String(b.meta.at || "")));
}

/** 归一化指纹：去标点、去空白，只留实词，用来判"这条是不是已经有了" */
function ruleDigest(text) {
  return String(text).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "").slice(0, 120);
}

/** 注入系统提示词的那一段。超预算就按时间倒序截断并且**明说截了**，不闷声吞。 */
function promptBlock() {
  const rules = activeRules();
  if (!rules.length) return "";
  let body = "";
  let dropped = 0;
  for (const r of rules) {
    const line = `- ${r.text}\n`;
    if (body.length + line.length > CAPS.blockChars) { dropped++; continue; }
    body += line;
  }
  return `\n\n## 从过往任务里学到的（自进化规则，${rules.length - dropped} 条）\n` +
    `这些是从你自己跑砸过的任务里总结出来的，每一条背后都有具体次数，别当客套话跳过：\n${body}` +
    (dropped ? `（还有 ${dropped} 条因为超出提示词预算没放进来）\n` : "");
}

// ============================ 3. 闸门 ============================

/**
 * 代码侧先枪毙一批，别把「看着像那么回事」的提案送到人跟前浪费注意力。
 * 返回 null 表示放行，返回字符串表示毙掉的理由（理由会记下来，下一轮别再提）。
 */
function gateProposal(p, { signals = [], rules = activeRules() } = {}) {
  if (!p || !p.kind) return "提案缺 kind";
  if (p.kind === "retire_rule") {
    return rules.some((r) => r.id === p.target) ? null : `要下架的规则 ${p.target} 不存在`;
  }
  const text = String(p.rule || "").trim();
  if (!text) return "提案没给规则正文";
  if (text.length > CAPS.ruleChars) return `规则 ${text.length} 字，超过单条上限 ${CAPS.ruleChars} 字——一条规则是一句能照做的话，不是小作文`;
  const sig = signals.find((s) => s.key === p.signal);
  if (!sig) return `引用的信号 ${p.signal} 不在本次统计里`;
  if (sig.actionable !== "prompt")
    return `${sig.label} 是「${sig.actionable === "code" ? "代码" : "配置"}」问题，加提示词治不了它（${sig.count} 次）`;
  if (sig.count < CAPS.minEvidence) return `只有 ${sig.count} 次证据，不到 ${CAPS.minEvidence} 次的门槛——一次是偶然，三次才是模式`;
  const digest = ruleDigest(text);
  const dup = rules.find((r) => ruleDigest(r.text) === digest);
  if (dup) return `和已生效的规则 ${dup.id} 重复了`;
  if (rules.length >= CAPS.rules && !p.retire)
    return `已经有 ${rules.length} 条规则（上限 ${CAPS.rules}）。要加新的就得指名下架一条——提示词只许越用越准，不许越堆越长`;
  if (p.retire && !rules.some((r) => r.id === p.retire)) return `要换下的规则 ${p.retire} 不存在`;
  if (!p.verify) return "没说清怎么验证：这条规则生效后，哪个数字应该降下去？";
  return null;
}

// ============================ 提案存取 & 人审 ============================

function listProposals() { return store.readJson(PROPOSALS_FILE, []); }
function saveProposals(list) { ensureDir(DATA_DIR); store.writeJsonAtomic(PROPOSALS_FILE, list.slice(-500), { pretty: true }); }

function addProposals(items) {
  const list = listProposals();
  const seen = new Set(list.filter((x) => x.status === "pending" || x.status === "applied").map((x) => ruleDigest(x.rule || x.target || "")));
  const added = [];
  for (const p of items) {
    const d = ruleDigest(p.rule || p.target || "");
    if (seen.has(d)) continue; // 同一条别反复端上来
    const rec = { id: uid("pr"), at: nowIso(), status: "pending", ...p };
    list.push(rec); added.push(rec); seen.add(d);
  }
  saveProposals(list);
  return added;
}

/**
 * 人审。**永远不自动生效**——这是拿真实提示词做改动，得有人点头。
 * 驳回的理由会存下来当负样本：下一轮生成提案时原样喂回去，别再提同一件事。
 */
function decideProposal(id, decision, { by = "", reason = "" } = {}) {
  const list = listProposals();
  const p = list.find((x) => x.id === id);
  if (!p) throw new Error("提案不存在");
  if (p.status !== "pending") throw new Error(`这条提案已经是「${p.status}」了`);
  p.decidedAt = nowIso(); p.decidedBy = by; p.reason = String(reason).slice(0, 300);
  if (decision === "reject") { p.status = "rejected"; saveProposals(list); return p; }
  if (decision !== "accept") throw new Error("decision 只能是 accept 或 reject");

  if (p.kind === "retire_rule") {
    retireRule(p.target, "人工采纳下架提案");
    p.status = "applied"; saveProposals(list); return p;
  }
  const gate = gateProposal(p, { signals: p.signalSnapshot ? [p.signalSnapshot] : [], rules: activeRules() });
  // 采纳时再过一遍闸门：提案可能在待审期间因为别的提案被采纳而失效（比如条数已经满了）
  if (gate && !/不在本次统计里/.test(gate)) throw new Error("采纳前复核没过：" + gate);
  if (p.retire) retireRule(p.retire, `被 ${p.id} 换下`);
  ensureDir(RULES_DIR);
  const rid = "rule_" + p.id.replace(/^pr_/, "");
  const meta = { at: nowIso(), from: p.id, signal: p.signal, baseline: p.baseline || null, verify: p.verify || "" };
  fs.writeFileSync(path.join(RULES_DIR, rid + ".md"), `<!-- ${JSON.stringify(meta)} -->\n${p.rule}\n`);
  p.status = "applied"; p.ruleId = rid;
  saveProposals(list);
  return p;
}

function retireRule(ruleId, why = "") {
  const f = path.join(RULES_DIR, ruleId + ".md");
  if (!fs.existsSync(f)) throw new Error("规则不存在：" + ruleId);
  ensureDir(path.join(RULES_DIR, "retired"));
  fs.renameSync(f, path.join(RULES_DIR, "retired", ruleId + ".md"));
  const list = listProposals();
  const p = list.find((x) => x.ruleId === ruleId);
  if (p) { p.status = "retired"; p.retiredAt = nowIso(); p.retiredWhy = why; saveProposals(list); }
  return { ruleId, why };
}

// ============================ 5. 复盘 ============================

/**
 * 规则到底有没有用。**只看数字，不看措辞**——这是整套东西里最要紧的一环：
 * 没有它，自进化就退化成"每天往提示词里加一句正确的废话"。
 * 判据：规则生效那天之前的窗口里，目标信号每回合出现 baseline.rate 次；
 * 生效之后到现在是 after.rate。降了就留着，没降（或更糟）就提议下架。
 */
function scoreRules({ dir = SESS_DIR, now = Date.now(), minTurns = 20 } = {}) {
  const out = [];
  for (const r of activeRules()) {
    const bornAt = Date.parse(r.meta.at || "") || 0;
    const base = r.meta.baseline || null;
    if (!bornAt || !base || !base.key) { out.push({ id: r.id, verdict: "无从判断", why: "这条规则没记生效前的基线" }); continue; }
    // datedOnly：这里问的是"这条规则生效**之后**表现如何"，只有自己带时间戳的回合答得了。
    // 不加这个开关的话，一个今天被打开过的老会话会把它里面**规则生效之前**的失败
    // 全算成"生效之后"——规则越有效越会被判「没起作用」并建议下架，正好判反。
    const after = mineSignals({ days: Math.max(1, Math.ceil((now - bornAt) / 86400e3)), dir, now, datedOnly: true });
    if (after.turns < minTurns) { out.push({ id: r.id, verdict: "样本不够", why: `生效后才跑了 ${after.turns} 个带时间的回合，不到 ${minTurns} 个，先别下结论` }); continue; }
    const s = after.signals.find((x) => x.key === base.key);
    const afterRate = s ? s.rate : 0;
    const drop = base.rate ? +(((base.rate - afterRate) / base.rate) * 100).toFixed(1) : 0;
    out.push({
      id: r.id, signal: base.key, beforeRate: base.rate, afterRate, dropPct: drop, turns: after.turns,
      verdict: drop >= 30 ? "有效" : drop > 0 ? "略有改善" : "没起作用",
      why: `每回合出现率 ${base.rate} → ${afterRate}（${drop >= 0 ? "降" : "升"} ${Math.abs(drop)}%）`,
      suggestRetire: drop <= 0,
    });
  }
  return out;
}

// ============================ 2. 提案生成（要模型） ============================

const PROPOSER_SYSTEM = `你在给一个 AI 办公智能体做「事后复盘 → 最小修正」。给你的是它最近这段时间跑砸的统计。

铁律（违反的提案会被代码直接毙掉，白写）：
1. 一次只治一类毛病，且只提**最小**改动。能加一句话解决的，不要重写一段。
2. 只准针对 actionable="prompt" 的信号提规则。actionable="code"（比如模型叫了一个不存在的工具）和
   actionable="config"（比如渠道欠费）加提示词治不了，提了也是白提——这类请放进 notes 里提醒人，别写成规则。
3. 每条规则必须 ≤ 400 字，是**一句照着就能做的具体指令**，不是"要认真""要仔细"这种正确的废话。
4. 必须给 verify：这条规则生效后，哪个信号的出现率应该降下去。
5. 我会把当前已经生效的规则和智能体现有提示词的相关片段给你。**如果新规则和现有的某一条打架，
   不要新加一条**——改成 kind="retire_rule" 先把打架的那条下架，或者直接说明白冲突在哪。
   （经验：措辞叠三层而数字没动，十有八九是有一条在反着说。）
6. 拿不准就少提。宁可这一轮一条都不提，也不要凑数。

只输出一个 JSON 对象：
{"proposals":[{"kind":"add_rule"|"retire_rule","signal":"信号 key","target":"要下架的规则 id（retire_rule 才填）",
"title":"一句话说这是治什么的","rule":"要加的规则正文（add_rule 才填）","why":"为什么这么改，引用具体次数",
"verify":"生效后哪个数字该降","retire":"要换下的规则 id（条数满了才填）"}],"notes":["给人看的提醒，不进提示词"]}`;

function signalsForPrompt(mined, { top = 8 } = {}) {
  return mined.signals.slice(0, top).map((s) => ({
    key: s.key, 毛病: s.label, 次数: s.count, 每回合出现率: s.rate,
    该谁治: s.actionable, 涉及会话数: s.sessions.length,
    // 提案模型最需要知道的是"这毛病还在犯吗"——已经修好的东西不该再给它提方案。
    // 但也只在真有逐轮时间戳时才说得出口，说不出就明说说不出，别拿会话的 updated_at 硬凑。
    最近一次: s.lastAt ? new Date(s.lastAt).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "时间不明（这些是没有逐轮时间戳的老数据）",
    样本: s.samples.slice(0, 2).map((x) => `【任务】${x.task}｜【现场】${x.excerpt}`),
  }));
}

/**
 * 让模型看着统计出提案。注意：模型只负责"想"，能不能上由 gateProposal 和人说了算。
 * 被驳回过的提案原样喂回去当负样本——不然它每天端一样的菜上来。
 */
async function proposeEdits({ llm, mined, rules = activeRules(), rejected = [], promptExcerpt = "", top = 8 } = {}) {
  if (!llm || !llm.chat) throw new Error("proposeEdits 需要一个 llm");
  const payload = {
    统计窗口: `${mined.days} 天，共 ${mined.turns} 个助手回合` +
      (mined.undatedTurns ? `（其中 ${mined.undatedTurns} 个是老数据，只知道发生过、不知道发生在哪天）` : ""),
    信号: signalsForPrompt(mined, { top }),
    已经生效的规则: rules.map((r) => ({ id: r.id, 正文: r.text })),
    规则预算: `已用 ${rules.length}/${CAPS.rules} 条`,
    之前被人驳回过的提案: rejected.slice(-8).map((p) => ({ 提过什么: p.title || p.rule, 驳回理由: p.reason || "（没写）" })),
    智能体现有提示词里相关的片段: String(promptExcerpt).slice(0, 4000),
  };
  let text = "";
  const res = await llm.chat({
    system: PROPOSER_SYSTEM,
    history: [{ role: "user", content: "这是最近的复盘数据，按铁律给出提案：\n" + JSON.stringify(payload, null, 1) }],
    tools: [],
    onTextDelta: (d) => { text += d; },
  });
  const raw = (res && res.text) || text || "";
  const j = /\{[\s\S]*\}/.exec(raw);
  if (!j) throw new Error("提案生成没拿到 JSON：" + raw.slice(0, 200));
  const parsed = JSON.parse(j[0]);
  const out = [];
  for (const p of parsed.proposals || []) {
    const sig = mined.signals.find((s) => s.key === p.signal);
    const reject = gateProposal(p, { signals: mined.signals, rules });
    out.push({
      ...p,
      gate: reject || "",                       // 没过闸门的也留着：能看出模型在往哪个方向使错劲
      status: reject ? "gated" : "pending",
      signalSnapshot: sig ? { key: sig.key, count: sig.count, rate: sig.rate, actionable: sig.actionable, label: sig.label } : null,
      baseline: sig ? { key: sig.key, rate: sig.rate, count: sig.count, turns: mined.turns, at: nowIso() } : null,
      evidence: sig ? sig.samples.slice(0, 3) : [],
    });
  }
  return { proposals: out, notes: parsed.notes || [] };
}

// 后台自己跑的那轮如果炸了，不许闷声吞掉——没人看得见的失败等于这条飞轮已经停了而你还以为它在转。
// 成败都记一行，界面上直接看得到「上次几点跑的、成没成、为什么没成」。
function recordRun(rec) {
  const list = store.readJson(RUNS_FILE, []);
  list.push({ at: nowIso(), ...rec });
  ensureDir(DATA_DIR);
  store.writeJsonAtomic(RUNS_FILE, list.slice(-100), { pretty: true });
  return list[list.length - 1];
}
function listRuns(n = 10) { return store.readJson(RUNS_FILE, []).slice(-n).reverse(); }

/** 一次完整的复盘：数信号 → 出提案 → 过闸门 → 落盘等人审。绝不自动生效。 */
async function runReview({ llm, days = CAPS.window, promptExcerpt = "" } = {}) {
  const mined = mineSignals({ days });
  if (!mined.turns) return { mined, added: [], notes: ["这段时间没有任务记录，没什么可复盘的"] };
  const rejected = listProposals().filter((p) => p.status === "rejected");
  const { proposals, notes } = await proposeEdits({ llm, mined, rejected, promptExcerpt });
  const added = addProposals(proposals.filter((p) => !p.gate));
  const scored = scoreRules();
  for (const s of scored) if (s.suggestRetire) notes.push(`规则 ${s.id} ${s.why}，建议下架`);
  return { mined, added, gated: proposals.filter((p) => p.gate), notes, scored };
}

module.exports = {
  CAPS,
  recordFeedback, readFeedback,
  recordRun, listRuns,
  mineSignals,
  activeRules, promptBlock, retireRule,
  gateProposal, listProposals, addProposals, decideProposal,
  proposeEdits, runReview, scoreRules,
  _internals: { classifyToolError, classifyEvent, ruleDigest, readSessions, RULES_DIR, DATA_DIR },
};
