// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 弹给用户那一问之前的那道闸：这一问，非得用户本人答不可吗。
 *
 * ask_user 是整套工具里唯一一个**会把人拽回电脑前**的。别的工具做错了浪费的是钱和时间，
 * 这个做错了浪费的是用户的注意力——而注意力这东西，收回来一次比重跑一遍任务贵得多。
 *
 * 它现在是全场唯一一个不受转圈守卫管的工具。agent.js 里两处专门把它豁免掉：
 * 连续四次同参数的硬停不算它（问用户每次答案都不一样，算进去会误伤），十二步的循环侦测也不算它。
 * 豁免是对的，可豁免完就再没有别的东西拦着了——拦连环追问的只剩系统提示词里那一段话
 * （「一次只问一个，问完接着干，不许连环追问，也不许拿 ask_user 汇报进度」）。
 * 提示词是**建议**，不是闸：它在第一步好好的，跑到第十四步、上下文被压过两轮之后就开始漏。
 * 漏出来的样子是这样的：
 *
 *     第 3 步  「封面图走 AI 生图还是 HTML 排版截图？」        ← 该问，这就是岔路
 *     第 9 步  「我已经把前三节写完了，要继续往下写吗？」      ← 这不是问题，是汇报
 *     第 14 步 「抓数据用 axios 还是 node-fetch？」            ← 技术路线，它自己该定
 *     第 19 步 「刚才那张封面，还是按你选的排版截图来吧？」    ← 换个说法又问一遍
 *
 * 后三次每一次都让用户停下手里的活。第三次之后人就不想再开这个 agent 了——
 * 这个功能坏掉的方式不是报错，是**被人关掉**，而且关掉之前它一直显示正常。
 *
 * 这件事没法用正则做。问句长什么样跟它该不该问一点关系都没有：
 * 「要继续吗」可能是汇报，也可能真的是一笔要花钱的动作等你点头。
 * 该不该打断一个人，量的是**这一问缺了会怎样**，不是字符——那是判断模型该答的一道题。
 *
 * 四条边界：
 *   - **只能把「问」变成「不问」**。它拦不住的照样弹，这道闸救不回来，也绝不会凭空多问一句；
 *   - **一轮里的头一问永远放行，一分钱不花**。开工前问一题本来就是对的，
 *     出问题的从来是第二、第三、第四问。正常的一趟任务因此根本不碰这道闸；
 *   - **一字不差地又问一遍，白拦，开关关着也拦**。这种不必花钱去判，也不该弹第二次——
 *     它一分钱不花，就不该躲在那个管花钱的开关后面；
 *   - **说不准、答不上、问不成，一律照旧弹给用户**。闸坏了要退回老行为，
 *     不能反过来把用户真想答的那个岔路口吞掉——那是这套设计里唯一不可接受的错。
 *
 * 拦了要说清为什么，还要给一条回头路：真是选错就白做的岔路，把岔在哪说清楚再问一次，
 * 这道闸不拦说得清的岔路。回执是给 agent 看的，它得能照着改一句再来。
 *
 * 这儿一个字的网络都不发，发请求那一下在 agent.js。分开是为了这套判据能当纯函数测。
 */

const so = require("../../core/judge/systemone");

/** 两道题的名字。答案按名字取回来，两边必须是同一个常量。 */
const NEED_KEY = "非得用户答不可吗";
const KIND_KEY = "这一问算哪种";

/**
 * 拦下的门槛。跟记忆那道闸一样按 0.8 收，比通用的 0.7 严——
 * 两边判错的代价不对称：放行一句废问，用户白点一下就过去了；
 * 拦错一个真岔路口，agent 替他挑了一条，整件事可能白做，而他只会觉得
 * 「我明明该被问一句的」。拿不准的时候，这道闸的默认永远是弹出去。
 */
const NEED_MIN = 0.8;

/** 归类只用来把「为什么没弹」说人话，不参与拍板（拍板的永远是上面那道是非题）。 */
const KIND_CHOICES = {
  关键信息: "缺了它整件事会白做：发给谁、用哪个账号、动的是哪个文件",
  岔路: "选错了成品形态完全不同：横版还是竖版、Word 还是 PDF、生图还是排版截图",
  得你拍板: "要花钱、不可逆、要覆盖或删掉已有的东西、要对外发布，或者只有用户本人知道的事",
  汇报进度: "其实不是在问，是在说「我做到这儿了」，顺带求一句「还继续吗」",
  技术路线: "用哪个库、抓哪条接口、代码怎么组织、跑几轮——这个它自己该定",
  查得到: "答案在工作目录里，或者一条命令、一次搜索就能自己查出来",
  又问一遍: "前面已经问过、也答过了，这一问只是换了个说法",
  说不清: "上面几类都不像，或者信息太少看不出来",
};

