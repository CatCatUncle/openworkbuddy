"use strict";
/**
 * Goal 模式：用户给一个目标，先拆成可验收的标准，跑完一轮对着标准验收，没达标自动再跑。
 *
 * 这套东西原本整段长在 `server.js` 的 `/api/chat` 里，于是它只对网页和手机存在。
 * 命令行那边的模式表是手抄的三个（craft/plan/ask），goal 压根没抄进去——
 * `openworkbuddy --mode goal` 被参数表当成不认识的模式挡掉，而在交互里敲 `/mode goal` 更糟：
 * 一个字的校验都没有，状态行照印「模式 goal」，底下 `["ask","plan","craft"].includes("goal")`
 * 判 false，安安静静按 craft 跑完。用户以为自己开了目标验收，实际上从来没有验收过。
 *
 * 所以把它搬到这儿，两个入口共用一份。搬家时**一行判定逻辑都没改**——
 * 验收标准怎么拆、拿不准算不算达成、自动体检查什么，全是原样；
 * 唯一抽出去的是「动脑那句话问谁」（think）和「工作目录在哪」（workspaceDir），
 * 因为服务端要借登录用户配的引擎问、命令行要借自己那份配置问。
 *
 * 一条红线照旧：**验收宁严勿宽**。拿不准一律算没达成——目标卡上打了勾就必须是真的，
 * 否则这张卡就从「还差什么」退化成一个总是全绿的装饰品。
 */

const fs = require("fs");
const path = require("path");

/** 自动补跑的轮数上限。用满了不是悄悄停，是在卡上写清楚为什么停、还差几项（见 server.js / cli.js 的循环） */
const GOAL_MAX_ROUNDS = 3;

/** 摘录给验收员看的成果文件类型。二进制没法看开头，看了也判不出东西 */
const TEXT_EXT = /\.(html?|js|mjs|css|md|txt|json|py|ts|jsx|tsx|csv|svg)$/i;

