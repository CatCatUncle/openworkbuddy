
// ================= 基础状态 =================
let sessionId = null;
let currentMode = "craft";
let settingsCache = null;
let projects = [];
let activeProject = "默认项目"; // 必须在任何 renderHistory() 调用前声明（初始化就会用到）
let currentUser = null; // 登录后由 initAuth() 填充
let assistant = { name: "OpenWorkBuddy", avatar: "🤖" }; // 助理的名字/头像，可在设置里改；登录后拉真值
let isReplaying = false; // 回放历史任务中：事件照走一遍渲染，但不许它去动"当前"的文件面板和预览
const runningSessions = new Map(); // sessionId -> { ui } 正在跑任务的会话（服务端锁按会话，跨会话可并行）
const sessionDirs = new Map(); // sessionId -> 该对话在默认工作空间下的成果子文件夹（成果面板标「本对话」）
const sessionModels = new Map(); // sessionId -> 该对话指定的模型名（没有 = 跟随全局默认）
const sessionGoals = new Map(); // sessionId -> 该对话的目标状态（Goal 模式的目标卡）
let pendingModel; // 新对话还没发首条消息就选了模型：先记着，会话建好后再落到服务端
const sessionQueues = new Map();   // sessionId -> [{text, mode}] 同一会话内追加的消息才排队
const curBusy = () => !!(sessionId && runningSessions.has(sessionId));
const qOf = (sid) => { let q = sessionQueues.get(sid); if (!q) { q = []; sessionQueues.set(sid, q); } return q; };
let SESS_KEY = "wb_sessions"; // 登录后切换为 wb_sessions:<用户名>（每人一份任务历史）
let sessions = JSON.parse(localStorage.getItem(SESS_KEY) || "[]");
const chatCol = document.getElementById("chat-col");
const chatScroll = document.getElementById("chat-scroll");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const mask = document.getElementById("modal-mask");
const modalBox = document.getElementById("modal-box");
const mTitle = document.getElementById("m-title");
const mBody = document.getElementById("m-body");

function saveSessions() { localStorage.setItem(SESS_KEY, JSON.stringify(sessions.slice(0, 50))); }
function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
/** 头像内容：传了图就是 <img>，emoji 就直接放字符，都没有就退回名字首字母。
 *  返回 {html, cls}——cls 要挂到外层那个圆/方块上（emoji 得换中性底色）。 */
function avatarBits(av, fallbackName) {
  const s = String(av || "").trim();
  if (s.startsWith("data:image/")) return { html: `<img class="ava-img" src="${esc(s)}" alt="">`, cls: "" };
  if (s) return { html: esc(s), cls: "emo" };
  return { html: esc(String(fallbackName || "?").trim().slice(0, 1).toUpperCase()), cls: "" };
}
function paintAvatar(el, av, fallbackName) {
  if (!el) return;
  const { html, cls } = avatarBits(av, fallbackName);
  el.innerHTML = html;
  el.classList.toggle("emo", cls === "emo");
}
/** 界面上该怎么称呼当前用户：昵称优先，没设就用登录名 */
function displayName(u) { return (u && (u.nickname || u.username)) || ""; }
/** 助理身份变了，把界面上所有露脸的地方一次性刷新（品牌位、侧栏、历史气泡头像） */
function applyAssistantIdentity() {
  document.title = assistant.name;
  document.querySelector(".brand .name").textContent = assistant.name;
  paintAvatar(document.querySelector(".brand .mark"), assistant.avatar, assistant.name);
  const abIc = document.getElementById("ab-ic");
  if (abIc) {
    const a = avatarBits(assistant.avatar, assistant.name);
    abIc.innerHTML = `<span class="ab-ava${a.cls ? " " + a.cls : ""}">${a.html}</span>`;
  }
  document.querySelectorAll(".a-msg .avatar").forEach(el => paintAvatar(el, assistant.avatar, assistant.name));
  const h1 = document.querySelector("#empty h1");
  if (h1) h1.textContent = `${assistant.name}, 我帮你`;
}
// 生成回复时用户往上翻，就不再往下拽（能安心看历史）；翻回底部附近才恢复跟随
let chatStick = true;
chatScroll.addEventListener("scroll", () => {
  chatStick = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 80;
  document.getElementById("to-bottom").classList.toggle("show", !chatStick);
});
let scrollRaf = 0;
function scrollBottom(force) {
  if (force) chatStick = true;
  if (!chatStick || scrollRaf) return;
  // 事件流密集时每个事件都设 scrollTop 会逐次强制布局；合并到每帧一次
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (chatStick) chatScroll.scrollTop = chatScroll.scrollHeight;
  });
}
document.getElementById("to-bottom").onclick = () => scrollBottom(true);

// ================= Markdown 渲染（先转义防注入） =================
// 模型偶尔输出「裸语言名 + 无围栏代码」（DeepSeek 常见）：识别后补成 ``` 围栏再走正常渲染
function repairBareCode(str) {
  const LANG = /^(text|plaintext|javascript|js|typescript|ts|python|py|bash|sh|shell|zsh|json|html|xml|svg|css|scss|sql|yaml|yml|java|go|rust|cpp|csharp|ruby|php|swift|kotlin|jsx|tsx|markdown|md)$/i;
  // 「像代码/命令/文件树/日志」的行（文本已 HTML 转义）：缩进、注释、树形符、路径、标记符号、常见命令与语法开头
  const CODE = /^(\s+\S|[│├└─┌┬┴┼]|\/[\w.]|\/\/|#|&lt;|&gt;|["']|\{|\}|\(|\)|\[|`|[■□▶◆●]|[-*]\s|\d+[.)]\s|(const|let|var|function|import|export|from|class|def|async|await|print|python3?|node|npm|npx|pnpm|pip3?|git|cd|ls|cat|curl|wget|brew|docker|ffmpeg|mkdir|cp|mv|echo|source|ssh|chmod)\s|return\b|if\s*\(|for\s*\(|while\s*\(|console\.|\$|[A-Za-z_$][\w$.]*\s*[=({:.]|-{2,})/;
  const lines = str.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = l.trim();
    if (LANG.test(t)) {
      // 语言名后允许隔 1-2 个空行再开始代码
      let j = i + 1, blanks = 0;
      while (j < lines.length && lines[j].trim() === "" && blanks < 2) { j++; blanks++; }
      if (j < lines.length && CODE.test(lines[j])) {
        const buf = [];
        while (j < lines.length) {
          const cur = lines[j];
          if (cur.trim() === "") {
            // 空行后若还是代码行则把空行收进块内，否则代码块到此结束
            let k = j + 1;
            while (k < lines.length && lines[k].trim() === "") k++;
            if (k < lines.length && CODE.test(lines[k])) { while (j < k) buf.push(lines[j++]); continue; }
            break;
          }
          if (!CODE.test(cur)) break;
          buf.push(cur); j++;
        }
        if (buf.length >= 1) {
          out.push("```" + t.toLowerCase(), ...buf, "```");
          i = j - 1;
          continue;
        }
      }
    }
    out.push(l);
  }
  return out.join("\n");
}