/** 拦下来的那几类。别的一律放行——拍板的是是非题，这张表只决定回执里那句话怎么写。 */
const SKIP_KINDS = new Set(["汇报进度", "技术路线", "查得到", "又问一遍"]);

/** 摆给它看的现场，各段的上限。问句上游已经切到 500，这儿再收一刀：真岔路一句话就说得清。 */
const Q_CHARS = 300;
const LABEL_CHARS = 60;
const DETAIL_CHARS = 120;
const TASK_CHARS = 300;
/** 选项最多摆四个（工具本来就要求 2~4 个），前面问过的最多摆四问——再往前的，判这一问用不上。 */
const OPT_MAX = 4;
const PRIOR_MAX = 4;
const PRIOR_CHARS = 120;
const ANSWER_CHARS = 80;

const cut = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

/**
 * 判「一字不差」时用的形。空白折叠掉、中英文标点和大小写都抹平——
 * 「还继续吗？」和「还继续吗?」是同一个问题，不该因为一个问号多花一道题的钱，
 * 更不该因此弹第二次。
 */
const flat = (v) =>
  cut(v, Q_CHARS + 200)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？；：、,.!?;:~—…·「」『』（）()《》<>"'“”‘’]/g, "");

/**
 * 这一问走哪条路。三选一，只有 "judge" 那条才花钱。
 *   dup   —— 跟这一轮里问过的某一问一字不差：不必花钱去判，也不该再弹一次。开关关着也拦
 *   ask   —— 照旧弹（开关没开、没配判断模型、这一轮的头一问，全走这儿）
 *   judge —— 这一轮问过别的了，这一问值一道题
 *
 * @param {{on?:boolean, ready?:boolean, question?:string,
 *          prior?:Array<{q?:string, a?:string, skipped?:boolean}>}} x
 * @returns {{route:"ask"|"dup"|"judge", dup?:{q:string,a:string,skipped:boolean}}}
 */
function route({ on, ready, question, prior } = {}) {
  const q = cut(question, Q_CHARS);
  if (!q) return { route: "ask" };            // 空问句，上游那条规矩已经挡了
  const list = Array.isArray(prior) ? prior : [];
  // 一字不差又问一遍排在开关前面：这一条不花钱。以前它排在开关后面，
  // 开关默认关，于是这道最便宜的拦截在绝大多数人那儿从来没生效过——
  // 用户眼睁睁看着同一个问题弹两次，开关那头却以为「没开就是不管」。
  // 拦下过的也算「问过了」：不然同一句话被拦一次、原样再来一次，第二次又得花钱判一遍
  const f = flat(q);
  const hit = list.find((p) => p && flat(p.q) === f);
  if (hit) {
    return {
      route: "dup",
      dup: { q: cut(hit.q, PRIOR_CHARS), a: cut(hit.a, ANSWER_CHARS), skipped: !!hit.skipped },
    };
  }
  if (on !== true) return { route: "ask" };   // 开关默认关；写成别的值（字符串、1）都不算开
  if (!ready) return { route: "ask" };        // 没配判断模型
  if (!list.length) return { route: "ask" };  // 一轮里的头一问，白放行
  return { route: "judge" };
}

/** 问出去的两道题。一道拍板，一道只为把话说人话。 */
function needQuestions() {
  return {
    [NEED_KEY]: so.noul(
      "下面是一个 AI 助手干活干到一半时，想弹给用户的一个问题。弹出来，用户就得放下手里的事来点一下；" +
      "这一轮它已经问过别的了（前面那几问也摆在下面）。\n" +
      "判断：这一问，非得用户本人答不可吗？\n" +
      "算非得问：①缺了它整件事会白做的关键信息（发给谁、用哪个账号、动哪个文件）；" +
      "②选错了成品形态会完全不同的岔路（报告交 Word 还是 PDF、视频出横版还是竖版、" +
      "封面走 AI 生图还是排版截图）；③要花钱、不可逆、要覆盖或删掉已有的东西、要对外发布；" +
      "④只有用户本人才知道的事（预算、口味、时间安排、他跟谁什么关系）。\n" +
      "算不必问：在汇报做到哪了、顺带求一句「还继续吗」；技术路线（用哪个库、抓哪条接口、" +
      "代码怎么组织、跑几轮）——这个助手自己判断得了，挑一个直接动手，不成再换；" +
      "答案在工作目录里、或者一条命令一次搜索就查得出来的；前面那几问里已经答过、" +
      "这一问只是换了个说法。\n" +
      "看选项也能看出来：真岔路的两个选项，选了会得到完全不同的东西；" +
      "汇报式的问题，选项通常是「继续 / 停下」这种。\n" +
      "拿不准就当非得问。两边错得不一样重：放行一句废问，用户白点一下就过去了；" +
      "拦错一个真岔路口，助手就替他挑了一条，整件事可能白做。"
    ),
    [KIND_KEY]: so.choice("上面那一问最像哪一类。只为把理由说清楚，拿不准就选「说不清」。", KIND_CHOICES),
  };
}