function parseJsonLoose(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * @param {object} o
 * @param {() => string} o.workspaceDir 当前工作目录（服务端会被用户切换，所以传函数不传字符串）
 * @param {number} [o.maxRounds]
 */
function createGoalEngine({ workspaceDir, maxRounds = GOAL_MAX_ROUNDS } = {}) {
  const ws = typeof workspaceDir === "function" ? workspaceDir : () => String(workspaceDir || process.cwd());
  const dirOf = (sess) => (sess && sess.dir ? path.join(ws(), sess.dir) : "");

  /**
   * 这一轮该拿哪些文件当证据。
   *
   * 网页端每个对话有自己的成果文件夹（任务_月日_标题），扫那个文件夹就行。
   * 命令行没有这层文件夹——活儿直接落在工作目录里，那儿可能是一个几千文件的仓库，
   * 整个扫进去不是「证据更多」而是「拿别人早就写好的文件给这一轮打勾」。
   * 所以命令行把 agent 这一轮**真正写过**的文件名递进来（files 事件里的 changed），
   * 范围反而比扫文件夹更准。两条路都走同一套摘录和体检。
   */
  function pickNames(sess, names) {
    if (Array.isArray(names) && names.length) return { base: ws(), names: names.map(String) };
    const dir = dirOf(sess);
    if (!dir) return null;
    try { return { base: dir, names: fs.readdirSync(dir).filter((n) => !n.startsWith(".")) }; } catch { return { base: dir, names: null }; }
  }

  function fileInventory(sess, names) {
    try {
      const pick = pickNames(sess, names);
      if (!pick) return "（本对话还没有成果文件夹）";
      const dir = pick.base;
      if (!pick.names) return "（读取成果文件夹失败）";
      if (!pick.names.length) return "（这一轮没有产出文件）";
      return pick.names.slice(0, 40).map((n) => {
        try { const st = fs.statSync(path.join(dir, n)); return `${n}（${st.isDirectory() ? "目录" : st.size + " 字节"}）`; }
        catch { return n; }
      }).join("\n");
    } catch { return "（读取成果文件夹失败）"; }
  }

  /** 最近改动的成果文本文件（新→旧，最多 5 个），内容摘录和自动体检共用一份清单 */
  function recentFiles(sess, names) {
    try {
      const pick = pickNames(sess, names);
      if (!pick || !pick.names) return [];
      const dir = pick.base;
      return pick.names
        .filter((n) => !n.startsWith(".") && TEXT_EXT.test(n))
        .map((n) => {
          try { const st = fs.statSync(path.join(dir, n)); return st.isFile() ? { n, p: path.join(dir, n), mtime: st.mtimeMs, size: st.size } : null; }
          catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 5);
    } catch { return []; }
  }

  /** 摘录最近改动的成果文件开头给验收员：光看文件名判「能不能用」纯靠猜，
   *  看到内容开头至少能核对结构是不是真的（有没有画布/按键监听/两个角色…）。只读文本类文件，最多 5 个 */
  function fileSnippets(sess, names) {
    try {
      return recentFiles(sess, names).map((f) => {
        let head = "";
        try { head = fs.readFileSync(f.p, "utf8").slice(0, 600); } catch { head = "（读取失败）"; }
        return `--- ${f.n}（共 ${f.size} 字节，以下是开头）---\n${head}`;
      }).join("\n\n");
    } catch { return ""; }
  }

  /** 验收员的「动手」环节：对成果文件做机器实测——JS 语法（node --check）、JSON 能否解析、
   *  HTML 是否写完整（截断/标签不配对）。只做只读检查，绝不执行成果代码。
   *  桌面版里 process.execPath 是 Electron 二进制，必须 ELECTRON_RUN_AS_NODE 才是纯 node */
  function fileChecks(sess, names) {
    const { execFile } = require("child_process");
    const checkOne = (f) => new Promise((resolve) => {
      if (/\.(js|mjs|cjs)$/i.test(f.n)) {
        execFile(process.execPath, ["--check", f.p], { timeout: 8000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }, (err, _o, stderr) => {
          resolve(err ? `✗ ${f.n} JS 语法检查未通过：${String(stderr || err.message).slice(0, 200)}` : `✓ ${f.n} JS 语法检查通过`);
        });
      } else if (/\.json$/i.test(f.n)) {
        try { JSON.parse(fs.readFileSync(f.p, "utf8")); resolve(`✓ ${f.n} JSON 格式合法`); }
        catch (e) { resolve(`✗ ${f.n} JSON 解析失败：${String(e.message).slice(0, 120)}`); }
      } else if (/\.html?$/i.test(f.n)) {
        try {
          const t = fs.readFileSync(f.p, "utf8");
          const probs = [];
          if (/<html[\s>]/i.test(t) && !/<\/html>/i.test(t)) probs.push("有 <html> 没有 </html>，疑似写到一半被截断");
          const so = (t.match(/<script[\s>]/gi) || []).length, sc = (t.match(/<\/script>/gi) || []).length;
          if (so !== sc) probs.push(`<script> 开闭不配对（${so} 开 ${sc} 闭）`);
          resolve(probs.length ? `✗ ${f.n} 结构异常：${probs.join("；")}` : `✓ ${f.n} HTML 结构完整（html/script 标签配对）`);
        } catch { resolve(null); }
      } else resolve(null);
    });
    return Promise.all(recentFiles(sess, names).map(checkOne)).then((rs) => rs.filter(Boolean).join("\n")).catch(() => "");
  }

  /** 把目标拆成 3~6 条可验收标准。失败就用目标原文当唯一标准，绝不让任务卡在拆解上 */
  async function deriveCriteria(think, goalText, warn = () => {}) {
    try {
      const text = await think({
        system: '你是验收标准拆解器。把用户的目标拆成 3~6 条具体、可客观核验的验收标准（每条都能对着成果文件/事实判真假，不写"尽量""良好"这种没法验收的词）。只输出 JSON：{"criteria":["标准1","标准2"]}，不要其它任何文字。',
        prompt: String(goalText).slice(0, 2000),
        timeoutMs: 60000,
      });
      const j = parseJsonLoose(text);
      const list = (j && Array.isArray(j.criteria) ? j.criteria : []).map((c) => String(c).trim()).filter(Boolean).slice(0, 6);
      if (list.length) return list;
      warn("拆不出验收标准（它没按格式回 JSON），这轮先拿目标原文当唯一标准");
    } catch (e) {
      // 吞掉异常等于让用户对着一张「1 项、永远不打勾」的目标卡发呆——留痕，让他知道是哪一步没成
      warn("拆验收标准失败：" + String((e && e.message) || e).slice(0, 120) + "，先拿目标原文当唯一标准");
    }
    return [String(goalText).slice(0, 200)];
  }

  /** 新建一张目标卡。两个入口都从这儿建，卡的字段名才不会一边 criteria 一边 items */
  async function start(think, goalText, warn = () => {}) {
    let derailed = "";
    const criteria = await deriveCriteria(think, goalText, (w) => { derailed = w; warn(w); });
    const goal = { text: String(goalText).slice(0, 500), criteria: criteria.map((t) => ({ text: t, done: false })), status: "active", round: 0 };
    // 这一步歪了要写在卡上：否则用户只看到「1 项标准、就是我刚才那句话」，还以为 Goal 模式就长这样
    if (derailed) goal.note = derailed;
    return goal;
  }

  /** 对着验收标准验一轮。只认成果文件清单和收尾汇报，拿不准算 false；验收调用挂了就全部保持原状 */
  async function verify(think, sess, finalText, warn = () => {}, names = null) {
    const goal = sess.goal;
    const undone = goal.criteria.map((c, i) => ({ i, c })).filter((x) => !x.c.done);
    if (!undone.length) return;
    const snippets = fileSnippets(sess, names);
    const checks = await fileChecks(sess, names);
    try {
      const text = await think({
        system: '你是验收员。根据成果文件清单和执行汇报，逐条判断验收标准是否已达成。证据不足一律 false，宁可漏判不可错判。【自动体检】是机器实测结果（不是模型自述）：标 ✗ 的文件说明有语法错误或没写完整，涉及它的标准一律 false。只输出 JSON：{"results":[{"i":0,"done":true},{"i":1,"done":false}]}，i 是标准编号。',
        prompt:
          `【目标】${goal.text}\n\n【待验收标准】\n${undone.map((x) => `${x.i}. ${x.c.text}`).join("\n")}\n\n【成果文件清单】\n${fileInventory(sess, names)}\n\n` +
          (snippets ? `【成果文件内容摘录】\n${snippets}\n\n` : "") +
          (checks ? `【自动体检（机器实测）】\n${checks}\n\n` : "") +
          `【执行汇报】\n${String(finalText || "（无）").slice(0, 3000)}`,
        timeoutMs: 90000,
      });
      const j = parseJsonLoose(text);
      const results = j && Array.isArray(j.results) ? j.results : [];
      if (!results.length) warn("验收员没按格式回话，这一轮的打勾全部保持原状（宁可漏判不可错判）");
      for (const it of results) {
        const c = goal.criteria[it.i];
        if (c && it.done === true) c.done = true;
      }
    } catch (e) {
      // 静默失败最坑：目标卡一直 0/N，用户以为是活没干好，其实是验收这一步根本没跑通
      warn("验收没跑通：" + String((e && e.message) || e).slice(0, 120) + "，这一轮的打勾保持原状");
    }
    if (goal.criteria.every((c) => c.done)) goal.status = "done";
  }

  /** 注给 agent 的任务上下文：每一轮都对着验收标准干活，不跑偏 */
  function contextFor(goal) {
    if (!goal || goal.status !== "active") return "";
    return `\n\n## 本对话的目标（Goal 模式）\n目标：${goal.text}\n验收标准（打勾的已达成，别重做）：\n` +
      goal.criteria.map((c, i) => `${i + 1}. [${c.done ? "✓" : " "}] ${c.text}`).join("\n") +
      `\n交付物必须能通过未达成的验收标准。`;
  }

  /** 没达标时喂给下一轮的那句。只补未达成项，别让它把已经做好的又推倒重做 */
  function feedbackFor(goal) {
    const unmet = goal.criteria.filter((c) => !c.done).map((c) => "· " + c.text).join("\n");
    return `【目标验收 · 第 ${goal.round} 轮】以下验收标准还没达成：\n${unmet}\n只补这些未达成项，别重做已达成的部分。`;
  }

  /** 还差几项。目标卡和终端里那行 `2/4` 都用它，别两边各数各的 */
  function progress(goal) {
    const all = (goal && goal.criteria) || [];
    const done = all.filter((c) => c.done).length;
    return { done, total: all.length, unmet: all.length - done };
  }

  return {
    MAX_ROUNDS: maxRounds,
    start, deriveCriteria, verify, contextFor, feedbackFor, progress,
    fileInventory, fileSnippets, fileChecks, recentFiles,
  };
}

module.exports = { createGoalEngine, parseJsonLoose, GOAL_MAX_ROUNDS };