function renderMd(src) {
  if (!src) return "";
  // 先把正文里的 <svg> 抠出来换成占位符（在 esc 之前——它们要当图渲染，不能被转义成文字）
  const { text: pre, figs } = SvgFig.extractSvgFigures(src);
  let s = esc(pre);
  const codeBlocks = [];
  const pushCode = (lang, code) => {
    codeBlocks.push(`<div class="code-wrap"><div class="code-head"><span>${esc(lang || "")}</span><a class="code-copy" title="复制代码">复制</a></div><pre><code>${code.replace(/\n$/, "")}</code></pre></div>`);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  };
  const extract = (str) => str.replace(/```(\w*)[^\S\n]*\n?([\s\S]*?)```/g, (_, lang, code) => pushCode(lang, code));
  s = extract(s);
  s = repairBareCode(s);
  s = extract(s);
  // 未闭合围栏（流式输出中 / 模型忘了闭合）：从 ``` 到文末也按代码块渲染
  s = s.replace(/(^|\n)```(\w*)[^\S\n]*\n?([\s\S]*)$/, (_, pre, lang, code) => pre + pushCode(lang, code));
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = s.split("\n");
  const out = [];
  let listType = null, inQuote = false, para = [], tableRows = null;
  const flushPara = () => { if (para.length) { out.push("<p>" + para.join("<br>") + "</p>"); para = []; } };
  const closeList = () => { if (listType) { out.push(listType === "ul" ? "</ul>" : "</ol>"); listType = null; } };
  const closeQuote = () => { if (inQuote) { out.push("</blockquote>"); inQuote = false; } };
  const closeTable = () => {
    if (!tableRows) return;
    const [head, ...rest] = tableRows;
    out.push('<div class="md-table-wrap"><table><thead><tr>' + head.map(c => `<th>${c}</th>`).join("") + "</tr></thead><tbody>"
      + rest.map(r => "<tr>" + r.map(c => `<td>${c}</td>`).join("") + "</tr>").join("") + "</tbody></table></div>");
    tableRows = null;
  };
  for (let raw of lines) {
    const line = raw.replace(/\s+$/, "");
    let m;
    // 表格：| a | b | 行；分隔行 |---|---| 跳过
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      if (cells.every(c => /^:?-{3,}:?$/.test(c))) continue;
      flushPara(); closeList(); closeQuote();
      (tableRows = tableRows || []).push(cells);
      continue;
    }
    closeTable();
    // 代码块／SVG 占位符独立成块，不并进段落（<div> 不能进 <p>）
    if (/^\s*\x00(?:CODE|SVG)\d+\x00\s*$/.test(line)) {
      flushPara(); closeList(); closeQuote();
      out.push(line.trim());
      continue;
    }
    if ((m = line.match(/^(?:&gt;)\s?(.*)$/))) {
      flushPara(); closeList();
      if (!inQuote) { out.push("<blockquote>"); inQuote = true; }
      out.push("<p>" + (m[1] || "") + "</p>");
      continue;
    }
    closeQuote();
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara(); closeList();
      out.push(`<h${m[1].length}>${m[2]}</h${m[1].length}>`);
    } else if (/^(-{3,}|\*{3,})$/.test(line)) {
      flushPara(); closeList(); out.push("<hr>");
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara();
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push("<li>" + m[1] + "</li>");
    } else if ((m = line.match(/^\s*\d+[.、]\s+(.*)$/))) {
      flushPara();
      if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
      out.push("<li>" + m[1] + "</li>");
    } else if (line.trim() === "") {
      flushPara(); closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara(); closeList(); closeQuote(); closeTable();
  return out
    .join("\n")
    .replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[+i])
    .replace(/\x00SVG(\d+)\x00/g, (_, i) => figs[+i]);
}

// ================= 回合渲染（实时流式与历史回放共用） =================
function createTurnUI(userText, turnMode, forSid) {
  const turnSid = forSid !== undefined ? forSid : sessionId; // 本回合归属的会话：后台任务的事件不许影响用户已切走的界面
  const turn = document.createElement("div");
  turn.className = "turn";
  const av = avatarBits(assistant.avatar, assistant.name);
  turn.innerHTML = `<div class="u-msg"><button class="u-copy" title="复制我的输入">⧉</button><div class="bubble"></div></div>
    <div class="a-msg"><div class="avatar${av.cls ? " " + av.cls : ""}">${av.html}</div><div class="body"></div></div>`;
  // 「（已上传文件：×××）」是给模型看的附件标记，气泡里渲染成附件行，别按原文糊用户脸上（老会话的旧格式一并美化）
  const attNames = [];
  const bodyText = userText.replace(/（已上传文件：([^）]+)）/g, (_, names) => {
    for (const n of String(names).split("、")) if (n.trim()) attNames.push(n.trim());
    return "";
  }).trim();
  let bubbleHtml = hlTokens(bodyText, "tk-b");
  if (attNames.length) bubbleHtml += `<div class="bubble-attach">${attNames.map(n => `<span>📎 ${esc(n)}</span>`).join("")}</div>`;
  turn.querySelector(".bubble").innerHTML = bubbleHtml;
  turn.querySelector(".u-copy").onclick = (e) => {
    navigator.clipboard?.writeText(userText).then(() => {
      e.target.textContent = "✓"; setTimeout(() => { e.target.textContent = "⧉"; }, 1200);
    }).catch(() => toast("❌ 复制失败"));
  };
  // 只有"正在看的会话"的回合才上屏；后台会话的回合先游离着更新，切回来时再接上
  if (turnSid === sessionId) {
    document.getElementById("empty")?.remove();
    chatCol.appendChild(turn);
  }
  // 新回合出现后，旧回合的「重新生成」按钮全部撤掉（只允许重生成最后一轮）
  chatCol.querySelectorAll(".turn-actions [data-a=regen]").forEach(b => { if (!turn.contains(b)) b.remove(); });
  const body = turn.querySelector(".body");
  turn._userText = userText;
  turn._mode = turnMode;
  let currentText = null;

  // 执行过程折叠区（仿官方「已完成 12s ›」）：过程卡片都收进去，正文文本在外面
  let procWrap = null, procBody = null, procTimer = null;
  const t0 = Date.now();
  // 长跑徽章：步数/续跑轮次/产出件数实时挂在「运行中」计时旁，长任务不再只有一个转圈
  let liveStep = 0, liveRound = 0, liveRoundTotal = 0, liveOuts = 0;
  const liveBadge = () => (liveStep ? ` · 第 ${liveStep} 步` : "") + (liveRound ? ` · 续跑 ${liveRound}/${liveRoundTotal} 轮` : "") + (liveOuts ? ` · 产出 ${liveOuts} 件` : "");
  const fmtDur = (ms) => { const s = Math.max(1, Math.round(ms / 1000)); return s < 60 ? s + "s" : Math.floor(s / 60) + "m" + (s % 60) + "s"; };
  const ensureProc = () => {
    if (!procBody) {
      procWrap = document.createElement("div");
      procWrap.className = "proc-wrap open";
      procWrap.innerHTML = `<div class="proc-head"><span class="spinner"></span><span class="pt">运行中…</span><span class="arrow">›</span></div><div class="proc-body"></div>`;
      procBody = procWrap.querySelector(".proc-body");
      procWrap.querySelector(".proc-head").onclick = () => procWrap.classList.toggle("open");
      // 追加（不是 prepend）：开场白留在折叠区上方可见，仿官方「先说在做什么 → 过程收起 → 结论在外」
      body.appendChild(procWrap);
      procTimer = setInterval(() => {
        const pt = procWrap.querySelector(".pt");
        if (pt) pt.textContent = `运行中 ${fmtDur(Date.now() - t0)}` + liveBadge();
      }, 1000);
    }
    return procBody;
  };

  const ensureText = () => {
    if (!currentText) {
      currentText = document.createElement("div");
      currentText.className = "a-text";
      currentText._raw = "";
      // 过程区一旦出现，后续文字都算"过程叙述"进折叠区；finish() 会把最后一段（最终结论）提出来
      (procBody || body).appendChild(currentText);
    }
    return currentText;
  };
  const appendText = (delta) => {
    const el = ensureText();
    el._raw += delta;
    // 流式回复不逐字重排版：每 100ms 渲一次全文。长回复从 O(n²) 次 Markdown 重解析
    // 降到每秒 10 次，打字机效果看不出差别，但滚动和输入不再卡
    if (el._pend) return;
    el._pend = true;
    setTimeout(() => {
      el._pend = false;
      el.innerHTML = renderMd(el._raw);
      if (turnSid === sessionId) scrollBottom(); // 后台并行会话的增量不许滚动当前看的对话
    }, 100);
  };

  function handleEvent(ev) {
    if (ev.type === "step_start") {
      if (ev.depth > 0) return;
      liveStep = ev.step || liveStep;
      body.querySelector(".thinking-hint")?.remove();
      const hint = document.createElement("div");
      hint.className = "thinking-hint";
      hint.style.cssText = "font-size: 13px;color:var(--wb-text-3);margin:6px 0;display:flex;align-items:center;gap:6px";
      hint.innerHTML = `<span class="spinner"></span> 第 ${ev.step} 步 · 思考规划中…`;
      // 首步的提示放正文（此时还没有过程区，别为它建一个）；后续步的提示进过程区
      (procBody || body).appendChild(hint);
      currentText = null;
    } else if (ev.type === "status") {
      // 运行状态直播（重试中/模型长时间没输出）：复用思考提示那一行，别让界面看起来像卡死
      let hint = body.querySelector(".thinking-hint");
      if (!hint) {
        hint = document.createElement("div");
        hint.className = "thinking-hint";
        hint.style.cssText = "font-size: 13px;color:var(--wb-text-3);margin:6px 0;display:flex;align-items:center;gap:6px";
        (procBody || body).appendChild(hint);
      }
      hint.innerHTML = `<span class="spinner"></span> ${esc(ev.text || "")}`;
    } else if (ev.type === "text") {
      if (ev.depth > 0) return;
      body.querySelector(".thinking-hint")?.remove();
      appendText(ev.delta);
    } else if (ev.type === "expert_start") {
      currentText = null;
      const banner = document.createElement("div");
      banner.className = "step-card";
      banner.innerHTML = `<div class="head"><span class="tag">👥 ${esc(ev.expert)}</span><span class="desc">专家接手子任务：${esc((ev.task || "").slice(0, 60))}</span></div>`;
      ensureProc().appendChild(banner);
    } else if (ev.type === "parallel") {
      // 这一批全是只读工具，同时开跑。说一句，免得用户看到好几张卡一起转以为卡住了
      const note = document.createElement("div");
      note.style.cssText = "font-size: 13px;color:var(--wb-text-3);margin:6px 0";
      note.textContent = `⚡ ${ev.count} 个只读工具并发执行（搜索/抓页面互不影响，一起跑更快）`;
      ensureProc().appendChild(note);
    } else if (ev.type === "tool_use") {
      body.querySelector(".thinking-hint")?.remove();
      currentText = null;
      const card = document.createElement("div");
      card.className = "step-card";
      const who = ev.expert ? `${esc(ev.expert)} · ` : "";
      card.innerHTML =
        `<div class="head"><span class="tag">⚙ ${who}${esc(ev.name)}</span>` +
        `<span class="desc">${esc(ev.purpose || "")}</span><span class="spinner"></span></div>` +
        `<pre>${esc(ev.input_preview || "")}</pre>`;
      card.querySelector(".head").onclick = () => card.classList.toggle("open");
      ensureProc().appendChild(card);
      // 未完成卡片入栈；专家的内层工具卡与协调者的委派卡按 depth 区分，防止张冠李戴
      card._depth = ev.depth || 0;
      card._tid = ev.id || "";
      (body._openCards = body._openCards || []).push(card);
    } else if (ev.type === "tool_result") {
      const stack = body._openCards || [];
      let card = null;
      // 只读工具是并发跑的，谁先回来不一定——认调用 id 才不会把 A 的结果贴到 B 的卡上
      if (ev.id) {
        const i = stack.findIndex((c) => c._tid === ev.id);
        if (i >= 0) card = stack.splice(i, 1)[0];
      }
      if (!card) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i]._depth === (ev.depth || 0)) { card = stack.splice(i, 1)[0]; break; }
        }
      }
      if (!card) card = stack.pop();
      if (card) {
        card.querySelector(".spinner")?.remove();
        const tag = document.createElement("span");
        tag.className = "tag " + (ev.isError ? "err" : "ok");
        tag.textContent = ev.isError ? "失败" : "完成";
        card.querySelector(".head").appendChild(tag);
        card.querySelector("pre").textContent += "\n\n── 执行结果 ──\n" + (ev.preview || "");
        if (ev.isError) card.classList.add("open");
      }
    } else if (ev.type === "limit") {
      currentText = null;
      const note = document.createElement("div");
      note.style.cssText = "font-size: 13px;color:var(--wb-err);margin:6px 0";
      note.textContent = `⏱ ${ev.note || "已达执行上限"}，任务强制收尾`;
      ensureProc().appendChild(note);
      procWrap?.classList.add("open");
      turn._limited = true;
    } else if (ev.type === "auto_continue") {
      currentText = null;
      liveRound = ev.round || 0; liveRoundTotal = ev.total || 0;
      const note = document.createElement("div");
      note.style.cssText = "font-size: 13px;color:var(--wb-text-3);margin:6px 0";
      note.textContent = `🔁 ${ev.note || "已达执行上限"}，任务未完，自动续跑第 ${ev.round}/${ev.total} 轮（按进度接着做，不重跑）`;
      ensureProc().appendChild(note);
      procWrap?.classList.add("open");
    } else if (ev.type === "sleep") {
      // 本机睡了一觉又醒了：任务时限已顺延，跟用户说一声免得对不上「怎么跑了这么久」
      currentText = null;
      const note = document.createElement("div");
      note.style.cssText = "font-size: 13px;color:var(--wb-text-3);margin:6px 0";
      note.textContent = `\u{1F4A4} ${ev.note || "检测到本机睡眠，任务时限已顺延"}`;
      ensureProc().appendChild(note);
    } else if (ev.type === "failover") {
      // 主模型挂起/持续报错、自动切到备用渠道——必须大声播报，绝不静默换模型
      currentText = null;
      const note = document.createElement("div");
      note.style.cssText = "font-size: 13px;color:var(--wb-err);margin:6px 0";
      note.textContent = `🔀 ${ev.note || "已切换到备用渠道"}`;
      ensureProc().appendChild(note);
      procWrap?.classList.add("open");
    } else if (ev.type === "trim") {
      // 历史太长，较早的工具原文被截短了。一条任务只留一行提示，累计数字滚动更新
      const proc = ensureProc();
      let note = proc.querySelector(".trim-note");
      if (!note) {
        note = document.createElement("div");
        note.className = "trim-note";
        note.style.cssText = "font-size: 13px;color:var(--wb-text-3);margin:6px 0";
        proc.appendChild(note);
      }
      note.textContent = `✂️ 历史过长，已截短较早的工具输出（约 ${Math.round((ev.chars || 0) / 1000)} 千字符），最近几步保留原文。可在 设置→智能体设置 调大上下文预算`;
    } else if (ev.type === "compact") {
      // 会话超长时后端自动把早期轮次压成一条摘要，这里留一行告知，免得用户觉得"它忘了前面"
      const proc = ensureProc();
      const note = document.createElement("div");
      note.style.cssText = "font-size: 13px;color:var(--wb-text-3);margin:6px 0";
      note.textContent = `🗜️ 会话较长，已把早前 ${ev.removed || 0} 条消息压缩成一条摘要（要点保留，原文在 data/compact-archive 有归档）`;
      proc.appendChild(note);
    } else if (ev.type === "usage") {
      // 插队会触发多轮 runTask、发多个 usage 事件 → 累加而不是覆盖
      if (!turn._usage) turn._usage = { ...ev };
      else {
        turn._usage.prompt += ev.prompt || 0;
        turn._usage.completion += ev.completion || 0;
        turn._usage.calls += ev.calls || 0;
        turn._usage.elapsed_ms += ev.elapsed_ms || 0;
      }
    } else if (ev.type === "dir") {
      // 本对话的成果子文件夹（只发直播不进回放；回放/续接场景由 /api/session 的 dir 字段补上）
      if (ev.dir && sessionDirs.get(turnSid) !== ev.dir) {
        sessionDirs.set(turnSid, ev.dir);
        openDirs.add(ev.dir); // 第一次知道就默认展开；用户手动折叠后不再打扰
        if (turnSid === sessionId) renderFiles(filesCache);
      }
    } else if (ev.type === "goal") {
      // 目标卡状态直播（拆解完成/每轮验收后各推一次）；不进回放记录，回放由 /api/session 的 goal 字段补上
      if (ev.goal) {
        sessionGoals.set(turnSid, ev.goal);
        if (turnSid === sessionId) renderGoalCard();
      }
    } else if (ev.type === "title") {
      // 服务端给首轮任务起的短标题（截断标题太丑）；不进 transcript，回放不经过这里
      const s = sessions.find((x) => x.id === turnSid);
      if (s && ev.title) { s.title = ev.title; saveSessions(); renderHistory(); }
      if (turnSid === sessionId && ev.title) document.getElementById("session-title").textContent = ev.title;
    } else if (ev.type === "interject") {
      currentText = null;
      // 插队时前端已经放了「等待注入」占位（服务端按 FIFO 注入，转正最早那个就是它）
      const pend = body.querySelector(".interject-note.pending");
      if (pend) {
        pend.classList.remove("pending");
        pend.querySelector(".lb").textContent = "⚡ 插队补充";
      } else {
        const note = document.createElement("div");
        note.className = "interject-note";
        note.innerHTML = `<div class="lb">⚡ 插队补充</div>${esc(ev.text || "")}`;
        body.appendChild(note);
      }
    } else if (ev.type === "ask_user") {
      currentText = null;
      const card = document.createElement("div");
      card.className = "ask-card";
      card.dataset.askId = ev.ask_id;
      card.innerHTML = `<div class="lb">🙋 AI 拿不准，来问你${ev.expert ? `（专家「${esc(ev.expert)}」在问）` : ""}</div>
        <div class="q">${esc(ev.question || "")}</div><div class="opts"></div>
        <div class="free"><input type="text" placeholder="或者自己输入…" maxlength="500"><button type="button">回答</button></div>
        <div class="ans" style="display:none"></div>`;
      const markAnswered = (text, timeout) => {
        card.classList.add("done");
        const ans = card.querySelector(".ans");
        ans.style.display = "";
        ans.textContent = timeout ? "⏰ 没等到回答，AI 按最合理的默认继续了" : "✅ 你的回答：" + (text || "");
      };
      card._mark = markAnswered;
      const answerIt = async (text) => {
        text = String(text || "").trim();
        if (!text || card.classList.contains("done")) return;
        const resp = await fetch("/api/chat/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: turnSid, askId: ev.ask_id, answer: text }),
        }).catch(() => null);
        if (resp && resp.ok) markAnswered(text);
        else {
          const j = resp ? await resp.json().catch(() => null) : null;
          toast((j && j.error) || "没送出去：任务可能已经结束");
        }
      };
      const optsBox = card.querySelector(".opts");
      for (const o of ev.options || []) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = o;
        b.onclick = () => answerIt(o);
        optsBox.appendChild(b);
      }
      const inp = card.querySelector(".free input");
      card.querySelector(".free button").onclick = () => answerIt(inp.value);
      inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); answerIt(inp.value); } };
      if (isReplaying) card.classList.add("done"); // 历史回放里问题早就过期了，别让人白点
      body.appendChild(card);
    } else if (ev.type === "ask_answer") {
      const card = body.querySelector(`.ask-card[data-ask-id="${cssEsc(ev.ask_id || "")}"]`);
      if (card && card._mark) card._mark(ev.answer, ev.timeout);
      else if (card) card.classList.add("done");
    } else if (ev.type === "credits") {
      turn._credits = ev; // 结束时由操作条展示「扣 X 积分 · 余额 Y」
      if (currentUser) { currentUser.credits = ev.balance; renderUserChip(); }
    } else if (ev.type === "files") {
      // ev.changed 是服务端在任务开头打的快照上算出来的，历史回放也还原得出来；
      // 老版本存下来的记录里没有这个字段，退回本地 mtime 差异
      const turnOut = ev.changed
        ? (ev.files || []).filter(f => ev.changed.includes(f.name))
        : changedFiles(ev.files);
      liveOuts += turnOut.length;
      renderTurnOutputs(body, turnOut); // 先算差异，autoPreviewNewHtml 里才会推进快照
      // 回放历史任务时这些是当时的文件列表：拿它去刷右侧面板会把现在的状态盖成旧的，
      // 自动预览更会莫名其妙弹出一个几天前的文件。产出卡片照摆，其余一律不动。
      if (!isReplaying) {
        renderFiles(ev.files);
        // 这一回合真产出了东西才自动预览、才把文件面板弹出来。
        // 工作目录里本来就躺着一堆旧文件，拿"目录非空"当理由每次聊天都弹一次，
        // 只是白白挤掉聊天区——用户明确反馈过。
        // 另外：用户已经切到别的会话时，这个后台回合只推进快照，不许弹面板抢镜
        if (turnSid !== sessionId) { snapshotFiles(ev.files); return; }
        if (turnOut.length) {
          autoPreviewNewHtml(ev.files, turnOut);
          if (pvPanel.classList.contains("show")) {
            document.getElementById("files-panel").classList.remove("show"); // 预览占了位就别再挤
          } else {
            document.getElementById("files-panel").classList.add("show");
          }
        } else {
          snapshotFiles(ev.files); // 没产出也要把基线推进，免得下一轮把旧文件误当成新的
        }
      }
    } else if (ev.type === "sources") {
      renderSources(body, ev.items || []);
    } else if (ev.type === "milestones") {
      // 里程碑时间线：agent 每更新一次 PROGRESS.md，这张卡就在过程区原地刷新打勾状态
      const proc = ensureProc();
      let card = proc.querySelector(".ms-card");
      if (!card) {
        card = document.createElement("div");
        card.className = "ms-card";
        proc.appendChild(card);
      }
      const items = ev.items || [];
      const doneN = items.filter((i) => i.done).length;
      card.innerHTML = `<div class="ms-head">📍 里程碑 ${doneN}/${items.length}${ev.file ? ` <span class="ms-file">${esc(ev.file)}</span>` : ""}</div>` +
        items.map((i) => `<div class="ms-item${i.done ? " done" : ""}">${i.done ? "✅" : "⬜"} ${esc(String(i.text || ""))}</div>`).join("");
    } else if (ev.type === "error") {
      currentText = null;
      const t = document.createElement("div");
      t.className = "a-text";
      t.style.color = "var(--wb-err)";
      t.textContent = "出错了：" + (ev.message || "");
      body.appendChild(t); // 错误必须留在正文可见，不进折叠区
    }
    if (turnSid === sessionId) scrollBottom(); // 已切走的会话在后台跑，别拽当前视图的滚动条
  }

  function finish() {
    body.querySelector(".thinking-hint")?.remove();
    // 回合结束后不允许再有任何转圈（含未收到结果的工具卡，统一标记中止）
    turn.querySelectorAll(".step-card .spinner").forEach(s => {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "中止";
      s.closest(".head")?.appendChild(tag);
      s.remove();
    });
    turn.querySelectorAll(".spinner").forEach(s => s.remove());
    // 过程折叠区收尾：停计时、写「已完成 Xs」、默认折叠（出错/被截断则保持展开）
    if (procTimer) { clearInterval(procTimer); procTimer = null; }
    if (procWrap) {
      // 最后一段正文是最终结论 → 提出折叠区保持可见（开场白在上、结论在下、过程收起）
      const texts = procBody.querySelectorAll(":scope > .a-text");
      if (texts.length) body.appendChild(texts[texts.length - 1]);
      if (!procBody.childElementCount) {
        procWrap.remove();
      } else {
        const ms = (turn._usage && turn._usage.elapsed_ms) || Date.now() - t0;
        const n = procBody.querySelectorAll(".step-card").length;
        procWrap.querySelector(".pt").textContent = `已完成 ${fmtDur(ms)}` + (n ? ` · ${n} 步` : "") + (liveRound ? ` · 续跑 ${liveRound} 轮` : "") + (liveOuts ? ` · 产出 ${liveOuts} 件` : "");
        const hasErr = !!procBody.querySelector(".tag.err") || turn._limited;
        if (!hasErr) procWrap.classList.remove("open");
      }
    }
    // 来源、产出卡片都是回合的结论物，挪到最后——否则会卡在中途正文和最终结论之间
    const srcBlock = body.querySelector(":scope > .src-block");
    if (srcBlock) body.appendChild(srcBlock);
    const outBlock = body.querySelector(":scope > .out-block");
    if (outBlock) body.appendChild(outBlock);
    addActionsBar();
    if (turnMode === "plan") renderPlanChecklist();
  }

  // 官方式回复操作条：复制 / 👍👎 / 重新生成 + 共消耗 tokens · 模型
  function addActionsBar() {
    if (turn.querySelector(".turn-actions")) return;
    const bar = document.createElement("div");
    bar.className = "turn-actions";
    bar.innerHTML =
      `<button class="ta-btn" data-a="copy" title="复制回复">⧉</button>` +
      `<button class="ta-btn" data-a="up" title="有帮助">👍</button>` +
      `<button class="ta-btn" data-a="down" title="没帮助">👎</button>` +
      `<button class="ta-btn" data-a="regen" title="重新生成">↻ 重新生成</button>` +
      `<span class="ta-meta"></span>`;
    const u = turn._usage;
    const meta = bar.querySelector(".ta-meta");
    if (u && (u.prompt || u.completion)) {
      meta.textContent = `共消耗 ✧ ${(u.prompt + u.completion).toLocaleString()} tokens · ${u.provider || ""}（${u.model || ""}）`;
      meta.title = `输入 ${u.prompt.toLocaleString()} + 输出 ${u.completion.toLocaleString()} tokens · ${u.calls} 次模型调用`;
    } else if (u) {
      meta.textContent = `${u.provider || ""}（${u.model || ""}）`;
    }
    if (turn._credits) {
      meta.textContent += `${meta.textContent ? " · " : ""}扣 ${turn._credits.spent} 积分（余 ${(+turn._credits.balance).toLocaleString()}）`;
    }
    bar.querySelector("[data-a=copy]").onclick = async (e) => {
      // 复制"渲染后"的内容而不是 markdown 源码：贴到飞书/Word 里保留格式，
      // 贴到纯文本框里也不会出现 **、<br> 这类原始标记
      const parts = [...body.querySelectorAll(".a-text")].map(t => {
        const c = t.cloneNode(true);
        c.querySelectorAll(".code-head").forEach(h => { // 代码块的「复制」小工具条不进剪贴板
          const lang = h.querySelector("span")?.textContent || "";
          h.replaceWith(Object.assign(document.createElement("div"), { textContent: lang, style: "font-size:12px;color:#888" }));
        });
        return c;
      });
      const html = parts.map(c => c.innerHTML).join("<br>");
      // innerText 需要元素在文档里才有正确换行，挂到屏外拿完就删
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:-99999px;top:0;width:600px";
      parts.forEach(c => probe.appendChild(c));
      document.body.appendChild(probe);
      const plain = parts.map(c => c.innerText.trim()).filter(Boolean).join("\n\n");
      probe.remove();
      const done = () => { e.target.textContent = "✓"; setTimeout(() => { e.target.textContent = "⧉"; }, 1200); };
      try {
        if (navigator.clipboard && window.ClipboardItem) {
          await navigator.clipboard.write([new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([plain], { type: "text/plain" }),
          })]);
          return done();
        }
      } catch {}
      navigator.clipboard?.writeText(plain).then(done).catch(() => toast("❌ 复制失败"));
    };
    bar.querySelector("[data-a=up]").onclick = (e) => {
      e.target.classList.toggle("on"); bar.querySelector("[data-a=down]").classList.remove("on");
    };
    bar.querySelector("[data-a=down]").onclick = (e) => {
      e.target.classList.toggle("on"); bar.querySelector("[data-a=up]").classList.remove("on");
    };
    bar.querySelector("[data-a=regen]").onclick = () => {
      if (curBusy()) return;
      const text = turn._userText, mode = turn._mode;
      turn.remove();
      doSend(text, mode, true);
    };
    body.appendChild(bar);
  }

  // Plan 模式：把执行计划解析成任务列表卡片
  function renderPlanChecklist() {
    const texts = body.querySelectorAll(".a-text");
    const raw = texts.length ? texts[texts.length - 1]._raw || "" : "";
    let steps = [...raw.matchAll(/^\s*\d+[.、)]\s+(.+)$/gm)].map(m => m[1]);
    if (steps.length < 2) steps = [...raw.matchAll(/^\s*[-*]\s+(.+)$/gm)].map(m => m[1]);
    steps = steps.map(s => s.replace(/\*\*/g, "").trim()).filter(s => s.length > 2).slice(0, 20);
    if (steps.length < 2) return;
    const card = document.createElement("div");
    card.className = "plan-list";
    card.innerHTML = `<div class="pl-head">📋 计划任务列表（${steps.length} 步）</div>`
      + steps.map(s => `<label class="pl-item"><input type="checkbox"> <span>${esc(s)}</span></label>`).join("")
      + `<button class="pl-run">▶ 切换 Craft 按此计划执行</button>`;
    card.querySelector(".pl-run").onclick = () => {
      setMode("craft");
      inputEl.value = "请严格按照以下计划执行，每完成一步简要汇报：\n" + steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
      syncInputHl();
      inputEl.focus();
      scrollBottom(true);
    };
    body.appendChild(card);
    if (turnSid === sessionId) scrollBottom();
  }
  /** 插队请求已被服务端受理但还没到注入间隙：先在对话里放个占位，用户立刻看得到自己说了什么 */
  function markPendingInterject(text) {
    const note = document.createElement("div");
    note.className = "interject-note pending";
    note.innerHTML = `<div class="lb">⚡ 已插队 · 等当前步骤结束后注入</div>${esc(text)}`;
    body.appendChild(note);
    if (turnSid === sessionId) scrollBottom();
  }
  const stats = () => ({
    dur: fmtDur((turn._usage && turn._usage.elapsed_ms) || Date.now() - t0),
    steps: turn.querySelectorAll(".step-card").length,
    rounds: liveRound,
    outs: liveOuts,
  });
  return { handleEvent, finish, turn, sid: turnSid, markPendingInterject, stats };
}

// ================= 空状态（场景 tab + 分类胶囊，仿官方首页） =================
const SCENES = {
  "日常办公": ["📄 文档处理", "📊 数据分析及可视化", "🔍 深度研究", "📽 幻灯片制作", "🗓 周报总结", "💹 金融服务"],
  "代码开发": ["💻 日常开发", "🌐 网站开发", "🤖 Agent 应用", "🛠 Skill 开发", "📚 技术文档"],
  "设计创意": ["🖥 网站设计", "📽 PPT设计", "🎨 视觉海报", "📱 移动端App", "🧩 设计系统", "🌐 Web App"],
};
let sceneTag = null; // 选中的任务类型标签
function setSceneTag(label) {
  sceneTag = label;
  const box = document.getElementById("scene-tag-box");
  box.innerHTML = label ? `<span class="scene-tag">${esc(label)} <b onclick="setSceneTag(null)">✕</b></span>` : "";
  inputEl.focus();
}
function buildEmpty() {
  const tpl = document.createElement("div");
  tpl.className = "empty"; tpl.id = "empty";
  tpl.innerHTML = `<h1>${esc(assistant.name)}, 我帮你</h1>
    <div class="scene-tabs">${Object.keys(SCENES).map((k, i) =>
      `<button class="${i === 0 ? "active" : ""}" data-scene="${k}">${["⏱","💻","🎨"][i]} ${k}</button>`).join("")}</div>
    <div class="chips" id="scene-chips"></div>`;
  const chipsEl = tpl.querySelector("#scene-chips");
  const renderChips = (scene) => {
    chipsEl.innerHTML = SCENES[scene].map(c => `<button>${c}</button>`).join("");
  };
  renderChips("日常办公");
  tpl.querySelector(".scene-tabs").addEventListener("click", (e) => {
    if (e.target.tagName !== "BUTTON") return;
    tpl.querySelectorAll(".scene-tabs button").forEach(b => b.classList.toggle("active", b === e.target));
    renderChips(e.target.dataset.scene);
  });
  chipsEl.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) setSceneTag(b.textContent.trim());
  });
  return tpl;
}
chatCol.appendChild(buildEmpty());

// ================= @ 引用文件 / 调用技能 自动补全 =================
let filesCache = [], skillsCache = [];
fetch("/api/skills").then(r => r.json()).then(l => skillsCache = l).catch(() => {});
const mentionMenu = document.getElementById("mention-menu");
let mentionState = null; // {trigger:'@'|'/', start, query}

function detectMention() {
  const pos = inputEl.selectionStart;
  const before = inputEl.value.slice(0, pos);
  const m = before.match(/(?:^|[\s（(])([@/])([^\s@/]*)$/);
  if (!m) { mentionState = null; mentionMenu.classList.remove("show"); return; }
  mentionState = { trigger: m[1], query: m[2], start: pos - m[2].length - 1 };
  if (m[1] === "@") refreshFilesCache();
  renderMentionMenu();
}
let filesFetchAt = 0;
function refreshFilesCache() {
  if (Date.now() - filesFetchAt < 3000) return; // 3 秒内不重复拉
  filesFetchAt = Date.now();
  fetch("/api/files").then(r => r.json()).then(f => {
    filesCache = f || [];
    if (mentionState && mentionState.trigger === "@") renderMentionMenu();
  }).catch(() => {});
}
function renderMentionMenu() {
  const { trigger, query } = mentionState;
  let items = [];
  if (trigger === "@") {
    items = filesCache.filter(f => f.name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 12).map(f => ({ label: `${fileIcon(f.name)} ${f.name}`, insert: "@" + f.name, sub: "工作空间文件" }));
    if (!items.length) items = [{ label: "（工作空间还没有文件，可点 ＋ 上传）", insert: null }];
  } else {
    items = skillsCache.filter(s => s.name.toLowerCase().includes(query.toLowerCase()) || s.description.includes(query))
      .slice(0, 12).map(s => ({ label: "📦 /" + s.name, insert: "/" + s.name, sub: s.description }));
    if (!items.length) items = [{ label: "（没有匹配的技能）", insert: null }];
  }
  mentionMenu.innerHTML = `<div class="mh">${trigger === "@" ? "引用工作空间文件" : "调用技能"}</div>` +
    items.map((it, i) => `<div class="mi ${i === 0 && it.insert ? "sel" : ""}" data-insert="${esc(it.insert || "")}">${it.label}${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ""}</div>`).join("");
  mentionMenu.classList.add("show");
  mentionMenu.querySelectorAll(".mi").forEach(mi => mi.onclick = () => applyMention(mi.dataset.insert));
}
function applyMention(insert) {
  if (!insert || !mentionState) { mentionMenu.classList.remove("show"); return; }
  const pos = inputEl.selectionStart;
  inputEl.value = inputEl.value.slice(0, mentionState.start) + insert + " " + inputEl.value.slice(pos);
  const newPos = mentionState.start + insert.length + 1;
  inputEl.setSelectionRange(newPos, newPos);
  mentionState = null;
  mentionMenu.classList.remove("show");
  inputEl.focus();
  syncInputHl();
}

// ---------- @文件 //技能 token 高亮：镜像层与 textarea 逐字对齐，只画底色不碰文字 ----------
const inputHl = document.getElementById("input-hl");
{
  const cs = getComputedStyle(inputEl);
  for (const p of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontFamily", "fontSize", "lineHeight", "letterSpacing"]) inputHl.style[p] = cs[p];
}
function hlTokens(text, cls) {
  // /token 只在命中已装技能时高亮（避免把 /Users/... 这类路径误当指令）；@token 一律高亮
  return esc(text).replace(/(^|[\s（(：:，,])(@[^\s@，。！？；：、（）()<>"']+|\/[^\s@/，。！？；：、（）()<>"']+)/g, (m, pre, tok) => {
    if (tok[0] === "/" && !skillsCache.some(s => tok.slice(1).toLowerCase() === String(s.name).toLowerCase())) return m;
    return pre + `<span class="${cls}">${tok}</span>`;
  });
}
function syncInputHl() {
  inputHl.innerHTML = inputEl.value ? hlTokens(inputEl.value, "tk") + "\n" : "";
  inputHl.scrollTop = inputEl.scrollTop;
}
inputEl.addEventListener("input", syncInputHl);
inputEl.addEventListener("scroll", () => { inputHl.scrollTop = inputEl.scrollTop; });

inputEl.addEventListener("input", detectMention);
inputEl.addEventListener("click", detectMention);
inputEl.addEventListener("keydown", (e) => {
  if (mentionMenu.classList.contains("show")) {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const sel = mentionMenu.querySelector(".mi.sel") || mentionMenu.querySelector(".mi[data-insert]:not([data-insert=''])");
      applyMention(sel ? sel.dataset.insert : null);
      return;
    }
    if (e.key === "Escape") { mentionMenu.classList.remove("show"); mentionState = null; }
  }
}, true);

// ================= 成果文件 =================
function fileIcon(name) {
  if (/\.pptx?$/i.test(name)) return "📊";
  if (/\.docx?$/i.test(name)) return "📄";
  if (/\.xlsx?$/i.test(name)) return "📈";
  if (/\.(md|txt)$/i.test(name)) return "📝";
  if (/\.csv$/i.test(name)) return "🗂️";
  if (/\.html?$/i.test(name)) return "🌐";
  if (/\.pdf$/i.test(name)) return "📕";
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(name)) return "🖼️";
  if (/\.(mp4|mov|webm|m4v)$/i.test(name)) return "🎬";
  return "📎";
}
function fmtSize(n) { return n > 1048576 ? (n/1048576).toFixed(1)+" MB" : n > 1024 ? (n/1024).toFixed(1)+" KB" : n+" B"; }
const openDirs = new Set(); // 记住展开状态，刷新列表不回弹
/** 在访达/资源管理器里打开文件所在的文件夹并选中它。按钮挂在文件行/卡片上，别冒泡触发预览 */
function revealFile(name, e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  fetch("/api/files/reveal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) })
    .then(r => r.json()).then(j => { if (j && j.error) toast(j.error); })
    .catch(() => toast("打不开所在位置"));
}
const revealBtn = (name) => `<span class="dl rv" data-rv="${esc(name)}" title="打开所在位置">📂</span>`;

function renderFiles(files) {
  filesCache = files || [];
  const el = document.getElementById("file-list");
  if (!files || !files.length) { el.innerHTML = '<div style="padding:10px;color:var(--wb-text-3);font-size: 13px">暂无成果文件</div>'; return; }
  const fileRow = (f, nested) =>
    `<div class="file-item${nested ? " nested" : ""}" style="cursor:pointer" data-name="${esc(f.name)}" title="${esc(f.name)}">
      <span>${fileIcon(f.name)}</span>
      <span style="min-width:0"><div class="name">${esc(f.name.split("/").pop())}</div><div class="meta">${fmtSize(f.size)}</div></span>
      ${revealBtn(f.name)}
      <a class="dl" href="/api/files/download/${encodeURIComponent(f.name)}" download title="下载">⬇</a>
    </div>`;
  // 根目录文件（智能体产出）置顶按时间排；子目录归成可折叠分组
  const rootFiles = files.filter(f => !f.name.includes("/"));
  const groups = {};
  for (const f of files) {
    if (!f.name.includes("/")) continue;
    const dir = f.name.slice(0, f.name.lastIndexOf("/"));
    (groups[dir] = groups[dir] || []).push(f);
  }
  const curDir = sessionDirs.get(sessionId); // 当前对话的成果文件夹：置顶并标出来
  let html = rootFiles.map(f => fileRow(f, false)).join("");
  for (const dir of Object.keys(groups).sort((a, b) => (a === curDir ? -1 : b === curDir ? 1 : a.localeCompare(b, "zh")))) {
    const open = openDirs.has(dir);
    html += `<div class="dir-head${dir === curDir ? " mine" : ""}" data-dir="${esc(dir)}"><span>${open ? "▾" : "▸"}</span><span>📁</span><div class="name">${dir === curDir ? '<span class="mine-tag">本对话</span>' : ""}${esc(dir)}</div><span class="cnt">${groups[dir].length}</span><span class="opendir" data-opendir="${esc(dir)}" title="在 Finder 中打开这个文件夹">↗</span></div>`;
    if (open) html += groups[dir].sort((a, b) => a.name.localeCompare(b.name, "zh")).map(f => fileRow(f, true)).join("");
  }
  el.innerHTML = html;
  el.querySelectorAll(".dir-head").forEach(h => h.onclick = () => {
    openDirs.has(h.dataset.dir) ? openDirs.delete(h.dataset.dir) : openDirs.add(h.dataset.dir);
    renderFiles(filesCache);
  });
  el.querySelectorAll(".opendir").forEach(b => { b.onclick = (e) => {
    e.stopPropagation();
    fetch("/api/files/open/" + encodeURIComponent(b.dataset.opendir), { method: "POST" }).catch(() => {});
  }; });
  el.querySelectorAll("[data-rv]").forEach(b => { b.onclick = (e) => revealFile(b.dataset.rv, e); });
  el.querySelectorAll(".file-item").forEach(item => item.onclick = (e) => {
    if (e.target.closest(".dl")) return; // 下载/定位按钮不拦截
    e.preventDefault();
    previewFile(item.dataset.name);
  });
}
fetch("/api/files").then(r => r.json()).then(f => { if (Array.isArray(f)) { renderFiles(f); snapshotFiles(f); } }).catch(() => {});

// ================= 助理模式（IM 通道状态 + 最近消息） =================
const WS_STATE_TXT = { connected: "已连接", connecting: "连接中…", reconnecting: "重连中…", failed: "连接失败", idle: "已断开", off: "未启动", unknown: "未知" };
async function refreshImStatus() {
  try {
    const s = await fetch("/im/status").then(r => r.json());
    // 只数真在线的：飞书/QQ/微信长连接 connected，企微应用/公众号回调配置齐，企微群推送已配
    let n = 0;
    if (s.feishu.configured && s.feishu.ws.state === "connected") n++;
    if ((s.qq || {}).configured && s.qq.state === "connected") n++;
    if ((s.wechat_ilink || {}).configured && s.wechat_ilink.state === "connected") n++;
    if ((s.wecom_app || {}).configured && s.wecom_app.callback_ready) n++;
    if ((s.wechat_mp || {}).configured && s.wechat_mp.callback_ready) n++;
    if (s.wecom.configured) n++;
    const sub = document.getElementById("ab-sub");
    if (sub) sub.textContent = n ? `${n} 个通道在线` : "IM 远程指挥";
  } catch {}
}
document.getElementById("ab-head").onclick = () => openAssistView();
refreshImStatus();
setInterval(refreshImStatus, 15000);

// ---------------- 文件预览 ----------------
const OFFICE_RE = /\.(docx?|pptx?|xlsx?)$/i;
const pvPanel = document.getElementById("preview-panel");
let pvCurrent = null;

async function previewFile(name) {
  if (OFFICE_RE.test(name)) {
    // Office 文件交给本机 Office/WPS 打开
    await fetch("/api/files/open/" + encodeURIComponent(name), { method: "POST" });
    return;
  }
  pvCurrent = name;
  document.getElementById("files-panel").classList.remove("show"); // 预览时收起文件列表，给聊天区留空间
  // 立刻亮预览面板再去异步拉内容：晚亮的话，自动预览的调用方同步检查时以为预览没开，
  // 会把成果文件面板弹回来，右侧双开互相盖字（用户反馈过）
  pvPanel.classList.add("show");
  document.getElementById("pv-body").innerHTML = `<div class="pv-text" style="color:var(--wb-text-3)">加载中…</div>`;
  document.getElementById("pv-name").textContent = name;
  document.getElementById("pv-dl").href = "/api/files/download/" + encodeURIComponent(name);
  const body = document.getElementById("pv-body");
  const url = "/api/files/view/" + encodeURIComponent(name) + "?t=" + Date.now();
  if (/\.(html?|pdf|svg)$/i.test(name)) {
    // SVG 也走 iframe：mermaid 老文件的文字在 <foreignObject> 里，<img> 按安全静态模式渲染会丢字
    body.innerHTML = `<iframe src="${url}"></iframe>`;
  } else if (/\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(name)) {
    body.innerHTML = `<img src="${url}">`;
  } else if (/\.(md|markdown)$/i.test(name)) {
    const text = await fetch(url).then(r => r.text()).catch(() => "加载失败");
    body.innerHTML = `<div class="pv-text a-text">${renderMd(text)}</div>`;
  } else if (/\.(txt|csv|json|js|cjs|css|xml|log|yml|yaml)$/i.test(name)) {
    const text = await fetch(url).then(r => r.text()).catch(() => "加载失败");
    body.innerHTML = `<div class="pv-text"><pre style="white-space:pre-wrap;word-break:break-all">${esc(text.slice(0, 100000))}</pre></div>`;
  } else {
    body.innerHTML = `<div class="pv-text" style="color:var(--wb-text-3)">该格式暂不支持应用内预览，可点右上 🗔 用系统程序打开，或 ⬇ 下载。</div>`;
  }
  pvPanel.classList.add("show");
  renderDeployBar();
}
document.getElementById("pv-close").onclick = () => { pvPanel.classList.remove("show"); pvCurrent = null; };
document.getElementById("pv-sys").onclick = () => { if (pvCurrent) fetch("/api/files/open/" + encodeURIComponent(pvCurrent), { method: "POST" }); };
document.getElementById("pv-rv").onclick = () => { if (pvCurrent) revealFile(pvCurrent); };

// ---- 本地部署预览：iframe 里看长相够了，但真网页要有自己的 origin（相对路径/fetch/localStorage/手机上开）----
let previewSrv = { running: false };
async function renderDeployBar() {
  const bar = document.getElementById("pv-deploy");
  if (!pvCurrent || !/\.html?$/i.test(pvCurrent)) { bar.style.display = "none"; return; }
  bar.style.display = "";
  if (!previewSrv.running) {
    bar.innerHTML = `<span>这是个网页，要不要本地部署预览？（起一个本机服务，相对路径和 fetch 才正常）</span>
      <button class="primary" id="pv-serve">本地部署预览</button>`;
    bar.querySelector("#pv-serve").onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = "启动中…";
      previewSrv = await startPreview(false); // 默认只听本机，要给手机看再单独放开
      if (!previewSrv.running) { toast("本地预览服务启动失败"); }
      renderDeployBar();
    };
    return;
  }
  const url = previewSrv.url + encodeURIComponent(pvCurrent);
  const lan = previewSrv.lan_url ? previewSrv.lan_url + encodeURIComponent(pvCurrent) : null;
  bar.innerHTML = `<span>✅ 已本地部署</span><code>${esc(url)}</code>
    ${lan
      ? `<span style="color:var(--wb-text-3)">手机同 Wi-Fi 可开</span><code>${esc(lan)}</code>`
      : `<button id="pv-lan" title="同一个 Wi-Fi 下的人都能翻你的工作目录，看完记得停">放开给手机看</button>`}
    <button id="pv-open-br">在浏览器打开</button><button id="pv-serve-stop">停止</button>`;
  bar.querySelector("#pv-open-br").onclick = async (e) => {
    // 传当前的 lan 状态，别把已经放开给手机的服务悄悄收回本机
    e.target.disabled = true;
    const st = await startPreview(previewSrv.lan_open, pvCurrent);
    e.target.disabled = false;
    if (st.running) previewSrv = st; else toast(st.error || "本地预览服务没起来，打不开");
  };
  const lanBtn = bar.querySelector("#pv-lan");
  if (lanBtn) lanBtn.onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = "切换中…";
    previewSrv = await startPreview(true);
    if (!previewSrv.lan_url) toast("这台机器没找到局域网地址（没连 Wi-Fi？）");
    renderDeployBar();
  };
  bar.querySelector("#pv-serve-stop").onclick = async () => {
    previewSrv = await fetch("/api/preview/stop", { method: "POST" }).then(r => r.json()).catch(() => ({ running: false }));
    renderDeployBar();
  };
}
function startPreview(lan, open) {
  return fetch("/api/preview/start", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lan: !!lan, open: open || undefined }),
  }).then(r => r.json()).catch(() => ({ running: false }));
}
fetch("/api/preview/status").then(r => r.json()).then(s => { previewSrv = s; }).catch(() => {});

// 任务产出/更新 HTML 时，自动在右侧实时展示
let fileSnapshot = null; // null = 基线还没建（首屏 /api/files 还没回来）
function snapshotFiles(files) {
  fileSnapshot = {};
  for (const f of files || []) fileSnapshot[f.name] = f.mtime;
}
// 和上一次快照比，挑出这次任务真正新增/改动过的文件（不改快照，调用方决定什么时候推进）
// 基线没建好就先拿这次当基线：否则首屏没加载完就发任务，整个工作目录都会被当成"本次产出"糊一屏卡片
function changedFiles(files) {
  if (!fileSnapshot) { snapshotFiles(files); return []; }
  return (files || []).filter(f => fileSnapshot[f.name] !== f.mtime);
}
function autoPreviewNewHtml(files, changed) {
  // 任务产出/更新 html 或 md 时自动在右侧预览（html 优先）。
  // changed 由调用方给（服务端算的更准），没给才退回本地 mtime 差异
  changed = changed || changedFiles(files);
  const target = changed.find(f => /\.html?$/i.test(f.name)) || changed.find(f => /\.(md|markdown)$/i.test(f.name));
  if (target) previewFile(target.name);
  if (!fileSnapshot) fileSnapshot = {};
  for (const f of files || []) fileSnapshot[f.name] = f.mtime;
}

// 来源：这一回合真正打开过的网页。不是"模型说它参考了什么"，而是工具层记下来的实际访问记录，
// 所以点进去一定打得开，也能拿它反查结论是不是有出处。
function renderSources(body, items) {
  if (!items || !items.length) return;
  let block = body.querySelector(":scope > .src-block");
  if (!block) {
    block = document.createElement("div");
    block.className = "src-block";
    block.innerHTML = `<div class="src-hd"></div><div class="src-list"></div>`;
    block.querySelector(".src-hd").onclick = () => block.classList.toggle("open");
    body.appendChild(block);
  }
  const list = block.querySelector(".src-list");
  const seen = block._seen || (block._seen = new Set());
  for (const it of items) {
    const url = String(it && it.url || "").trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const a = document.createElement("a");
    a.className = "src-item";
    a.href = url;
    a.target = "_blank";
    a.rel = "noreferrer noopener";
    a.title = (it.title ? it.title + "\n" : "") + url;
    a.innerHTML = `<span class="n">${seen.size}</span><span class="t">${esc(it.title || hostOf(url))}</span><span class="n">${esc(hostOf(url))}</span>`;
    list.appendChild(a);
  }
  block.querySelector(".src-hd").textContent = `来源 (${seen.size})`;
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return String(u).slice(0, 30); } }

// 把本回合的产出做成卡片挂在对话里。右侧文件面板是"所有文件"，这里是"这次产出的"——
// 用户要的是聊完直接点开，而不是回头去面板里认哪个是刚才那个。
const OUT_CARD_MAX = 8;                                   // 一屏摆得下的量；超了只提示条数，别把对话冲垮
function renderTurnOutputs(body, changed) {
  if (!body || !changed || !changed.length) return;
  let block = body.querySelector(":scope > .out-block");
  if (!block) {
    block = document.createElement("div");
    block.className = "out-block fold"; // 变更清单默认收起，想看再点开
    block.innerHTML = `<div class="out-grid"></div><div class="out-hd out-toggle"><span class="ar">▸</span> 查看所有变更 <span class="n"></span></div><div class="out-list"></div>`;
    body.appendChild(block);
    block.querySelector(".out-toggle").onclick = () => {
      const fold = block.classList.toggle("fold");
      block.querySelector(".ar").textContent = fold ? "▸" : "▾";
    };
  }
  const grid = block.querySelector(".out-grid");
  const list = block.querySelector(".out-list");
  for (const f of changed) {
    const isHtml = /\.html?$/i.test(f.name);
    const isImg = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(f.name);
    // 真正的展示品（网页/图）才配得上缩略图卡片；其余文件进变更清单，别把对话挡成一屏方框
    if (isHtml || isImg) {
      const base = f.name.split("/").pop();
      const same = grid.querySelector(`.out-card[data-name="${cssEsc(f.name)}"]`);
      // 同名同大小 = 同一件产出被拷成了两份（agent 常把任务子目录里的产出再往工作空间根目录复制一份）。
      // 卡片区只摆一张，否则用户看到的就是「同一张图显示了两遍」；两个路径在下面的变更清单里都还留着，信息不丢
      const twin = same || (f.size ? grid.querySelector(`.out-card[data-base="${cssEsc(base)}"][data-size="${f.size}"]`) : null);
      if (!twin) {
        if (grid.querySelectorAll(".out-card").length < OUT_CARD_MAX) grid.appendChild(makeOutCard(f, isHtml));
      } else if (!same && pathDepth(f.name) < pathDepth(twin.dataset.name)) {
        // 副本留路径最浅的那份：点「所在位置」多半是想去工作目录根，而不是任务子目录
        twin.replaceWith(makeOutCard(f, isHtml));
      }
    }
    if (!list.querySelector(`[data-name="${cssEsc(f.name)}"]`)) { // 同一文件改多次只记一行
      const row = document.createElement("div");
      row.className = "out-row";
      row.dataset.name = f.name;
      const nmHtml = f.name.includes("/")
        ? `<span class="dim">${esc(f.name.slice(0, f.name.lastIndexOf("/") + 1))}</span>${esc(f.name.split("/").pop())}`
        : esc(f.name);
      row.innerHTML = `<span class="ic">${fileIcon(f.name)}</span><span class="nm">${nmHtml}</span><span class="sz">${fmtSize(f.size)}</span>${revealBtn(f.name)}<a class="dl" href="/api/files/download/${encodeURIComponent(f.name)}" download title="下载">⬇</a>`;
      row.querySelector("[data-rv]").onclick = (e) => revealFile(f.name, e);
      row.onclick = (e) => { if (e.target.closest("a") || e.target.closest(".rv")) return; previewFile(f.name); };
      list.appendChild(row);
    }
  }
  markDupBasenames(grid);
  block.querySelector(".out-hd .n").textContent = `(${list.querySelectorAll(".out-row").length})`;
}

function pathDepth(n) { return String(n || "").split("/").length; }

function makeOutCard(f, isHtml) {
  const url = "/api/files/view/" + encodeURIComponent(f.name) + "?t=" + Date.now();
  const thumb = isHtml || /\.svg$/i.test(f.name) ? `<iframe src="${url}" scrolling="no" tabindex="-1" aria-hidden="true"></iframe>` : `<img src="${url}" alt="">`;
  const card = document.createElement("div");
  card.className = "out-card";
  card.dataset.name = f.name;
  card.dataset.base = f.name.split("/").pop();      // 判重按「文件名 + 大小」，光看全路径认不出复制出来的副本
  if (f.size) card.dataset.size = String(f.size);
  card.title = f.name;
  card.innerHTML = `<div class="out-thumb">${thumb}</div>
    <div class="out-info"><div class="out-name">${esc(f.name.split("/").pop())}</div>
      <div class="out-meta">${fmtSize(f.size)} · 点击预览</div></div>
    <div class="out-acts">${isHtml ? `<button data-a="br">在浏览器打开</button>` : ""}
      <button data-a="rv">所在位置</button>
      <a href="/api/files/download/${encodeURIComponent(f.name)}" download>下载</a></div>`;
  card.onclick = (e) => {
    if (e.target.closest("a")) return;
    if (e.target.closest('[data-a="rv"]')) return revealFile(f.name, e);
    if (e.target.closest('[data-a="br"]')) {
      e.stopPropagation();
      startPreview(previewSrv.lan_open, f.name).then(st => {
        if (st.running) previewSrv = st; else toast(st.error || "本地预览服务没起来，打不开");
      });
      return;
    }
    previewFile(f.name);
  };
  return card;
}

// 同名但内容不同的两件产出（a/report.html 和 b/report.html）：卡片上只写文件名，用户根本分不出谁是谁，
// 给这类卡片补上所在目录。内容相同的副本上面已经并成一张卡了，走不到这里
function markDupBasenames(grid) {
  const byBase = {};
  grid.querySelectorAll(".out-card").forEach(c => {
    (byBase[c.dataset.base] = byBase[c.dataset.base] || []).push(c);
  });
  Object.keys(byBase).forEach(b => {
    if (byBase[b].length < 2) return;
    byBase[b].forEach(c => {
      const nm = c.querySelector(".out-name");
      if (!nm || nm.querySelector(".dim")) return;
      const path = c.dataset.name;
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "./";
      nm.innerHTML = `<span class="dim">${esc(dir)}</span>` + nm.innerHTML;
    });
  });
}
// 文件名进 CSS 属性选择器要转义（含空格、中文括号、引号的名字很常见）
function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"); }
document.getElementById("toggle-files").onclick = () => {
  const fp = document.getElementById("files-panel");
  fp.classList.toggle("show");
  // 预览和成果文件面板互斥：右侧只留一个。双开把聊天区挤没，窄窗下两个浮层还互相盖字
  if (fp.classList.contains("show") && pvPanel.classList.contains("show")) {
    pvPanel.classList.remove("show"); pvCurrent = null;
  }
};
document.getElementById("fp-close").onclick = () => document.getElementById("files-panel").classList.remove("show");
// 侧栏开关：窄窗（≤900px）走浮层抽屉 side-open，宽窗走常规折叠 side-collapsed
function toggleSidebar() {
  if (window.innerWidth <= 900) document.body.classList.toggle("side-open");
  else document.body.classList.toggle("side-collapsed");
}
document.getElementById("toggle-side").onclick = toggleSidebar;
window.addEventListener("resize", () => { if (window.innerWidth > 900) document.body.classList.remove("side-open"); });
document.querySelector(".main").addEventListener("click", () => {
  if (document.body.classList.contains("side-open")) document.body.classList.remove("side-open");
}, true);
document.getElementById("open-ws").onclick = (e) => { e.preventDefault(); fetch("/api/open-workspace", { method: "POST" }); };

// ================= 下拉菜单通用 =================
function setupPicker(btnId, menuId) {
  const btn = document.getElementById(btnId);
  const menu = document.getElementById(menuId);
  btn.onclick = (e) => { e.stopPropagation(); closeAllMenus(menu); menu.classList.toggle("show"); };
  return menu;
}
function closeAllMenus(except) {
  document.querySelectorAll(".picker-menu").forEach(m => { if (m !== except) m.classList.remove("show"); });
}
document.addEventListener("click", () => closeAllMenus());

// ================= 模型选择（输入卡片右下角，仿官方 Auto ▾） =================
const modelMenu = setupPicker("model-btn", "model-menu");
async function refreshSettingsCache() {
  settingsCache = await fetch("/api/settings").then(r => r.json()).catch(() => null);
  if (settingsCache && settingsCache.error) settingsCache = null; // 未登录时 401 JSON，不当配置用
  if (settingsCache) {
    // 首次拿到配置时给还没动过的新对话套上「沿用上次模型」；之后的刷新不再动，免得盖掉用户手动清掉的选择
    if (!refreshSettingsCache._inited) { refreshSettingsCache._inited = true; if (sessionId === null && !pendingModel) pendingModel = defaultPendingModel(); }
    updateModelLabel();
    document.getElementById("ws-label").textContent = settingsCache.workspace_dir.split(/[\\/]/).pop() || "工作空间";
    renderModelMenu();
    renderWsMenu();
  }
}
// 这个选择器只管「当前对话」用哪个模型，不动全局默认（全局默认在 设置 → 模型 里改）。
// 每个对话可以各选各的：切换对话时标签跟着换，别的对话完全不受影响
function currentSessModel() {
  return sessionId === null ? pendingModel : sessionModels.get(sessionId);
}
// 「新对话沿用上次手动选的模型」（设置 → 模型 里的开关）：算出新对话该预选谁。
// 直接写进 pendingModel 让标签立刻显示出来——用户发消息前就看得见用的是哪个，绝不静默换模型
function defaultPendingModel() {
  const s = settingsCache;
  if (s && s.model_follow_last && s.last_picked_model && s.last_picked_model !== s.active_model
      && (s.models || []).some(m => m.name === s.last_picked_model)) return s.last_picked_model;
  return undefined;
}
function updateModelLabel() {
  if (!settingsCache) return;
  const ov = currentSessModel();
  document.getElementById("model-label").textContent = ov || settingsCache.active_model;
  renderModelMenu();
}
async function setSessionModel(name) { // name: 模型名；null = 跟随全局默认
  if (sessionId === null) { pendingModel = name || undefined; updateModelLabel(); return; }
  try {
    const r = await fetch("/api/session/" + encodeURIComponent(sessionId) + "/model", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: name }) }).then(x => x.json());
    if (r && r.error) return toast("⚠️ " + r.error);
    if (name) sessionModels.set(sessionId, name); else sessionModels.delete(sessionId);
    if (name && settingsCache) settingsCache.last_picked_model = name; // 服务端也记了，这里同步本地缓存
  } catch {}
  updateModelLabel();
}
// 模型健康小标：近 N 次任务的成败（服务端账本）。连挂 ≥2 标红——坏渠道一眼看出来，不用踩了才知道
function healthBadge(name) {
  const h = settingsCache && settingsCache.model_health && settingsCache.model_health[name];
  if (!h || !h.n) return "";
  let s = ` · 近${h.n}次任务${h.ok}成`;
  if (h.fail_streak >= 2) s += ` <span style="color:var(--wb-err)" title="${esc(h.last_fail || "")}">⚠连挂${h.fail_streak}</span>`;
  return s;
}