/**
 * 摆给它看的现场。四段各自标好是什么：这一趟在干什么、想问的这一句、
 * 它给的选项、以及这一轮前面已经问过什么、用户答了什么。
 *
 * 最后那段是这道闸的命根子：连环追问只有把前面几问摆在一起才看得出来。
 * 单看「还继续吗」这一句，谁也判不出它是第二问还是第五问。
 */
function askState({ task, question, options, prior } = {}) {
  const opts = (Array.isArray(options) ? options : [])
    .slice(0, OPT_MAX)
    .map((o) => {
      const label = cut(o && (o.label != null ? o.label : o), LABEL_CHARS);
      const detail = cut(o && o.detail, DETAIL_CHARS);
      return label ? "· " + label + (detail ? "：" + detail : "（没写选了会怎样）") : "";
    })
    .filter(Boolean);
  const before = (Array.isArray(prior) ? prior : [])
    .slice(-PRIOR_MAX)
    .map((p, i) => {
      const q = cut(p && p.q, PRIOR_CHARS);
      if (!q) return "";
      const a = cut(p && p.a, ANSWER_CHARS);
      const tail = p && p.skipped ? "（这一问被拦下了，没弹出去）" : a ? "→ 用户答：" + a : "→ 用户还没答";
      return `${i + 1}. ${q} ${tail}`;
    })
    .filter(Boolean);
  return [
    "【这一趟在干什么】\n" + (cut(task, TASK_CHARS) || "（没记下来）"),
    "【它想问的这一句】\n" + (cut(question, Q_CHARS) || "（空的）"),
    "【它给的选项】\n" + (opts.length ? opts.join("\n") : "（一个选项都没给）"),
    "【这一轮前面已经问过】\n" + (before.length ? before.join("\n") : "（没有）"),
  ].join("\n\n");
}

/**
 * 读答案。只有一种情况回非空：它说「不必非问用户」，而且自己也拿得准 —— 那就别弹。
 * 其余全回 null = 当没问过 = 照老样子弹给用户。
 */
function readNeed(out, min) {
  const bar = Number.isFinite(Number(min)) ? Number(min) : NEED_MIN;
  const answers = (out && out.answers) || [];
  const a = answers.find((x) => x && x.key === NEED_KEY);
  // 答非所问也得当没答上来：万一哪天上游把这道是非题当单选答了，value 会是一句话，
  // 拿它跟 0.5 比大小比出来的东西没有意义，却能凭空吞掉用户真想答的那一问
  if (!a || !Number.isFinite(Number(a.value))) return null;
  if (Number(a.value) >= 0.5) return null;  // 它说非得问
  if (!so.gate(a, bar).act) return null;    // 它说不必问，但自己也拿不准。确定度这把尺子只有 systemone 那一把
  const k = answers.find((x) => x && x.key === KIND_KEY);
  const label = (k && k.value) || "";
  // 归类不在拦截那几类里，就别拦——包括归类压根没答上来的时候。是非题和单选题打架，
  // 按「照旧弹出去」收场；只剩一半证据，也按「照旧弹出去」收场。
  // 这道闸宁可白花一道题的钱，也不能吞掉一个说得上名字的岔路
  if (!SKIP_KINDS.has(label)) return null;
  return { sure: Number(a.sure) || 0, p: Number(a.value), bar, label };
}

/** 拦下的回执。说清三件事：为什么没弹、有多确定、接下来该怎么办。 */
function skipNote(d) {
  const kind = d && d.label;
  const why =
    kind === "汇报进度"
      ? "这不像一个问题，像是在汇报做到哪了、顺带求一句「继续」。不用求——没让你停你就接着干"
      : kind === "技术路线"
        ? "这是技术路线（用哪个库、抓哪条接口、跑几轮、代码怎么组织），这个你自己判断得了。挑最可能成的那条直接动手，不成再换"
        : kind === "查得到"
          ? "这个答案你自己查得到：翻一下工作目录，或者跑一条命令、搜一次"
          : kind === "又问一遍"
            ? "这一轮前面已经问过、也答过了，只是换了个说法。照那个答案往下做，别让用户把同一件事说两遍"
            : "它不像那种缺了就整件事白做的问题";
  return (
    `【没弹给用户】${why}（判断模型确定度 ${so.pct(d && d.sure)}）。` +
    "按你判断的最合理默认继续做，在最终汇报里注明你替用户做了什么假设。" +
    "要是我判错了——这真是那种选错就白做的岔路——把岔在哪、两条路各自得到什么写清楚，再问一次，说得清的岔路这道闸不拦。"
  );
}

/** 一字不差又问一遍的回执。这条不花钱，也不该把「用户答过什么」丢掉。 */
function dupNote(d) {
  const q = (d && d.q) || "";
  if (d && d.skipped) {
    return (
      `【没弹给用户】这一问你这一轮问过了（「${q}」），当时就没弹出去。原样再来一次，结果还是一样。` +
      "按你判断的最合理默认继续做，在最终汇报里注明你替用户做了什么假设。"
    );
  }
  const a = (d && d.a) || "";
  return (
    `【没弹给用户】这一问你这一轮已经问过了（「${q}」）` +
    (a ? `，用户当时答的是「${a}」。照那个答案往下做` : "，用户当时没答上来。按最合理的默认往下做") +
    "。同一个问题问两遍，用户只会觉得你没在听。"
  );
}

// ── 用户答过的，钉住 ─────────────────────────────────────────────
/**
 * 用户在这个会话里答过什么、中途补充过什么——钉进系统提示词，历史压缩压不到。
 *
 * 答案原本只活在 ask_user 那条工具结果里。长任务一压缩，那条结果跟着老轮次一起
 * 被浓缩成摘要；摘要模型只写它觉得要紧的，用户点过的那一项常常不在里面。
 * 本机一趟讲课 PPT：读了几份很长的技能说明，一趟任务压缩了十五次。用户先选了风格、
 * 又选了「AI 生成水墨插图」；压过几轮之后模型换了个说法第三次问风格，
 * 问句里自己写着「按纯矢量做、不生成 AI 图片」——用户选的路被忘了，它自己的默认又塞了回来。
 *
 * 跟技能、配方表单一个办法（见 skill-gate.skillBlock、recipes.pinBlock）：
 *   - 每一步的系统提示词末尾挂一段「用户已经答过的」，压缩碰不到系统提示词；
 *   - 压缩摘要里机械地记一行【用户定过的】（JSON），下一趟开跑照它捡回来——
 *     不经摘要模型转述，它会丢；
 *   - 只记用户真答过的（超时没答、被拦下没弹、配方表单都不算），外加中途插的话。
 * 按先后排，同一问答过两次留后一次，最多留最近 DECIDED_MAX 条。
 */
const DECIDED_TAG = "【用户定过的】";
const DECIDED_MAX = 12;
const DECIDED_Q = 100;
const DECIDED_A = 120;
const DECIDED_D = 80;
const DECIDED_SAID = 160;
const DECIDED_PIN_MAX = 1600;
/** 插话进历史时带的头、答案回给模型的那句话：写和读用同一组字，改一边另一边就认不出来了 */
const INTERJECT_HEAD = "【用户插话（在任务执行中补充）】";
const ANSWER_HEAD = "用户的回答：";
const DETAIL_HEAD = "（这条路你自己写的是：";
const DETAIL_TAIL = "——照它做）";

/** 用户答完回给模型的那句话。选中的那条路把 detail 一并回填：那句话是它自己写的承诺，照着做，别选完就忘 */
function answerNote(answer, detail) {
  const d = cut(detail, 400);
  return ANSWER_HEAD + String(answer == null ? "" : answer) + (d ? DETAIL_HEAD + d + DETAIL_TAIL : "");
}

/** answerNote 反过来读。不是用户真答的（超时、被拦、参数坏了）一律 null */
function readAnswer(content) {
  let s = String(content == null ? "" : content);
  if (!s.startsWith(ANSWER_HEAD)) return null;
  s = s.slice(ANSWER_HEAD.length);
  let d = "";
  const i = s.indexOf(DETAIL_HEAD);
  if (i >= 0 && s.endsWith(DETAIL_TAIL)) {
    d = s.slice(i + DETAIL_HEAD.length, s.length - DETAIL_TAIL.length);
    s = s.slice(0, i);
  }
  const a = s.trim();
  return a ? { a, d: d.trim() } : null;
}

/** 一条记录收拾成统一的形，不像样的回 null */
function cleanDecided(x) {
  if (!x || typeof x !== "object") return null;
  if (x.said != null) {
    const said = cut(x.said, DECIDED_SAID);
    return said ? { said } : null;
  }
  const q = cut(x.q, DECIDED_Q);
  const a = cut(x.a, DECIDED_A);
  if (!q || !a) return null;
  const d = cut(x.d, DECIDED_D);
  return d ? { q, a, d } : { q, a };
}
const decidedKey = (e) => (e.said != null ? "说:" + flat(e.said) : "问:" + flat(e.q));

/**
 * 几份记录并成一份：按先后排；同一问（折叠后一字不差）只留后答的那次、挪到最后，
 * 同一句插话也只留一次。最多留最近 DECIDED_MAX 条。
 */
function mergeDecided(...lists) {
  const out = [];
  for (const list of lists) {
    for (const x of Array.isArray(list) ? list : []) {
      const e = cleanDecided(x);
      if (!e) continue;
      const k = decidedKey(e);
      const i = out.findIndex((y) => decidedKey(y) === k);
      if (i >= 0) out.splice(i, 1);
      out.push(e);
    }
  }
  return out.slice(-DECIDED_MAX);
}

/**
 * 从历史里捡「用户答过什么」：ask_user 的问句配上它那条结果、中途插的话，
 * 以及压缩摘要里那行【用户定过的】（摘要排在历史最前面，正好是更早的那些）。
 */
function answeredIn(history) {
  const found = [];
  const asks = new Map(); // 工具调用 id → 问句
  for (const e of Array.isArray(history) ? history : []) {
    if (!e || typeof e !== "object") continue;
    if (e.role === "assistant") {
      for (const c of Array.isArray(e.toolCalls) ? e.toolCalls : []) {
        if (!c || c.name !== "ask_user" || c.id == null) continue;
        const input = c.input || c.args || {};
        if (input.form) continue; // 配方表单的答案钉在配方那边
        const q = String(input.question || "").trim();
        if (q) asks.set(c.id, q);
      }
    } else if (e.role === "tool") {
      for (const r of Array.isArray(e.results) ? e.results : []) {
        if (!r || !asks.has(r.id)) continue;
        const got = readAnswer(r.content);
        if (got) found.push({ q: asks.get(r.id), a: got.a, d: got.d });
        asks.delete(r.id);
      }
    } else if (e.role === "user" && typeof e.content === "string") {
      const c = e.content;
      if (c.startsWith(INTERJECT_HEAD)) found.push({ said: c.slice(INTERJECT_HEAD.length) });
      else if (c.startsWith("【系统")) {
        const m = /【用户定过的】([^\n]*)/.exec(c);
        if (m) {
          try {
            const list = JSON.parse(m[1]);
            if (Array.isArray(list)) found.push(...list);
          } catch {}
        }
      }
    }
  }
  return mergeDecided(found);
}

/** 压缩摘要里的那一行。没有就是空串 */
function summaryLine(list) {
  const items = mergeDecided(list);
  return items.length ? DECIDED_TAG + JSON.stringify(items) : "";
}

/** 钉进系统提示词的那一段。放不下时从最老的开始丢：最近答的那几条最要紧 */
function pinBlock(list) {
  const items = mergeDecided(list);
  if (!items.length) return "";
  const one = (s) => String(s).replace(/\s+/g, " ");
  const lines = items.map((e) =>
    e.said != null
      ? `- 用户中途补充：「${one(e.said)}」`
      : `- 你问「${one(e.q)}」→ 用户选「${one(e.a)}」` + (e.d ? `（这条路你当时写的是：${one(e.d)}）` : "")
  );
  const head = "\n\n## 这个会话里用户已经答过的（历史压缩也不会丢）\n";
  const foot =
    "\n照这些做，别换个说法再问同一件事；同一件事答过两次，以最后那次为准。你在问句里自己写的前提不算数，用户定的只是选中的那一项。跟眼下这件事无关的不用管。" +
    "\n真做不成（缺工具、报错、要多花钱），先说清卡在哪，再问；不许悄悄换一条路。";
  while (lines.length > 1 && head.length + foot.length + lines.join("\n").length > DECIDED_PIN_MAX) lines.shift();
  return head + lines.join("\n") + foot;
}

module.exports = {
  route, needQuestions, askState, readNeed, skipNote, dupNote, flat,
  answerNote, readAnswer, answeredIn, mergeDecided, summaryLine, pinBlock,
  NEED_KEY, KIND_KEY, NEED_MIN, KIND_CHOICES, SKIP_KINDS,
  Q_CHARS, TASK_CHARS, OPT_MAX, PRIOR_MAX,
  INTERJECT_HEAD, DECIDED_TAG, DECIDED_MAX, DECIDED_PIN_MAX,
};
