async function updateEvalView() {
  if (pageKind !== "eval") return;
  const st = await fetch("/api/eval/status").then((r) => r.json()).catch(() => null);
  if (pageKind !== "eval" || !st) return;
  const state = document.getElementById("ev-state"), log = document.getElementById("ev-log"), histBox = document.getElementById("ev-hist"), btn = document.getElementById("ev-start");
  if (!state || !log || !histBox) return;
  if (st.running) {
    setMsg(state, "hourglass", `${st.model} 评测中… ${Math.round((Date.now() - st.startedAt) / 1000)}s`);
    if (btn) btn.disabled = true;
    if (!assistTimer) assistTimer = setInterval(updateEvalView, 2000);
  } else {
    if (assistTimer) { clearInterval(assistTimer); assistTimer = null; }
    if (btn) btn.disabled = false;
    if (!st.startedAt || st.exit == null) setMsg(state, "", "");
    else if (st.exit === 0) setMsg(state, "circle-check", "上一轮题题稳过", "ok");
    else setMsg(state, "triangle-alert", "上一轮有失分，看日志或点历史行看明细");
  }
  if (st.lines && st.lines.length) {
    // hidden 属性是 UA 的 display:none，style.display="" 顶不掉它——得撤属性
    log.hidden = false;
    log.textContent = st.lines.join("\n");
    if (st.running) log.scrollTop = log.scrollHeight;
  }
  const hj = await fetch("/api/eval/history").then((r) => r.json()).catch(() => null);
  if (pageKind !== "eval") return;
  const hist = Array.isArray(hj) ? hj : (hj && hj.runs) || [];
  const baseline = (hj && !Array.isArray(hj) && hj.baseline) || null;
  if (!hist.length) {
    histBox.innerHTML = `<div class="ev-empty">还没跑过。上面选个模型点「开始评测」，或者命令行 <code>npm run eval</code>。<br>第一轮跑完记得点开成绩设为基线——之后每轮才有得比。</div>`;
    return;
  }
  const blBanner = baseline
    ? `<div class="ev-bl">${ic("pin")}当前基线：${esc(baseline.model || "")} · ${esc(String(baseline.at || "").slice(0, 16).replace("T", " "))} · <code>${esc(baseline.commit || "—")}</code> · 每次跑批自动逐题对比</div>`
    : `<div class="ev-bl">${ic("pin")}还没钉基线——点开一次成绩，点「设为基线」，之后每轮自动对比退步和进步</div>`;
  const th = (t, tip) => `<th${tip ? ` title="${esc(tip)}"` : ""}>${t}</th>`;
  histBox.innerHTML = blBanner + `<div class="ev-tab-wrap"><table class="ev-tab">
      <thead><tr>${th("时间")}${th("模型")}${th("次数", "每题重复几次")}${th("pass@1", "各题通过率的平均：能不能做对")}${th("稳定全过", "k 次全过的题数：稳不稳；时过时不过的题会单独标出来")}${th("对比基线", "与钉住的基线逐题对比")}${th("AI 评委", "逐条质量维度二元判定的达标率（旧格式为 1-5 均分）")}${th("人工", "人工打星的均分")}${th("tokens")}${th("版本", "跑分时的代码 commit")}</tr></thead>
      <tbody>${hist.map((h) => {
        const p1 = h.pass1_avg != null ? h.pass1_avg : h.score_pct;
        const scoreCls = p1 >= 100 ? " is-ok" : p1 >= 80 ? "" : " is-bad";
        const bl = h.baseline;
        const dCell = !bl ? "—" : (bl.regressions && bl.regressions.length
          ? `<span class="ev-down" title="退步：${esc(bl.regressions.join(", "))}">${ic("trending-down")} ${bl.regressions.length} 题</span>`
          : (bl.improvements && bl.improvements.length ? `<span class="ev-up" title="进步：${esc(bl.improvements.join(", "))}">${ic("trending-up")} ${bl.improvements.length} 题</span>` : `<span title="与基线持平">持平</span>`));
        const jd = h.judge ? (h.judge.avg_pct != null ? ic("scale") + " " + h.judge.avg_pct + "%" : (h.judge.avg != null ? ic("scale") + " " + h.judge.avg + "/5" : "—")) : "—";
        return `<tr data-dir="${esc(h.dir || "")}"${h.dir && h.dir === evalDetailDir ? ' class="on"' : ""}>
          <td>${esc(String(h.at || "").slice(0, 16).replace("T", " "))}</td>
          <td>${esc(h.model || "")}</td>
          <td class="num">${h.repeat || 1}×</td>
          <td class="score${scoreCls}">${p1}%</td>
          <td class="num">${h.full_pass}/${h.tasks}${(h.flaky_tasks || []).length ? ` <span class="ev-flaky" title="不稳定：${esc((h.flaky_tasks || []).join(", "))}">${ic("zap")}${h.flaky_tasks.length}</span>` : ""}</td>
          <td>${dCell}</td>
          <td class="num">${jd}</td>
          <td class="num">${h.human && h.human.avg ? ic("star") + " " + h.human.avg : "—"}</td>
          <td class="num">${((h.tokens_total || 0) / 1000).toFixed(0)}k</td>
          <td><code>${esc(h.commit || "—")}</code></td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>`;
  histBox.querySelectorAll("tr[data-dir]").forEach((tr) => { if (tr.dataset.dir) tr.onclick = () => openEvalDetail(tr.dataset.dir); });
}
async function openEvalDetail(dir) {
  const box = document.getElementById("ev-detail");
  if (!box) return;
  if (evalDetailDir === dir) { evalDetailDir = null; box.innerHTML = ""; updateEvalView(); return; }
  evalDetailDir = dir;
  box.innerHTML = `<div class="ev-empty">加载明细…</div>`;
  const j = await fetch("/api/eval/run/" + encodeURIComponent(dir)).then((r) => r.json()).catch(() => null);
  if (evalDetailDir !== dir) return;
  if (!j || j.error) { box.innerHTML = ""; evalDetailDir = null; return toast(((j && j.error) || "明细加载失败"), "circle-x"); }
  const p1 = j.pass1_avg != null ? j.pass1_avg : j.score_pct;
  const cell = (v, k, cls) => `<div><b${cls ? ` class="${cls}"` : ""}>${v}</b><span>${k}</span></div>`;
  const bl = j.baseline;
  const blCell = !bl ? cell("—", "对比基线")
    : bl.regressions && bl.regressions.length ? cell(`${ic("trending-down")} ${bl.regressions.length} 题`, "对比基线退步", "is-bad")
      : cell(bl.improvements && bl.improvements.length ? `${ic("trending-up")} ${bl.improvements.length} 题` : "持平", bl.improvements && bl.improvements.length ? "对比基线进步" : "对比基线", bl.improvements && bl.improvements.length ? "is-ok" : "");
  // 概览这一排就是「这轮到底怎么样」的答案：三条评分线各占一格，别再挤成一行小灰字
  const head = `<div class="ev-det-head">
      <b>${esc(String(j.at || "").slice(0, 16).replace("T", " "))} · ${esc(j.model || "")}</b>
      <span class="ev-lv">${(j.repeat || 1) > 1 ? `每题 ${j.repeat} 次` : "每题 1 次"}</span>
      ${j.judge && j.judge.model ? `<span class="ev-lv">评委 ${esc(j.judge.model)}</span>` : ""}
      ${j.commit ? `<span class="ev-lv">版本 ${esc(j.commit)}</span>` : ""}
      <span class="ev-det-ops"><a href="#" id="ev-pin" class="link">${ic("pin")} 设为基线</a><a href="#" id="ev-close" class="link">${ic("x")} 收起</a></span>
    </div>
    <div class="ev-sum">
      ${cell(p1 + "%", "pass@1 均值", p1 >= 100 ? "is-ok" : p1 >= 80 ? "" : "is-bad")}
      ${cell(`${j.full_pass}/${j.tasks}`, "稳定全过", j.full_pass === j.tasks ? "is-ok" : "")}
      ${cell((j.flaky_tasks || []).length || "0", "时过时不过", (j.flaky_tasks || []).length ? "is-bad" : "")}
      ${cell(`${j.checks_passed}/${j.checks_total}`, "机器判分检查项")}
      ${cell(j.judge ? (j.judge.avg_pct != null ? j.judge.avg_pct + "%" : (j.judge.avg != null ? j.judge.avg + "/5" : "—")) : "—", "AI 评委质量")}
      ${cell(j.human && j.human.avg ? ic("star") + " " + j.human.avg : "—", j.human && j.human.scored ? `人工分（已评 ${j.human.scored} 题）` : "人工分")}
      ${cell(((j.tokens_total || 0) / 1000).toFixed(1) + "k", "Token 合计")}
      ${blCell}
    </div>`;
  const rows = (j.results || []).map((r) => {
    const k = r.k || 1;
    const passes = r.passes != null ? r.passes : (r.passed === r.total ? 1 : 0);
    const cls = passes === k ? "" : passes ? " is-flaky" : " is-bad";
    const icon = passes === k ? "circle-check" : passes ? "zap" : (r.passed ? "triangle-alert" : "circle-x");
    const lv = r.level ? `<span class="ev-lv">L${r.level}${r.kind ? " · " + esc(r.kind) : ""}</span>` : "";
    const tries = (r.attempts && r.attempts.length > 1)
      ? `<span class="ev-tries" title="每格一次尝试">${r.attempts.map((a) => `<span class="ev-try${a.passed === a.total ? "" : " is-bad"}" title="第${a.n}次：${a.passed}/${a.total}${a.fail_code ? " · " + (EV_FAIL_LABELS[a.fail_code] || a.fail_code) : ""}">${ic(a.passed === a.total ? "check" : "x")}</span>`).join("")}</span>`
      : "";
    const chips = (r.fail_codes || []).map((c) => `<span class="ev-code">${EV_FAIL_LABELS[c] || esc(c)}</span>`).join("");
    const checks = (r.checks || []).map((c) => `<div class="ev-chk${c.ok ? "" : " is-bad"}">${ic(c.ok ? "check" : "x")}<span>${esc(c.name)}${c.note ? `<em> — ${esc(c.note)}</em>` : ""}</span></div>`).join("");
    const judge = r.judge && r.judge.dims
      ? `<div class="ev-judge"><b>${ic("scale")}质量维度 ${r.judge.passed}/${r.judge.total}</b>${r.judge.dims.map((d) => `<div class="ev-chk${d.pass ? "" : " is-bad"}">${ic(d.pass ? "check" : "x")}<span>${esc(d.q)}${d.note ? `<em> — ${esc(d.note)}</em>` : ""}</span></div>`).join("")}</div>`
      : r.judge && r.judge.score
        ? `<div class="ev-judge"><b>${ic("scale")}AI 评委 ${r.judge.score}/5 — ${esc(r.judge.verdict || "")}</b>${(r.judge.reasons || []).length ? `<div class="note">${r.judge.reasons.map((x) => "· " + esc(x)).join("<br>")}</div>` : ""}${(r.judge.deductions || []).length ? `<div class="cut">${r.judge.deductions.map((x) => "扣分：" + esc(x)).join("<br>")}</div>` : ""}</div>`
        : (r.judge && r.judge.error ? `<div class="ev-judge"><b>${ic("scale")}评委没跑成</b><div class="note">${esc(r.judge.error)}</div></div>` : "");
    const hs = (r.human && r.human.score) || 0;
    const stars = [1, 2, 3, 4, 5].map((n) => `<button class="ev-star${n <= hs ? " on" : ""}" data-task="${esc(r.id)}" data-star="${n}" title="人工打 ${n} 分">${ic("star")}</button>`).join("");
    return `<div class="ev-task${cls}">
      <div class="ev-task-head">
        ${ic(icon)}<span class="nm">${esc(r.name)}</span>${lv}${tries}${chips}
        <span class="ev-facts">${k > 1 ? `${passes}/${k} 次全过 · 首轮 ` : ""}${r.passed}/${r.total} 项 · ${r.elapsed_s}s · ${r.tool_calls || 0} 步${r.tool_errors ? ` · ${r.tool_errors} 次工具报错` : ""}${r.stopped ? " · " + esc(r.stopped) : ""}${r.crashed ? " · 崩溃" : ""}</span>
        <span class="ev-rate"><span class="ev-stars">${stars}</span><input class="ev-cmt" data-task="${esc(r.id)}" placeholder="点评（可选）" value="${esc((r.human && r.human.comment) || "")}"></span>
      </div>
      <div class="ev-chks">${checks}</div>
      ${judge}
      ${r.final_text ? `<details class="ev-final"><summary>最终回复摘录</summary><pre>${esc(String(r.final_text).slice(0, 1500))}</pre></details>` : ""}
    </div>`;
  }).join("");
  box.innerHTML = `<div class="ev-det">${head}<div class="ev-tasks">${rows}</div></div>`;
  updateEvalView();
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  box.querySelector("#ev-close").onclick = (e) => { e.preventDefault(); evalDetailDir = null; box.innerHTML = ""; updateEvalView(); };
  box.querySelector("#ev-pin").onclick = async (e) => {
    e.preventDefault();
    const r = await fetch("/api/eval/baseline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir }) }).then((x) => x.json()).catch(() => null);
    if (!r || r.error) return toast(((r && r.error) || "钉基线失败"), "circle-x");
    toast("已设为基线，之后每轮自动对比");
    updateEvalView();
  };
  const saveHuman = async (taskId, score) => {
    const cmt = box.querySelector(`.ev-cmt[data-task="${taskId}"]`);
    const r = await fetch("/api/eval/human", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir, task_id: taskId, score, comment: cmt ? cmt.value : "" }) }).then((x) => x.json()).catch(() => null);
    if (!r || r.error) return toast(((r && r.error) || "保存失败"), "circle-x");
    toast("人工分已保存");
    evalDetailDir = null;
    openEvalDetail(dir);
  };
  box.querySelectorAll(".ev-star").forEach((b) => b.onclick = () => saveHuman(b.dataset.task, +b.dataset.star));
  box.querySelectorAll(".ev-cmt").forEach((inp) => inp.onchange = () => {
    const row = (j.results || []).find((x) => x.id === inp.dataset.task);
    if (row && row.human && row.human.score) saveHuman(inp.dataset.task, row.human.score);
  });
}
/**
 * 这份文件是哪次任务做出来的。只认工作区产物（src==="ws"）：资料库里的文件是人手动传的，
 * 本来就没有「哪次任务」这回事，硬找只会给出一个凑出来的答案。
 * 一个文件可能被多次任务先后改写，取最近那次——用户想回去的是「上次动它的那回」。
 */
function libTaskOf(src, name) {
  if (src !== "ws" || !libOutCache) return null;
  for (const t of libOutCache.tasks || []) {          // tasks 已按时间倒序，第一个命中就是最近一次
    if ((t.files || []).some((f) => f.name === name)) return t;
  }
  return null;
}
/**
 * 这份文件是那次任务的第几回合写出来的。拿回合号是为了「跳到那段对话」——
 * 一个跑了三十轮的任务，只把对话打开等于还得自己翻，跟没跳一样。
 * 服务端查不到就不给（老会话没记过，或者文件是后来手动拷进来的），由调用点退回顶部。
 */
function libTurnOf(task, name) {
  const f = task && (task.files || []).find((x) => x.name === name);
  return f && Number.isInteger(f.turn) && f.turn >= 0 ? f.turn : null;
}
/** 文件名 -> 图标。资料库、按任务、搜索结果三处都走这一个函数，图例才对得上 */
function libIcon(n) {
  return ic(/\.html?$/i.test(n) ? "globe" : /\.csv$/i.test(n) ? "file-spreadsheet" : /\.(md|markdown)$/i.test(n) ? "file-pen-line" : /\.(png|jpe?g|gif|webp|svg)$/i.test(n) ? "image" : /\.pdf$/i.test(n) ? "file-type" : "file-text");
}
// 0 要写成「—」，不能顺着 Math.max(1,…) 变成「1 KB」：服务端查不到体积时传过来的就是 0，
// 画成「1 KB」等于替一个不知道的数字编了个具体值（真的空文件也是「里面什么都没有」，「—」一样对）
function libSize(n) { return !n ? "—" : n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
/**
 * 类型筛选。用户想找「那张图」「那个表」的时候，按名字他根本想不起来叫什么，
 * 但一定记得它是什么形状的东西。六个格子覆盖了实际产出的绝大多数。
 */
const LIB_KINDS = [
  ["all", "全部", () => true],
  ["doc", "文档", (n) => /\.(md|markdown|txt|docx?|pdf|rtf)$/i.test(n)],
  ["sheet", "表格", (n) => /\.(csv|tsv|xlsx?|numbers)$/i.test(n)],
  ["web", "网页", (n) => /\.html?$/i.test(n)],
  ["img", "图片", (n) => /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(n)],
  ["media", "音视频", (n) => /\.(mp4|mov|webm|mkv|mp3|wav|m4a|aac|flac)$/i.test(n)],
];
function libKindOk(name) {
  const k = LIB_KINDS.find((x) => x[0] === (libState.kind || "all"));
  return !k || k[2](name);
}
/** 这个文件归哪一类（给「按类型分组」用；跟上面的筛选共用同一套判定，两处不会打架） */
function libKindOf(name) {
  const k = LIB_KINDS.find((x) => x[0] !== "all" && x[2](name));
  return k ? k[1] : "其他";
}
/**
 * 取文件内容的地址。资料库和工作区两套路由，四处都要用，抄第四遍就该抽出来了。
 * w 传了就要缩略图：这一页的图框最大也就 64px（.lib-list.as-gallery .lib-it .th），
 * 而工作空间里真实躺着 3552×4736 的图，一张解码后 64 MB；一屏最多摆 120 张，
 * 拿原图当缩略图是让浏览器解码好几个 GB 的位图。服务端缩不动会自己发原图（细账在
 * thumb.js），所以这儿不用判断跑在哪儿。svg 不缩：矢量本来就小，栅格化反而更大更糊。
 */
function libUrl(src, name, w) {
  const url = "/api/" + (src === "lib" ? "library/file/" : "files/view/") + fpath(name);
  return w && !/\.svg$/i.test(name) ? url + "?thumb=" + w : url;
}
const LIB_IMG = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
/**
 * 三种摆法，照 macOS 访达那套来的。
 * 关键决定：三种摆法**共用同一份行 HTML**，只靠 .lib-list 上的类名换 CSS。
 * 各写一套渲染函数看着直观，但选中态、点击、键盘、分组、筛选就要各维护三遍——
 * 那才是真正会长歪的地方。
 */
const LIB_MODES = [["list", "列表", "list"], ["icon", "图标", "layout-grid"], ["gallery", "画廊", "gallery-horizontal"]];
const LIB_GROUPS = [["none", "不分组"], ["kind", "按类型"], ["time", "按时间"]];
/** 「今天 / 最近 7 天 / 本月 / 更早」——访达的「使用组」按日期就是这么分的 */
function libTimeBucket(iso) {
  const t = typeof iso === "number" ? iso : Date.parse(iso || "");
  if (!t) return "时间不详";
  const d = (Date.now() - t) / 86400000;
  return d < 1 ? "今天" : d < 7 ? "最近 7 天" : d < 30 ? "最近 30 天" : "更早";
}
/**
 * 按当前的分组方式把一串文件分堆。不分组就回一个没有标题的大堆——
 * 调用方只管铺 `[{ label, items }]`，不用到处写 if。
 */
function libGroupFiles(files) {
  const how = libState.group || "none";
  if (how === "none") return [{ label: "", items: files }];
  const order = how === "kind"
    ? LIB_KINDS.filter((k) => k[0] !== "all").map((k) => k[1]).concat("其他")
    : ["今天", "最近 7 天", "最近 30 天", "更早", "时间不详"];
  const bag = new Map();
  for (const f of files) {
    const key = how === "kind" ? libKindOf(f.name) : libTimeBucket(f.mtime);
    if (!bag.has(key)) bag.set(key, []);
    bag.get(key).push(f);
  }
  // 按固定次序排，不按谁先出现：同一个目录来回进出，分组的顺序不该跟着抖
  return order.filter((k) => bag.has(k)).map((k) => ({ label: k, items: bag.get(k) }));
}
/** 「3 分钟前 / 昨天 / 09-14」——绝对时间在这种列表里没人读得动，相对时间才有信息量 */
function libWhen(iso) {
  const t = typeof iso === "number" ? iso : Date.parse(iso || "");
  if (!t) return "";
  const d = (Date.now() - t) / 1000;
  if (d < 60) return "刚刚";
  if (d < 3600) return Math.floor(d / 60) + " 分钟前";
  if (d < 86400) return Math.floor(d / 3600) + " 小时前";
  if (d < 172800) return "昨天";
  const dt = new Date(t);
  return (dt.getMonth() + 1) + "-" + String(dt.getDate()).padStart(2, "0");
}
/** 把命中的那几个字标出来。搜索结果里不标，用户得自己在一行字里找自己刚打的词 */
function libMark(text, q) {
  const s = String(text == null ? "" : text);
  const needle = String(q || "").trim();
  if (!needle) return esc(s);
  const i = s.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return esc(s);
  return esc(s.slice(0, i)) + "<mark>" + esc(s.slice(i, i + needle.length)) + "</mark>" + esc(s.slice(i + needle.length));
}

/**
 * 一行 = 一个文件。文件夹视图、按任务、搜索结果、三种摆法——全都走这一份 HTML。
 * 之前每处各拼各的 <div class="lib-it">，结果是：搜索结果里有缩略图、按任务里没有；
 * 文件夹里显示修改时间、别处不显示。同一个东西在同一页里长出四个样子。
 *
 * o.full  拿内容用的完整名字（工作区那边是「任务_0916_xx/配音文案.md」这样的相对路径）
 * o.label 给人看的那一截（默认取最后一段）
 * o.note  顶掉体积那一列的字（「已不在」用这个）
 */
function libRowHtml(src, f, o) {
  const opt = o || {};
  const full = opt.full !== undefined ? opt.full : (f.path || f.name);
  const label = opt.label !== undefined ? opt.label : String(full).split("/").pop();
  const dir = opt.dir !== undefined ? opt.dir : String(full).split("/").slice(0, -1).join("/");
  const on = libState.pick && libState.pick.src === src && libState.pick.name === full;
  const gone = !!(opt.gone || f.gone);
  // 图片就直接拿真图当缩略图——图标视图里一排「图片」图标等于没有视图。
  // 文件没了就别发这个请求：拿一串 404 换一排碎图标没有意义。
  const thumb = !gone && LIB_IMG.test(label) ? `<img loading="lazy" src="${libUrl(src, full, 160)}" alt="">` : libIcon(label);
  // 「这东西是怎么来的」：一步跳回写出它的那段对话，而不是把对话从头摆出来让人自己翻。
  // 没有回合号就不画这个按钮——画一个按下去只会滚到顶的按钮，比没有还让人恼火
  const jp = opt.jump && Number.isInteger(opt.jump.turn) && opt.jump.turn >= 0 ? opt.jump : null;
  const jump = jp
    ? `<a href="#" class="lib-jump" data-open="${esc(jp.id)}" data-turn="${jp.turn}" title="跳到写出它的那一段对话（第 ${jp.turn + 1} 轮）">${ic("message-square")}</a>`
    : "";
  return `
  <div class="lib-it ${opt.cls || ""} ${gone ? "gone" : ""} ${on ? "active" : ""}" data-src="${src}" data-name="${esc(full)}"${opt.task ? ` data-task="${esc(opt.task)}"` : ""} title="${esc(full)}">
    <span class="th">${thumb}</span>
    <span class="nm">${libMark(label, opt.q)}${dir ? `<span class="pth">${esc(dir)}</span>` : ""}</span>
    <span class="sz">${opt.note !== undefined ? opt.note : libSize(f.size || 0)}</span>
    <span class="tm">${esc(libWhen(f.mtime))}</span>
    ${jump}
  </div>`;
}
/**
 * 一行摆得下几个（给 ← → ↑ ↓ 翻文件用）。不写死格子数：直接量 offsetTop，
 * 窗口多宽、CSS 以后怎么改，键盘的「上一行」都还对得上。
 */
function libPerRow(scope) {
  const items = [...scope.querySelectorAll(".lib-it:not(.lib-dir)")];
  if (items.length < 2) return 1;
  const top = items[0].offsetTop;
  let n = 0;
  for (const it of items) { if (it.offsetTop !== top) break; n++; }
  return Math.max(1, n);
}

/** 把右边那块预览板打开。见 .lib-page[data-prev] —— 关着的时候它是 display:none，
 *  光往里塞 innerHTML 是看不见的。选中文件的每条路（点一下、键盘翻、画廊自动选）都要过这儿。 */
function showLibPrev(page) {
  const box = page.querySelector(".lib-page");
  if (box) box.dataset.prev = "on";
}

async function renderLibPage() {
  const page = document.getElementById("assist-page");
  if (!page) return;
  if (!settingsCache) await refreshSettingsCache().catch(() => {});
  // 资料库是**整台服务器共用的一份**，谁往里放东西归平台管理员管；读是所有人的
  // （每个人的 agent 本来就带着 library_list / library_read，同样的内容它随口就念得出来）。
  const po = amPlatformOwner();
  const q = (libState.q || "").trim();
  // libState 是页面级的一份状态，别的入口（深链、老的调用点、测试）可能只塞了一半字段。
  // 在这儿兜一次底：认不出来的值一律退回默认，否则 mode=undefined 会让列表挂上
  // .as-undefined 这种谁也没写过样式的类名，整页就散了。
  if (!LIB_MODES.some((m) => m[0] === libState.mode)) libState.mode = "list";
  if (!LIB_GROUPS.some((g) => g[0] === libState.group)) libState.group = "none";
  if (libState.view !== "task") libState.view = "dir";
  // 四趟并发。产出索引（outputs）三种视图都要——不只是「按任务」那一栏：从文件夹里随手点开
  // 一个文件，右边也要说得出「这是哪次任务做的」。服务端按会话文件 mtime 增量缓存，
  // 多这一趟不会真去重解析几百个 JSON。
  const [lib, ws, out, found] = await Promise.all([
    fetch("/api/library?dir=" + encodeURIComponent(libState.dir || "")).then(r => r.json()).catch(() => ({ files: [], notes: [] })),
    fetch("/api/files").then(r => r.json()).catch(() => []),
    fetch("/api/library/outputs").then(r => r.json()).catch(() => ({ error: "读不到任务产出" })),
    q ? fetch("/api/library/search?q=" + encodeURIComponent(q)).then(r => r.json()).catch(() => ({ error: "搜不动了" })) : Promise.resolve(null),
  ]);
  // 服务端把越界/不存在的 dir 规整成了 ""，界面跟着回到根，否则面包屑指着一个进不去的地方
  libState.dir = (lib && typeof lib.dir === "string") ? lib.dir : "";
  // 接口回的是 { error } 而不是资料清单时别装作「还没有参考资料」——那是句瞎话，
  // 用户会当成自己没传过东西，而真相是这一趟根本没读成
  if (lib && lib.error) {
    page.innerHTML = `<div class="hub-empty">${ic("book-open-text")} 资料库<br><br>${esc(lib.error)}</div>`;
    return;
  }
  if (out && out.tasks) libOutCache = out;

  const libRow = (src, f, o) => libRowHtml(src, f, { q, ...(o || {}) });
  // 分组小标题。不分组时 label 是空串，这儿就什么都不画——调用方不用到处写 if
  const groupHead = (label, n) => label ? `<div class="sec lib-grp">${esc(label)} <span class="n">${n}</span></div>` : "";
  const groupedRows = (files, src, mk) => libGroupFiles(files)
    .map((g) => groupHead(g.label, g.items.length) + g.items.map((f) => libRow(src, f, mk ? mk(f) : undefined)).join("")).join("");
  // 文件夹行：点一下是「进去」，不是「选中预览」，所以单独一个类名，事件也分开接
  const folder = (f) => `
    <div class="lib-it lib-dir" data-dir="${esc(f.path)}" title="${esc(f.name)}">
      <span class="th">${ic("folder")}</span><span class="nm">${esc(f.name)}</span><span class="sz">${f.count || 0} 项</span><span class="tm"></span>
    </div>`;
  const crumbs = `<div class="lib-crumbs">
    <a href="#" data-dir="">${ic("book-open-text")}资料库</a>
    ${(lib.crumbs || []).map(c => `<span>/</span><a href="#" data-dir="${esc(c.path)}">${esc(c.name)}</a>`).join("")}
  </div>`;
  const recents = JSON.parse(localStorage.getItem("owb_lib_recent") || "[]");

  // ── 三种视图 ────────────────────────────────────────────────────────────
  // 「文件夹」= 东西放在哪；「按任务」= 东西是哪次做出来的。后者是用户原话点名要的
  //（「资料库那块按照任务看到产出吧」）——人记文件是按「上周让它写的那份周报」记的，
  // 不是按 out/2026-09/report-final-v3.md 记的。搜索一开口就接管整块列表，
  // 因为搜的时候「我现在在哪一层」已经不重要了。
  const libFiles = (lib.files || []).filter(f => libKindOk(f.name));
  const wsFiles = ws.filter(f => libKindOk(f.name)).slice(0, 120);
  let body = "";
  if (q) body = libSearchHtml(found, q, recents);
  else if (libState.view === "task") body = libTasksHtml(out);
  else body = `
    ${(lib.dirs || []).map(folder).join("")}
    ${libFiles.length
      ? groupedRows(libFiles, "lib", (f) => ({ full: f.path, label: f.name, dir: "" }))
      : ((lib.dirs || []).length ? "" : `<div class="lib-none">${libState.dir ? "这个文件夹还是空的" : "还没有参考资料"}</div>`)}
    <div class="sec">本地产物（当前项目）<span class="n">${wsFiles.length}</span></div>
    ${wsFiles.length ? groupedRows(wsFiles, "ws") : '<div class="lib-none">工作目录还没有成果文件</div>'}`;

  // 预览栏什么时候占位置：选了东西才占（列表/图标），画廊里永远占——它就是主角。
  // 画廊里还没选东西也照占：底下几行会替用户挑第一个，位置得先留出来。
  const prevOn = libState.mode === "gallery" || !!libState.pick;

  page.innerHTML = `
    <div class="lib-page" data-mode="${libState.mode}" data-prev="${prevOn ? "on" : "off"}">
      <div class="lib-side">
        <div class="hub-search">${ic("search")}<input id="lb-q" placeholder="搜文件名、正文、任务名…" value="${esc(libState.q)}">${q ? `<a href="#" id="lb-qx" class="lb-qx" title="清空搜索">${ic("x")}</a>` : ""}</div>
        <div class="lib-tabs" role="tablist">
          <button type="button" class="lib-tab ${libState.view === "dir" ? "on" : ""}" data-view="dir" role="tab" aria-selected="${libState.view === "dir"}">${ic("folder-tree")}文件夹</button>
          <button type="button" class="lib-tab ${libState.view === "task" ? "on" : ""}" data-view="task" role="tab" aria-selected="${libState.view === "task"}">${ic("sparkles")}按任务</button>
          <button type="button" class="lib-tab ${libState.pick && libState.pick.src === "notes" ? "on" : ""}" data-src="notes" role="tab" title="给助理留的长期备忘：不是文件，是几句话。每次任务它查资料库时都会连着读到" aria-selected="${!!(libState.pick && libState.pick.src === "notes")}">${ic("lightbulb")}笔记 ${(lib.notes || []).length || ""}</button>
        </div>
        <div class="lib-kinds">${LIB_KINDS.map(([k, label]) => `<button type="button" class="lib-kind ${(libState.kind || "all") === k ? "on" : ""}" data-kind="${k}">${esc(label)}</button>`).join("")}</div>
        <div class="lib-side-tip">${po ? "我的文档" : "共享资料"}${po ? "" : ` · <span title="资料库是整台服务器共用的一份，往里放东西归平台管理员">只读</span>`}<br>
          任务里 AI 也读得到这儿的资料（library_list / library_read）</div>
      </div>
      <div class="lib-main">
        <div class="lib-bar">
          ${q ? `<div class="lib-where">${ic("search")}搜「${esc(q)}」</div>`
            : libState.view === "task" ? `<div class="lib-where">${ic("sparkles")}按任务看产出</div>` : crumbs}
          <div class="lib-bar-acts">
            <div class="lib-seg" role="group" aria-label="分组方式">${LIB_GROUPS.map(([g, label]) =>
              `<button type="button" class="lib-gp ${(libState.group || "none") === g ? "on" : ""}" data-group="${g}" aria-pressed="${(libState.group || "none") === g}">${esc(label)}</button>`).join("")}</div>
            <div class="lib-seg" role="group" aria-label="显示方式">${LIB_MODES.map(([m, label, icon]) =>
              `<button type="button" class="lib-md ${libState.mode === m ? "on" : ""}" data-mode="${m}" title="${esc(label)}视图" aria-label="${esc(label)}视图" aria-pressed="${libState.mode === m}">${ic(icon)}</button>`).join("")}</div>
            ${po && !q && libState.view === "dir" ? `<a href="#" id="lb-mkdir" class="link">${ic("folder")}新建</a><a href="#" id="lb-up" class="link">${ic("plus")}上传</a><input type="file" id="lb-file" multiple style="display:none">` : ""}
          </div>
        </div>
        <div class="lib-list as-${libState.mode}">${body}</div>
      </div>
      <div class="lib-prev" id="lb-prev"><div class="ph">左边挑一个文件看内容<br><br>${ic("file-pen-line")} Markdown 直接排版 · ${ic("file-spreadsheet")} CSV 变表格 · ${ic("globe")} HTML 真渲染<br>画廊视图里按 ← → 一张张翻</div></div>
    </div>`;

  // 没选中东西的画廊是一整块空白——替用户挑第一个。访达的画廊视图也是这么干的。
  // 从渲染好的 DOM 里挑，不从 body 字符串里正则抠：三种视图拼出来的 HTML 长得不一样，
  // 正则抠第一个 data-name 早晚会抠到隔壁那个属性上去。
  if (libState.mode === "gallery" && !libState.pick) {
    const el0 = page.querySelector(".lib-it:not(.lib-dir)");
    if (el0) {
      libState.pick = { src: el0.dataset.src, name: el0.dataset.name, task: el0.dataset.task || "" };
      el0.classList.add("active");
    }
  }

  const qEl = page.querySelector("#lb-q");
  // 搜索要打到服务端（跨目录、翻正文），所以节流放宽到 260ms，并且重画后把光标和选区放回去，
  // 不然每敲一个字焦点就掉回页面，根本打不完一个词
  qEl.oninput = () => {
    libState.q = qEl.value;
    clearTimeout(page._t);
    page._t = setTimeout(async () => { const at = qEl.selectionStart; await renderLibPage(); const el2 = document.getElementById("lb-q"); if (el2) { el2.focus(); try { el2.setSelectionRange(at, at); } catch {} } }, 260);
  };
  const qx = page.querySelector("#lb-qx");
  if (qx) qx.onclick = (e) => { e.preventDefault(); libState.q = ""; renderLibPage(); };
  page.querySelectorAll(".lib-tab[data-view]").forEach(b => b.onclick = () => {
    libState.view = b.dataset.view;
    try { localStorage.setItem("owb_lib_view", libState.view); } catch {}
    renderLibPage();
  });
  const nb = page.querySelector('.lib-tab[data-src="notes"]');
  if (nb) nb.onclick = () => { libState.pick = { src: "notes", name: "" }; renderLibPage(); };
  page.querySelectorAll(".lib-kind").forEach(b => b.onclick = () => { libState.kind = b.dataset.kind; renderLibPage(); });
  // 摆法和分组都记到本地：这一页每个人的用法差很远——有人一直用列表找文档，有人一直用画廊过图
  page.querySelectorAll(".lib-md").forEach(b => b.onclick = () => {
    libState.mode = b.dataset.mode;
    try { localStorage.setItem("owb_lib_mode", libState.mode); } catch {}
    renderLibPage();
  });
  page.querySelectorAll(".lib-gp").forEach(b => b.onclick = () => {
    libState.group = b.dataset.group;
    try { localStorage.setItem("owb_lib_group", libState.group); } catch {}
    renderLibPage();
  });

  if (po && page.querySelector("#lb-up")) {
    page.querySelector("#lb-up").onclick = (e) => { e.preventDefault(); page.querySelector("#lb-file").click(); };
    page.querySelector("#lb-file").onchange = async (e) => {
      // 以前这儿不看返回值，一律 toast「✅ 已上传」——重名、超大、权限不够、磁盘满，
      // 全都报「成功」，然后列表里一个文件都没多。一句假的成功比一句失败更难查。
      let done = 0, err = "";
      for (const file of e.target.files) {
        const data_b64 = await new Promise((ok) => { const rd = new FileReader(); rd.onload = () => ok(rd.result.split(",")[1]); rd.readAsDataURL(file); });
        const r = await fetch("/api/library/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, dir: libState.dir || "", data_b64 }) })
          .then(x => x.json()).catch(() => ({ error: "网络异常" }));
        if (r && r.ok) done++; else err = err || `${file.name}：${(r && r.error) || "上传失败"}`;
      }
      toast(err ? err : `已上传 ${done} 个`, err ? "circle-x" : "circle-check");
      renderLibPage();
    };
  }
  // 面包屑和文件夹：往上跳 / 往下进。进去之前把选中的预览清掉，
  // 否则左边已经换了一层、右边还挂着上一层某个文件，看着像是没切成功
  page.querySelectorAll(".lib-crumbs a, .lib-dir").forEach(el => el.onclick = (e) => {
    e.preventDefault();
    libState.dir = el.dataset.dir || "";
    libState.pick = null;
    libState.view = "dir";
    renderLibPage();
  });
  if (po && page.querySelector("#lb-mkdir")) {
    page.querySelector("#lb-mkdir").onclick = async (e) => {
      e.preventDefault();
      const name = prompt(libState.dir ? `在「${libState.dir}」里新建文件夹，叫什么？` : "新建文件夹，叫什么？");
      if (!name || !name.trim()) return;
      const r = await fetch("/api/library/folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir: libState.dir || "", name: name.trim() }) })
        .then(x => x.json()).catch(() => ({ error: "网络异常" }));
      if (!r || !r.ok) return toast(((r && r.error) || "建不了"), "circle-x");
      renderLibPage();
    };
  }
  // 任务分组：标题那一行点开/收起，右边「打开对话」直接跳回产生它的那次对话。
  // 这是这一页跟「一张文件表格」最不一样的地方——产出和它的来历始终连着
  page.querySelectorAll(".lib-task-h").forEach(h => h.onclick = (e) => {
    if (e.target.closest("[data-open]")) return;
    const id = h.dataset.task;
    if (libTaskShut.has(id)) libTaskShut.delete(id); else libTaskShut.add(id);
    renderLibPage();
  });
  page.querySelectorAll("[data-gone-toggle]").forEach(a => a.onclick = (e) => {
    e.preventDefault();
    libState.gone = !libState.gone;
    try { localStorage.setItem("owb_lib_gone", libState.gone ? "on" : "off"); } catch {}
    renderLibPage();
  });
  page.querySelectorAll("[data-open]").forEach(a => a.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openSession(a.dataset.open, { turn: a.dataset.turn === undefined ? null : +a.dataset.turn });
  });
  page.querySelectorAll(".lib-it:not(.lib-dir)").forEach(el => el.onclick = () => {
    libState.pick = { src: el.dataset.src, name: el.dataset.name, task: el.dataset.task || "" };
    if (el.dataset.src !== "notes") {
      const rec = [{ src: el.dataset.src, name: el.dataset.name }, ...recents.filter(r => !(r.src === el.dataset.src && r.name === el.dataset.name))].slice(0, 8);
      localStorage.setItem("owb_lib_recent", JSON.stringify(rec));
    }
    page.querySelectorAll(".lib-it").forEach(x => x.classList.toggle("active", x === el));
    // 右栏是按需出现的：没选东西时 data-prev=off，CSS 那边直接 display:none（见 index.html
    // 里 .lib-page[data-prev="off"] .lib-prev）。这一行少了的后果是——点一个文件，内容
    // 确确实实渲染进 #lb-prev 了，只是那块板子还挂着 display:none，屏幕上什么都不发生。
    // 用户原话：「在资料库怎么没有办法打开文件啊！」。
    // 之所以一直没被发现：随便点一下筛选器就会走整页重画，那一路是照 libState.pick 算
    // data-prev 的，于是又能看了——看起来像「偶尔抽风」，其实是每次进这一页的第一下必挂。
    showLibPrev(page);
    renderLibPreview(page.querySelector("#lb-prev"), lib);
  });
  if (libState.pick) { showLibPrev(page); renderLibPreview(page.querySelector("#lb-prev"), lib); }

  // ← → ↑ ↓ 翻文件。画廊视图里这是主要的用法——过一批图的时候手不该在鼠标和键盘之间来回换。
  // 监听只能挂在 document 上（.lib-list 不 focus 就收不到键），所以每次重画都要把上一个摘掉，
  // 否则切几次视图就叠了一堆监听，按一下跳好几格。
  if (window.__libKey) document.removeEventListener("keydown", window.__libKey);
  window.__libKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const dir = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2 }[e.key];
    if (!dir) return;
    const pg = document.querySelector(".lib-page");
    // 页面已经换走了（去了别的 tab），自己摘干净——留着的话下一页按方向键会往一个不存在的列表里找
    if (!pg || !document.body.contains(pg)) { document.removeEventListener("keydown", window.__libKey); window.__libKey = null; return; }
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return; // 搜索框里方向键是移光标
    const items = [...pg.querySelectorAll(".lib-it:not(.lib-dir)")];
    if (!items.length) return;
    const at = items.findIndex((x) => x.classList.contains("active"));
    // 图标是网格，上下要跨一整行；列表是一条竖线，四个方向都只挪一格
    const per = libState.mode === "list" ? 1 : libPerRow(pg);
    const step = Math.abs(dir) === 2 ? (dir / 2) * per : dir;
    const to = at < 0 ? 0 : at + step;
    if (to < 0 || to >= items.length) return; // 到头就停住，不绕回去：绕回去的列表没人数得清自己在哪
    e.preventDefault();
    items[to].click();
    items[to].scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  document.addEventListener("keydown", window.__libKey);
}

/**
 * 「按任务」视图。一组 = 一次对话，组里是那次对话真正写出来的文件。
 *
 * 数据不是猜的：每跑完一批工具，服务端会往 transcript 里记一条 files 事件，
 * 里面的 changed 是认过主的那几个文件。这一页只是把那份记录倒过来读一遍。
 */
function libTasksHtml(data) {
  if (!data) return `<div class="lib-none">读取中…</div>`;
  if (data.error) return `<div class="lib-none">${esc(data.error)}</div>`;
  const all = (data.tasks || []).map((t) => ({ ...t, files: (t.files || []).filter((f) => libKindOk(f.name)) }));
  const nGone = all.reduce((n, t) => n + t.files.filter((f) => f.gone).length, 0);
  const tasks = (libState.gone ? all : all.map((t) => ({ ...t, files: t.files.filter((f) => !f.gone) }))).filter((t) => t.files.length);
  const orphans = (data.orphans || []).filter((f) => libKindOk(f.name));
  const group = (t) => {
    const shut = libTaskShut.has(t.id);
    return `<div class="lib-task">
      <div class="lib-task-h ${shut ? "shut" : ""}" data-task="${esc(t.id)}" role="button" tabindex="0" title="${esc(t.title)}">
        <span class="cv">${ic("chevron-down")}</span>
        <span class="tk">${ic("sparkles")}</span>
        <span class="nm">${esc(t.title)}</span>
        <span class="n">${t.files.length}</span>
        <span class="tm">${esc(libWhen(t.at))}</span>
        <a href="#" class="go" data-open="${esc(t.id)}" title="回到产生这些文件的那次对话">${ic("message-square")}</a>
      </div>
      ${shut ? "" : `<div class="lib-fs">${t.files.map((f) => libRowHtml("ws", f, {
        cls: "lib-sub", task: t.id, dir: "", note: f.gone ? "已不在" : undefined, jump: { id: t.id, turn: f.turn },
      })).join("")}</div>`}
    </div>`;
  };
  // 没了的那些不声不响地滤掉是不行的——用户会以为是这一页漏了。说清有多少、一点就能看
  const goneTip = !nGone ? "" : `<div class="lib-note-tip">${libState.gone
    ? `上面灰着的 ${nGone} 个已经不在工作目录里了，点开只会告诉你文件不存在。<a href="#" data-gone-toggle>收起来不看</a>`
    : `另有 ${nGone} 个产出已经不在工作目录里了（多半是任务跑完自己清掉的中间产物），默认不摆出来。<a href="#" data-gone-toggle>还是显示</a>`}</div>`;
  return `<div class="sec">按任务看产出 <span style="font-weight:400;color:var(--owb-text-3)">${tasks.length} 个任务</span></div>
    ${tasks.map(group).join("") || `<div class="lib-none">${nGone ? "这些任务产出的文件都已经不在工作目录里了。" : "还没有任务产出过文件。跑一个任务，它写出来的东西会自动归到这儿。"}</div>`}
    ${goneTip}
    ${orphans.length ? `<div class="sec">未归属 <span style="font-weight:400;color:var(--owb-text-3)">${data.orphan_total || orphans.length} 个</span></div>
      <div class="lib-note-tip">这些文件在工作目录里，但没有哪次任务认领过——多半是手动拷进来的，或者是更早的版本留下的。</div>
      <div class="lib-fs">${orphans.slice(0, 80).map((f) => libRowHtml("ws", f)).join("")}</div>` : ""}`;
}

/**
 * 搜索结果。四类来源分块列，每块都写明它是从哪儿搜出来的。
 *
 * 之所以要分来源：同一个词在「资料库里的一份合同」和「上周那次任务的产出」里出现，
 * 对用户是两件完全不同的事。混在一张列表里按相关度排，看起来聪明，用起来得挨个点开确认。
 */
function libSearchHtml(data, q, recents) {
  if (!data) return `<div class="lib-none">搜索中…</div>`;
  if (data.error) return `<div class="lib-none">${esc(data.error)}</div>`;
  const lib = (data.lib || []).filter((f) => libKindOk(f.name));
  const ws = (data.ws || []).filter((f) => libKindOk(f.name));
  const notes = data.notes || [];
  const tasks = data.tasks || [];
  const total = lib.length + ws.length + notes.length + tasks.length;
  if (!total) return `<div class="lib-none">没搜到「${esc(q)}」。<br>文件名、文件正文、任务名、灵感笔记都翻过了。${data.capped ? "<br>（这次正文没翻完，换个更短的词再试试）" : ""}</div>`;
  // 名字一列只放文件名本身、目录用小字挂在后面（工作区那边 name 是
  // 「任务_0916_xxx/配音文案.md」这样的相对路径，不切开的话目录会在一行里出现两遍）——
  // 这件事 libRowHtml 已经做好了。搜索这儿只多一样东西：命中的那几行正文。
  const fileRow = (src, f) => libRowHtml(src, f, { q })
    + ((f.lines || []).length ? `<div class="lib-hits">${f.lines.map((l) => `<div><em>${l.line}</em>${libMark(l.text, q)}</div>`).join("")}</div>` : "");
  return `
    ${tasks.length ? `<div class="sec">任务 <span style="font-weight:400;color:var(--owb-text-3)">${tasks.length}</span></div>
      ${tasks.map((t) => `<div class="lib-task">
        <div class="lib-task-h" data-task="${esc(t.id)}" role="button" tabindex="0" title="${esc(t.title)}">
          <span class="cv">${ic("chevron-down")}</span><span class="tk">${ic("sparkles")}</span>
          <span class="nm">${libMark(t.title, t.by === "title" ? q : "")}</span><span class="n">${(t.files || []).length}</span><span class="tm">${esc(libWhen(t.at))}</span>
          <a href="#" class="go" data-open="${esc(t.id)}" title="回到这次对话">${ic("message-square")}</a>
        </div>
        <div class="lib-fs">${(t.files || []).filter((f) => libKindOk(f.name) && (libState.gone || !f.gone)).map((f) => libRowHtml("ws", f, {
          cls: "lib-sub", task: t.id, dir: "", q, note: f.gone ? "已不在" : undefined, jump: { id: t.id, turn: f.turn },
        })).join("")}</div>
      </div>`).join("")}` : ""}
    ${lib.length ? `<div class="sec">资料库 <span style="font-weight:400;color:var(--owb-text-3)">${lib.length}</span></div>${lib.map((f) => fileRow("lib", f)).join("")}` : ""}
    ${ws.length ? `<div class="sec">本地产物 <span style="font-weight:400;color:var(--owb-text-3)">${ws.length}</span></div>${ws.map((f) => fileRow("ws", f)).join("")}` : ""}
    ${data.capped ? `<div class="lib-capped">${ic("circle-alert")}正文只翻了前 ${data.scanned || 0} 个文件就到预算上限了，下面可能还有没露面的。词写长一点、或者先用左边的类型筛一下。</div>` : ""}
    ${notes.length ? `<div class="sec">灵感笔记 <span style="font-weight:400;color:var(--owb-text-3)">${notes.length}</span></div>
      ${notes.map((n) => `<div class="lib-it" data-src="notes" data-name=""><span class="th">${ic("lightbulb")}</span><span class="nm" title="${esc(n.text)}">${libMark(String(n.text).slice(0, 80), q)}</span><span class="sz"></span><span class="tm"></span></div>`).join("")}` : ""}`;
}

async function renderLibPreview(prev, lib) {
  const { src, name } = libState.pick || {};
  if (!src) return;
  const po = amPlatformOwner(); // 记笔记、删笔记、删资料都是往这台服务器的共享区写，归平台管理员
  if (src === "notes") {
    prev.innerHTML = `
      <div style="font-weight:600;margin-bottom:4px">${ic("lightbulb")} 灵感笔记</div>
      <div style="font-size:12px;color:var(--owb-text-3);margin-bottom:10px;line-height:1.6">不是文件，是几句话。助理每次任务查资料库（library_list）时都会连着读到，所以适合放「我们公司简称叫 X」「配色一律用主色 #0F62FE」这种长期成立的事。</div>
      ${po ? `<div style="display:flex;gap:6px;margin-bottom:10px">
        <input id="lb-note" placeholder="随手记一条灵感/偏好，回车保存" style="flex:1">
        <button class="btn-brand" id="lb-note-save" style="flex:none">保存</button>
      </div>` : `<div style="font-size: 13px;color:var(--owb-text-3);margin-bottom:10px">这块是整台服务器共用的，归平台管理员记。<br>只想让助理记住你自己的事？去<a href="#" class="link" id="lb-to-mem">记忆</a>页，那儿记的只有你自己看得到。</div>`}
      <div>${(lib.notes || []).map(n =>
        `<div class="lib-note">${esc(n.text)}<div class="lm"><span>${esc((n.at || "").slice(0, 16).replace("T", " "))}</span>${po ? `<a href="#" class="link danger" data-nid="${esc(n.id)}">删除</a>` : ""}</div></div>`).join("")
        || '<div class="ph">还没有灵感笔记。<br>比如：「周报只要三段」「对外材料一律叫全称」——记一条，之后每次任务助理都会看到。</div>'}</div>`;
    if (!po) {
      const go = prev.querySelector("#lb-to-mem");
      if (go) go.onclick = (e) => { e.preventDefault(); openModal("settings", "memory"); };
      return;
    }
    const save = async () => {
      const el = prev.querySelector("#lb-note");
      const text = el.value.trim();
      if (!text) return;
      // 存不下就说为什么。以前不看返回值直接重画，笔记凭空消失，用户只能反复再记一遍
      const r = await fetch("/api/library/note", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) })
        .then(x => x.json()).catch(() => ({ error: "网络异常" }));
      if (!r || !r.ok) return toast(((r && r.error) || "没记下来"), "circle-x");
      renderLibPage();
    };
    prev.querySelector("#lb-note-save").onclick = save;
    prev.querySelector("#lb-note").onkeydown = (e) => { if (e.key === "Enter") save(); };
    prev.querySelectorAll("a[data-nid]").forEach(a => a.onclick = async (e) => {
      e.preventDefault();
      const r = await fetch("/api/library/note/" + encodeURIComponent(a.dataset.nid), { method: "DELETE" })
        .then(x => x.json()).catch(() => ({ error: "网络异常" }));
      if (!r || !r.ok) return toast(((r && r.error) || "删不掉"), "circle-x");
      renderLibPage();
    });
    return;
  }
  // 两边都用 fpath：资料库现在也有子目录了，整条路径 encodeURIComponent 一下斜杠会变 %2F，
  // 服务端的通配路由只认得真斜杠（这跟成果预览里图片全裂是同一个坑）
  const url = "/api/" + (src === "lib" ? "library/file/" : "files/view/") + fpath(name);
  // 「这份东西是哪次任务做出来的」。反查用的是同一份 files 事件记录，所以从文件夹视图里
  // 随手点开一个文件，也能顺着它走回那次对话——不只是「按任务」那一栏里点进来的才有。
  // 这一条是这一页跟一张普通文件表格最要紧的区别：产出和它的来历始终连着。
  const from = libTaskOf(src, name);
  const fromTurn = from ? libTurnOf(from, name) : null;
  const bar = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
    <b style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</b>
    <a class="link" href="${url}" ${src === "lib" ? "download" : 'target="_blank"'}>${src === "lib" ? "下载" : "新窗口打开"}</a>
    ${src === "lib" && po ? `<a class="link danger" href="#" id="lb-del">删除</a>` : ""}
  </div>
  ${from ? `<div class="lib-from">${ic("sparkles")}<span>出自任务</span><a href="#" class="link" data-open="${esc(from.id)}"${fromTurn == null ? "" : ` data-turn="${fromTurn}"`} title="${fromTurn == null ? "回到产生这份文件的那次对话" : "回到产生这份文件的那次对话，并停在写出它的那一段"}">${esc(from.title)}</a><em>${esc(libWhen(from.at))}</em>${fromTurn == null ? "" : `<span class="lib-from-at">第 ${fromTurn + 1} 轮</span>`}</div>` : ""}`;
  prev.innerHTML = bar + '<div class="ph">加载中…</div>';
  const body = prev.lastElementChild;
  const wireDel = () => {
    const d = prev.querySelector("#lb-del");
    if (d) d.onclick = async (e) => {
      e.preventDefault();
      if (!confirm(`删除资料「${name}」？`)) return;
      const r = await fetch("/api/library/file/" + fpath(name), { method: "DELETE" })
        .then(x => x.json()).catch(() => ({ error: "网络异常" }));
      if (!r || !r.ok) return toast(((r && r.error) || "删不掉"), "circle-x");
      libState.pick = null;
      renderLibPage();
    };
  };
  // 这一页最常见的失败是「名字还在，东西不在」：资料库列的是这次任务**产出过**什么，
  // 名单来自对话记录，而文件后来可能被挪走、被删，或者跟着另一个工作目录走了。
  // 以前这件事有三种长相，没有一种说得出到底怎么了——图裂成一个碎图标（<img> 出错浏览器不吭声）、
  // HTML 把服务端那句「文件不存在」当网页渲染成一片空白（fetch 没看 r.ok）、
  // 文本弹一句「预览失败：读取失败」。用户原话：「怎么点击图片没有办法预览了？」「点击md也是
  // 没法预览啊」「html也是」「在资料库里面预览功能这么差的啊」。
  const gonePh = `<div class="ph">这个文件已经不在工作目录里了。<br>资料库记的是这次任务产出过什么——名字来自对话记录，东西本身可能后来被挪走、被删，或者留在了另一个工作目录。<br>${
    from ? "上面那条「出自任务」能回到当时的对话，让助理照着再做一份。" : "让助理照着再做一份，或者去访达里找找它被挪到哪儿了。"
  }</div>`;
  const failPh = (why) => `<div class="ph">预览不了：${esc(why)}</div>`;
  // 只在出错时才问一句「是没了，还是读不出来」——顺利的那条路上一个多余的请求都不发
  const alive = () => fetch(url, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
  try {
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(name)) {
      body.outerHTML = `<img id="lb-img" src="${url}" style="max-width:100%;border-radius:8px">`;
      const img = prev.querySelector("#lb-img");
      if (img) img.onerror = async () => { img.outerHTML = (await alive()) ? failPh("这张图读不出来，文件可能是坏的") : gonePh; };
    } else if (/\.pdf$/i.test(name)) {
      // iframe 出错同样不通知外面：PDF 不在的时候，框里显示的是服务端那句「文件不存在」的纯文本
      body.outerHTML = (await alive()) ? `<iframe src="${url}"></iframe>` : gonePh;
    } else if (/\.(docx|xlsx|pptx|zip)$/i.test(name)) {
      // Word / Excel / PPT / zip 本质是一包 XML 的压缩档，浏览器自己打不开，得服务端先拆。
      // 用户原话：「做PPT，workd还有excel,csv这些格式预览要给我兼容，给我做好啊」——
      // 以前这一页没有这条路，同一份 .pptx 在对话里点得开、拖进资料库就变成一屏乱码。
      // 画法和样式都跟对话页那边共用同一套（docHtml / sheetHtml / slidesHtml / .ov-*），不抄第二份。
      const api = src === "lib" ? "/api/library/preview/" : "/api/files/preview/";
      const r = await fetch(api + fpath(name) + "?t=" + Date.now());
      if (r.status === 404) body.outerHTML = gonePh;
      else {
        const d = await r.json().catch(() => null);
        if (!d || d.error) body.outerHTML = failPh((d && d.error) || `服务端回了 HTTP ${r.status}`);
        else body.outerHTML = /\.docx$/i.test(name) ? docHtml(d)
          : /\.xlsx$/i.test(name) ? sheetHtml(d)
          : /\.pptx$/i.test(name) ? slidesHtml(d) : archiveHtml(d);
        // 一个 .xlsx 常常好几张表，标签点不动就只看得见第一张
        prev.querySelectorAll(".ov-tab").forEach((t) => { t.onclick = () => {
          prev.querySelectorAll(".ov-tab").forEach((x) => x.classList.toggle("on", x === t));
          prev.querySelectorAll(".ov-pane").forEach((pn) => { pn.hidden = pn.dataset.pane !== t.dataset.sheet; });
        }; });
      }
    } else if (/\.(doc|xls|ppt)$/i.test(name)) {
      // Office 97-2003 那三种是 OLE 二进制，不是压缩包，上面那条路拆不开。
      // 明说是格式的事、并给出一条能走通的路，比让它掉进「这个文件不是文本」强得多
      const ext = name.split(".").pop().toLowerCase();
      body.outerHTML = (await alive())
        ? `<div class="ph">这是 Office 97-2003 的老格式（.${esc(ext)}），里面是一包二进制记录，不是 .${esc(ext)}x 那样的压缩包，拆不出内容来。<br><br>用 Word / Excel / PowerPoint 或 WPS 打开，另存为 .${esc(ext)}x 再放回来，就能在这儿直接看。</div>`
        : gonePh;
    } else {
      const r = await fetch(url);
      if (r.status === 404) body.outerHTML = gonePh;
      else if (!r.ok) body.outerHTML = failPh(`服务端回了 HTTP ${r.status}`);
      else {
        const text = await r.text();
        // HTML 真渲染，而且不受下面那道 400KB 的闸限制（网页本来就容易几 MB，正是最该看长相的一类）。
        // sandbox 掐掉同源和弹窗：资料是外来的，不能让它碰应用本身
        if (/\.html?$/i.test(name)) {
          // 按宽度缩成整页，理由同工作区预览：1200 宽的卡片塞进这条窄栏，1:1 只能看见左上角一块。
          // 这里读不到 contentDocument（sandbox 没给 allow-same-origin，是故意的），所以往页面尾巴上
          // 挂一小段脚本让它自己把尺寸报出来——只进这个临时 blob，磁盘上那份文件一个字没动
          const blob = URL.createObjectURL(new Blob([text + PV_FIT_REPORTER], { type: "text/html" }));
          body.outerHTML = `<div class="pv-fit"><iframe src="${blob}" sandbox="allow-scripts" scrolling="no"></iframe><button type="button" class="pv-zoom" hidden></button></div>`;
          fitPreviewFrame(prev, { selfReport: true });
        } else if (text.length > 400000) body.outerHTML = '<div class="ph">文件太大，预览不动，请下载后本地打开</div>';
        // CSV/TSV 走跟对话页同一个 csvHtml：它按 RFC4180 认引号，还会自己判分隔符是逗号、
        // 分号还是制表符（欧洲导出的表用分号，.tsv 用制表符，按逗号拆会拆成一整列）
        else if (/\.(csv|tsv)$/i.test(name)) body.outerHTML = csvHtml(text, name);
        else if (/\.(md|markdown)$/i.test(name)) body.outerHTML = `<div class="md">${renderMd(text, "", false, "", { fileLinks: false })}</div>`;
        // fileLinks 关掉的理由：这一页的文件在资料库里（/api/library/…），而 renderMd 造的
        // 文件链接点开的是对话页右侧那个工作区预览面板——在资料库页上按下去，弹出来的是另一个
        // 地方的另一份东西。没接通之前，宁可让它保持现在这样当普通文字
        else body.outerHTML = `<pre class="raw">${esc(text)}</pre>`;
      }
    }
  } catch (e) {
    body.outerHTML = failPh(e.message);
  }
  wireDel();
  // 「出自任务」那条链接得在 innerHTML 重排之后再接一次事件（上面几条 outerHTML 会换掉节点）
  prev.querySelectorAll("[data-open]").forEach((a) => a.onclick = (e) => { e.preventDefault(); openSession(a.dataset.open, { turn: a.dataset.turn === undefined ? null : +a.dataset.turn }); });
}

// ================= 专家 · 技能 · 连接器（主区页面，三合一） =================
// 把原来分散在三个弹窗里的专家/技能/MCP 合成一页：左边挑 Tab，右边搜索，中间是卡片广场。
const hubState = { tab: "experts", sub: "expert", cat: "全部", q: "", mine: false, editing: null, mcpAdvice: null };
// 精选场景：点一下就带着写好的提示词开一条新任务。全是本地已具备的能力，不画饼。
const HUB_SCENES = [
  { icon: "file-spreadsheet", tt: "把 Excel 变成周报", dd: "读数据 → 算指标 → 生成带图表的周报文档", p: "把工作区里的数据文件读进来，算出核心指标的环比变化，生成一份带图表的周报（Word），结论写在最前面。" },
  { icon: "search", tt: "一个课题深挖到底", dd: "多轮检索取证 + 自我挑刺，出带来源的研究报告", p: "帮我深度研究「」这个课题：先拆成子问题，逐个联网查证并读原文，写完初稿后自己找一轮反面证据，最后输出带来源清单的研究报告。" },
  { icon: "palette", tt: "做一个能直接开的网页", dd: "先定视觉方向，单文件 HTML，做完自动自检", p: "做一个「」主题的单页网站：动笔前先用一句话说清这页的参照物和主色（别默认白底蓝标题），再写单文件 HTML，CSS/JS 内联不依赖外部资源，移动端优先，跟随系统深浅色（纯暗色风格就写死 color-scheme）。做完读回文件自查一遍再交付。" },
  { icon: "presentation", tt: "把材料做成 PPT", dd: "整理要点 → 排版 → 输出 16:9 演示文稿", p: "把工作区里的材料整理成一份 16:9 的 PPT：每页一个主题，标题写结论不写标签，数据页配图表。" },
  { icon: "scale", tt: "竞品横向对比", dd: "定维度 → 逐条查证 → 出对比表和差异化建议", p: "帮我对比「A / B / C」这几个产品：先定出对比维度，逐个联网查证填表（查不到写「未公开」不许猜），最后出对比表 + 我方该走的差异化路线。" },
  { icon: "notebook-pen", tt: "会议记录变纪要", dd: "提炼决议、待办（谁/做什么/什么时候）、待议项", p: "把我贴的这段会议记录整理成纪要：分「结论与决议」「待办（谁·做什么·何时前）」「待议」三段，原文没说的不许推断。" },
];
const HUB_TABS = [["experts", "专家"], ["skills", "技能"], ["mcp", "连接器"], ["plugins", "插件"]];
const fmtBytes = n => !n ? "—" : n < 1024 ? n + " B" : n < 1024 * 1024 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1) + " MB";

async function renderHubPage() {
  const page = document.getElementById("assist-page");
  if (!page) return;
  page.innerHTML = '<div class="hub-empty">加载中…</div>';
  // 专家、技能、插件、连接器都是**装在这台服务器上**的东西，一份大家共用：谁装、谁改、谁删归平台管理员，
  // 用（召唤 / 立即使用 / 看正文）是所有人的。所以先把身份拿到手，下面四个 Tab 照它决定画不画那排写的按钮。
  if (!settingsCache) await refreshSettingsCache().catch(() => {});
  const [experts, teams, skills] = await Promise.all([
    fetch("/api/experts").then(r => r.json()).catch(() => []),
    fetch("/api/expert-teams").then(r => r.json()).catch(() => []),
    fetch("/api/skills").then(r => r.json()).catch(() => []),
  ]);
  hubState._experts = experts; hubState._teams = teams; hubState._skills = skills;
  hubState._defaults = null; // 整页重载才丢缓存；搜索框敲字只走 renderHubBody，不重复打接口
  // 「只看我的」只在有真实依据的 Tab 上出现：专家有 builtin 标记、连接器有 connected 状态，技能两者都没有就不画。
  const mineLabel = { experts: "我创建的", mcp: "只看已连接" }[hubState.tab];
  const qHint = { experts: "搜索专家职称或描述", skills: "搜索技能", mcp: "搜索连接器", plugins: "搜索插件" }[hubState.tab];
  page.innerHTML = `
    <div class="hub-head">
      <div class="hub-tabs">${HUB_TABS.map(([k, n]) => `<button data-tab="${k}" class="${hubState.tab === k ? "active" : ""}">${n}</button>`).join("")}</div>
      <div class="hub-search">${ic("search")}<input id="hub-q" placeholder="${qHint}" value="${esc(hubState.q)}"></div>
      ${mineLabel ? `<button class="chip ${hubState.mine ? "active" : ""}" id="hub-mine">${mineLabel}</button>` : ""}
    </div>
    <div class="hub-desc">${{
      experts: "按行业分类浏览专家，召唤他们为你服务",
      skills: "技能是写给智能体看的操作说明书，装上就能用",
      mcp: "通过 MCP 给智能体接上外部系统和数据",
      plugins: "Agent Plugins 1.0.0 标准插件：一个包同时带技能和 MCP 连接器，装一次两样都进来",
    }[hubState.tab]}</div>
    <div id="hub-body"></div>`;
  page.querySelectorAll(".hub-tabs button").forEach(b => b.onclick = () => {
    hubState.tab = b.dataset.tab; hubState.cat = "全部"; hubState.mine = false; hubState.editing = null;
    renderHubPage();
  });
  const qi = page.querySelector("#hub-q");
  qi.oninput = () => { hubState.q = qi.value; renderHubBody(); };
  const mineBtn = page.querySelector("#hub-mine");
  if (mineBtn) mineBtn.onclick = () => { hubState.mine = !hubState.mine; renderHubPage(); };
  renderHubBody();
}

function renderHubBody() {
  const box = document.getElementById("hub-body");
  if (!box) return;
  if (hubState.tab === "experts") renderHubExperts(box);
  else if (hubState.tab === "skills") renderHubSkills(box);
  else if (hubState.tab === "plugins") renderHubPlugins(box);
  else renderHubMcp(box);
}

const hubMatch = (q, ...fields) => !q || fields.filter(Boolean).join(" ").toLowerCase().includes(q.trim().toLowerCase());

// ---- Tab 1：专家 / 专家团 ----
function renderHubExperts(box) {
  const { _experts: experts, _teams: teams, _skills: skills } = hubState;
  const po = amPlatformOwner();
  const cats = ["全部", ...new Set(experts.map(e => e.category || "未分类"))];
  const scenes = hubState.mine || hubState.q ? "" : `
    <div class="hub-sec-title">精选场景 <span class="sub">点一下带着写好的提示词开新任务</span></div>
    <div class="feat-scroll">${HUB_SCENES.map((s, i) =>
      `<div class="feat-card" data-scene="${i}"><div class="ic">${ic(s.icon)}</div><div class="tt">${esc(s.tt)}</div><div class="dd">${esc(s.dd)}</div><div class="go">用这个开始${ic("arrow-right")}</div></div>`).join("")}</div>`;
  box.innerHTML = scenes + `
    <div class="hub-bar">
      <div class="hub-sub">
        <button data-sub="expert" class="${hubState.sub === "expert" ? "active" : ""}">专家</button>
        <button data-sub="team" class="${hubState.sub === "team" ? "active" : ""}">专家团 <em class="beta">Beta</em></button>
      </div>
      ${hubState.sub === "expert" ? `<div class="hub-chips" style="margin-left:auto">${cats.map(c =>
        `<span class="chip ${hubState.cat === c ? "active" : ""}" data-cat="${esc(c)}">${esc(c)}</span>`).join("")}</div>` : ""}
    </div>
    <div id="hub-editor"></div>
    <div class="card-grid" id="hub-grid"></div>`;
  box.querySelectorAll(".feat-card").forEach(c => c.onclick = () => startTaskWith(HUB_SCENES[+c.dataset.scene].p));
  box.querySelectorAll(".hub-sub button").forEach(b => b.onclick = () => { hubState.sub = b.dataset.sub; hubState.editing = null; renderHubBody(); });
  box.querySelectorAll(".chip[data-cat]").forEach(c => c.onclick = () => { hubState.cat = c.dataset.cat; renderHubBody(); });

  const grid = box.querySelector("#hub-grid");
  if (hubState.sub === "team") {
    const list = teams.filter(t => hubMatch(hubState.q, t.name, t.description, t.members.join(" ")));
    grid.innerHTML =
      (po ? `<div class="ex-card add" id="team-add">${ic("plus")}创建专家团</div>` : "") +
      list.map((t, i) => `
        <div class="ex-card" data-ti="${i}">
          <div class="hd"><div class="av">${ava(t.avatar, "users")}</div><div class="nm"><span>${esc(t.name)}</span><span class="al">${t.members.length} 位成员</span></div></div>
          <div class="ds">${esc(t.description || "（无说明）")}</div>
          <div class="tg">${t.members.map((m, j) => `<i>${j + 1}. ${esc(m)}</i>`).join("")}</div>
          <div class="ops"><button class="primary t-use">整团召唤</button>${po ? `<button class="t-edit">修改</button><button class="t-del">解散</button>` : ""}</div>
        </div>`).join("") +
      (list.length ? "" : `<div class="hub-empty">${hubState.q ? `没有找到与「${esc(hubState.q)}」匹配的专家团` : "暂无专家团"}</div>`);
    const teamAdd = grid.querySelector("#team-add");
    if (teamAdd) teamAdd.onclick = () => { hubState.editing = { type: "team", data: null }; renderHubEditor(); };
    grid.querySelectorAll(".ex-card[data-ti]").forEach(card => {
      const t = list[+card.dataset.ti];
      card.querySelector(".t-use").onclick = () => { startTaskUsing("team", t.name); toast(`专家团「${t.name}」已就位，说说要做什么`); };
      if (!po) return;
      card.querySelector(".t-edit").onclick = () => { hubState.editing = { type: "team", data: t }; renderHubEditor(); };
      card.querySelector(".t-del").onclick = async () => {
        if (!confirm(`解散专家团「${t.name}」？（团里的专家本身不受影响）`)) return;
        // 以前这儿把返回值整个扔了，403 / 500 也照样重画一遍——那一条纹丝不动，
        // 用户只能得出「点了没反应」。删不掉就得说为什么。
        const resp = await fetch("/api/expert-teams/" + encodeURIComponent(t.name), { method: "DELETE" });
        if (!resp.ok) { const d = await resp.json().catch(() => ({})); return toast((d.error || "解散失败"), "circle-x"); }
        renderHubPage();
      };
    });
  } else {
    const list = experts.filter(e =>
      (hubState.cat === "全部" || (e.category || "未分类") === hubState.cat) &&
      (!hubState.mine || !e.builtin) &&
      hubMatch(hubState.q, e.name, e.alias, e.description, (e.tags || []).join(" ")));
    grid.innerHTML =
      (po ? `<div class="ex-card add" id="ex-add">${ic("plus")}创建专家<span class="add-sub">创建属于你的专家，分享专业知识</span></div>` : "") +
      list.map((e, i) => `
        <div class="ex-card" data-ei="${i}">
          ${e.builtin ? '<span class="flag">官方</span>' : ""}
          <div class="hd"><div class="av">${ava(e.avatar, "user")}</div>
            <div class="nm"><span>${esc(e.name)}</span>${e.alias ? `<span class="al">${esc(e.alias)}</span>` : ""}</div></div>
          <div class="ds">${esc(e.description || "（无说明）")}</div>
          <div class="tg">${(e.tags || []).map(t => `<i>${esc(t)}</i>`).join("")}${(e.skills || []).map(s => `<i>${ic("wrench")} ${esc(s)}</i>`).join("")}</div>
          <div class="ops"><button class="primary e-use">立即召唤</button>${po ? `<button class="e-edit">修改</button><button class="e-del">删除</button>` : ""}</div>
        </div>`).join("") +
      (list.length ? "" : `<div class="hub-empty">${
        hubState.mine ? "还没有创建任何专家" :
        hubState.q ? `没有找到与「${esc(hubState.q)}」匹配的专家，试试其他关键词` : "暂无该分类的专家"}</div>`) +
      (hubState.q && list.length ? `<div class="hub-count">搜索「${esc(hubState.q)}」找到 ${list.length} 位专家</div>` : "");
    const exAdd = grid.querySelector("#ex-add");
    if (exAdd) exAdd.onclick = () => { hubState.editing = { type: "expert", data: null }; renderHubEditor(); };
    grid.querySelectorAll(".ex-card[data-ei]").forEach(card => {
      const e = list[+card.dataset.ei];
      card.querySelector(".e-use").onclick = () => { startTaskUsing("expert", e.name); toast(`专家「${e.name}」已就位，说说要做什么`); };
      if (!po) return;
      card.querySelector(".e-edit").onclick = () => { hubState.editing = { type: "expert", data: e }; renderHubEditor(); };
      card.querySelector(".e-del").onclick = async () => {
        if (!confirm(`删除专家「${e.name}」？${e.builtin ? "（这是内置专家，删了可以从 experts.json 恢复）" : ""}`)) return;
        const resp = await fetch("/api/experts/" + encodeURIComponent(e.name), { method: "DELETE" });
        if (!resp.ok) { const d = await resp.json().catch(() => ({})); return toast((d.error || "删除失败"), "circle-x"); }
        renderHubPage();
      };
    });
  }
  renderHubEditor();
}

// ---- 专家 / 专家团 编辑器 ----
// 角色模板：从零写一份像样的角色设定是新建专家最大的门槛，选一个改改比空屏开写容易得多
const EXPERT_TEMPLATES = [
  { tt: "调研专员", alias: "查得深", avatar: "search", cat: "研究分析", desc: "行业/竞品/事实类调研，需要联网查证、多来源交叉核实时委派",
    tags: "行业调研，信息核实，来源分级", skills: ["deep-research"],
    sys: "你是一名严谨的调研专员。\n\n工作方式：\n1) 先列出要回答的 3-5 个关键问题，再动手搜\n2) 每个结论至少两个独立来源交叉验证，标注来源与日期\n3) 查不到就写查不到，给出下一步建议\n\n红线：不编造数据、链接和来源；转述与原文观点分开写。" },
  { tt: "数据分析师", alias: "算得清", avatar: "chart-column", cat: "研究分析", desc: "数据清洗、统计、出图表和 Excel 报表的活委派给它",
    tags: "数据清洗，统计分析，可视化", skills: ["data-viz", "excel-report"],
    sys: "你是一名数据分析师。\n\n工作方式：\n1) 先看清数据结构和口径，列出脏数据的处理规则\n2) 结论必须能从数据里复算出来，写明计算口径\n3) 图表配一句话结论，别让读者自己猜\n\n红线：样本太小或口径存疑时明说局限，不硬给结论。" },
  { tt: "文案主笔", alias: "笔头快", avatar: "pencil", cat: "内容创作", desc: "推文、文案、长文档的撰写和改写委派给它",
    tags: "公众号推文，长文写作，改写润色", skills: ["wechat-article", "docx"],
    sys: "你是一名文案主笔。\n\n工作方式：\n1) 动笔前先确认目标读者和这篇要达成什么\n2) 口语化、短句、多分段；每篇附一句话摘要和 3 个候选标题\n3) 改写保留原意，大改前列出改动点\n\n红线：不编造案例和数字；不用「赋能」「抓手」这类空话。" },
  { tt: "PPT 设计师", alias: "排得美", avatar: "presentation", cat: "办公文档", desc: "汇报、路演、课件类 PPT 的结构和制作委派给它",
    tags: "PPT 制作，版式设计，汇报结构", skills: ["ppt-design"],
    sys: "你是一名 PPT 设计师。\n\n工作方式：\n1) 先出页面大纲（每页一句话要点）确认结构再做\n2) 一页只讲一件事；标题写结论不写话题\n3) 对齐、就近、配色不超过 4 种、间距用 4 的倍数\n\n红线：内容页文字不超过 6 行；数据必须来自用户材料，不虚构。" },
];

function renderHubEditor() {
  const box = document.getElementById("hub-editor");
  if (!box) return;
  const ed = hubState.editing;
  if (!ed || (ed.type !== "expert" && ed.type !== "team")) { box.innerHTML = ""; return; }
  const { _experts: experts, _skills: skills } = hubState;
  if (ed.type === "expert") {
    const x = ed.data || {};
    box.innerHTML = `
      <div class="ex-editor">
        <div class="hub-sec-title" style="display:flex;align-items:center;gap:10px">${x.name ? `编辑专家「${esc(x.name)}」` : "新建专家"} <span class="sub" style="flex:1">专家 = 头像 + 说明 + 绑定技能 + 默认提示词 的智能体</span>
          <select id="ef-tpl" style="width:auto;font-size: 13px;padding:4px 8px"><option value="">从角色模板起稿…</option>${EXPERT_TEMPLATES.map((t, i) => `<option value="${i}">${esc(t.tt)}</option>`).join("")}</select></div>
        <div class="row">
          <div style="flex:0 0 90px"><label>头像</label><div class="ava-prev" id="ef-ava-prev">${ava(x.avatar, "user")}</div><input type="hidden" id="ef-avatar" value="${esc(x.avatar || "user")}"></div>
          <div style="flex:1 1 160px"><label>名字 <span class="lh">委派时点名用 · <span id="ef-ncnt">${(x.name || "").length}</span>/20</span></label><input id="ef-name" maxlength="20" value="${esc(x.name || "")}" placeholder="如 调研专员"></div>
          <div style="flex:1 1 120px"><label>花名 <span class="lh">可空</span></label><input id="ef-alias" value="${esc(x.alias || "")}" placeholder="如 查得深"></div>
          <div style="flex:1 1 120px"><label>分类</label><input id="ef-cat" value="${esc(x.category || "")}" placeholder="如 研究分析" list="ef-cats">
            <datalist id="ef-cats">${[...new Set(experts.map(e => e.category))].map(c => `<option value="${esc(c)}">`).join("")}</datalist></div>
        </div>
        <div class="row"><div style="flex:1"><label>挑个图标</label><div id="ef-ava-presets" class="ava-grid">${avaPicks(x.avatar || "user")}</div></div></div>
        <div class="row">
          <div style="flex:2 1 260px"><label>一句话说明 <span class="lh">协调者据此决定什么活派给它</span></label>
            <input id="ef-desc" value="${esc(x.description || "")}" placeholder="擅长什么、什么时候该委派给它"></div>
          <div style="flex:1 1 180px"><label>能力标签 <span class="lh">逗号分隔，只用于展示和搜索</span></label>
            <input id="ef-tags" value="${esc((x.tags || []).join("，"))}" placeholder="行业调研，信息核实"></div>
        </div>
        <div class="row"><div style="flex:1"><label>绑定技能 <span class="lh">干活前会提示它先加载这些技能包，别全勾——勾多了等于没重点</span></label>
          <div class="sk-pick" id="ef-skills">${skills.map(s =>
            `<label class="${(x.skills || []).includes(s.name) ? "on" : ""}" title="${esc(s.description || "")}"><input type="checkbox" value="${esc(s.name)}" ${(x.skills || []).includes(s.name) ? "checked" : ""}>${esc(s.name)}</label>`).join("") || '<span class="ab-empty">还没有技能，去「技能」页装一个</span>'}</div></div></div>
        <div class="row"><div style="flex:1"><label>默认提示词 <span class="lh">真正喂给这个智能体的角色设定：角色一句话 + 工作方式清单 + 红线</span></label>
          <textarea id="ef-sys" rows="8" placeholder="你是一名…&#10;&#10;工作方式：&#10;1) …&#10;&#10;红线：不编造数据和来源。">${esc(x.system || "")}</textarea></div></div>
        <div style="display:flex;gap:8px"><button class="btn-brand" id="ef-save">保存</button>
          <button id="ef-cancel" style="padding:6px 14px">取消</button>
          <span class="ab-empty" style="margin-left:auto">保存即生效，不用重启</span></div>
      </div>`;
    box.querySelectorAll("#ef-skills label").forEach(l => l.onclick = () => setTimeout(() => l.classList.toggle("on", l.querySelector("input").checked), 0));
    const efAva = (name) => {
      box.querySelector("#ef-avatar").value = name;
      box.querySelector("#ef-ava-prev").innerHTML = ava(name, "user");
      box.querySelectorAll("#ef-ava-presets .ava-pick").forEach(b => b.classList.toggle("on", b.dataset.e === name));
    };
    box.querySelector("#ef-ava-presets").onclick = (ev) => {
      const pk = ev.target.closest(".ava-pick");
      if (pk) efAva(pk.dataset.e);
    };
    box.querySelector("#ef-name").oninput = (ev) => { box.querySelector("#ef-ncnt").textContent = ev.target.value.length; };
    box.querySelector("#ef-tpl").onchange = (ev) => {
      const t = EXPERT_TEMPLATES[+ev.target.value];
      if (!t) return;
      const set = (id, v) => { box.querySelector("#" + id).value = v; };
      // 名字空着才填（编辑已有专家时别把名字顶掉）；说明/标签/提示词按模板覆盖
      if (!box.querySelector("#ef-name").value.trim()) { set("ef-name", t.tt); box.querySelector("#ef-ncnt").textContent = t.tt.length; }
      if (!box.querySelector("#ef-alias").value.trim()) set("ef-alias", t.alias);
      efAva(t.avatar); set("ef-cat", t.cat); set("ef-desc", t.desc); set("ef-tags", t.tags); set("ef-sys", t.sys);
      box.querySelectorAll("#ef-skills label").forEach(l => {
        const inp = l.querySelector("input");
        if (!inp) return;
        inp.checked = t.skills.includes(inp.value);
        l.classList.toggle("on", inp.checked);
      });
      toast(`已按「${t.tt}」模板起稿，改成你要的样子再保存`);
    };
    box.querySelector("#ef-cancel").onclick = () => { hubState.editing = null; renderHubEditor(); };
    box.querySelector("#ef-save").onclick = async () => {
      const g = (id) => box.querySelector("#" + id).value.trim();
      const body = {
        name: g("ef-name"), alias: g("ef-alias"), avatar: g("ef-avatar"), category: g("ef-cat"),
        description: g("ef-desc"),
        tags: g("ef-tags").split(/[，,]/).map(s => s.trim()).filter(Boolean),
        skills: [...box.querySelectorAll("#ef-skills input:checked")].map(i => i.value),
        system: box.querySelector("#ef-sys").value.trim(),
        original_name: x.name || undefined,
      };
      const resp = await fetch("/api/experts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok) return toast((d.error || "保存失败"), "circle-x");
      hubState.editing = null;
      toast("专家已保存，立即生效");
      renderHubPage();
    };
  } else {
    const t = ed.data || {};
    const picked = t.members || [];
    box.innerHTML = `
      <div class="ex-editor">
        <div class="hub-sec-title">${t.name ? `编辑专家团「${esc(t.name)}」` : "组建专家团"} <span class="sub">一支按顺序接力的智能体团队：后一位能看到前一位的汇报和产出文件</span></div>
        <div class="row">
          <div style="flex:0 0 90px"><label>头像</label><div class="ava-prev" id="tf-ava-prev">${ava(t.avatar, "users")}</div><input type="hidden" id="tf-avatar" value="${esc(t.avatar || "users")}"></div>
          <div style="flex:1"><label>团队名称</label><input id="tf-name" value="${esc(t.name || "")}" placeholder="如 汇报三件套"></div>
        </div>
        <div class="row"><div style="flex:1"><label>挑个图标</label><div id="tf-ava-presets" class="ava-grid">${avaPicks(t.avatar || "users")}</div></div></div>
        <div class="row"><div style="flex:1"><label>说明（协调者据此决定什么活整团派）</label>
          <input id="tf-desc" value="${esc(t.description || "")}" placeholder="这个团适合干什么"></div></div>
        <div class="row"><div style="flex:1"><label>成员与顺序（至少 2 位；点击加入，再点移除。列表顺序＝执行顺序）</label>
          <div class="sk-pick" id="tf-pool">${experts.map(e =>
            `<label class="${picked.includes(e.name) ? "on" : ""}" data-n="${esc(e.name)}">${ava(e.avatar, "user")} ${esc(e.name)}</label>`).join("")}</div>
          <div id="tf-order" style="margin-top:10px;font-size: 14px"></div></div></div>
        <div style="display:flex;gap:8px"><button class="btn-brand" id="tf-save">保存</button>
          <button id="tf-cancel" style="padding:6px 14px">取消</button></div>
      </div>`;
    const order = [...picked];
    const drawOrder = () => {
      const el = box.querySelector("#tf-order");
      el.innerHTML = order.length
        ? `执行顺序：` + order.map((n, i) =>
            `<span class="chip active" style="margin:0 4px 4px 0;display:inline-flex;gap:6px;align-items:center">${i + 1}. ${esc(n)}` +
            `<a href="#" data-up="${i}" class="icon-btn" title="前移">${ic("arrow-up")}</a><a href="#" data-rm="${i}" class="icon-btn" title="移除">${ic("x")}</a></span>`).join("")
        : '<span class="ab-empty">还没选成员</span>';
      el.querySelectorAll("a[data-up]").forEach(a => a.onclick = (ev) => {
        ev.preventDefault();
        const i = +a.dataset.up;
        if (i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; drawOrder(); }
      });
      el.querySelectorAll("a[data-rm]").forEach(a => a.onclick = (ev) => {
        ev.preventDefault();
        const n = order.splice(+a.dataset.rm, 1)[0];
        box.querySelector(`#tf-pool label[data-n="${CSS.escape(n)}"]`)?.classList.remove("on");
        drawOrder();
      });
    };
    drawOrder();
    box.querySelectorAll("#tf-pool label").forEach(l => l.onclick = () => {
      const n = l.dataset.n;
      const i = order.indexOf(n);
      if (i >= 0) { order.splice(i, 1); l.classList.remove("on"); }
      else { order.push(n); l.classList.add("on"); }
      drawOrder();
    });
    box.querySelector("#tf-ava-presets").onclick = (ev) => {
      const pk = ev.target.closest(".ava-pick");
      if (!pk) return;
      box.querySelector("#tf-avatar").value = pk.dataset.e;
      box.querySelector("#tf-ava-prev").innerHTML = ava(pk.dataset.e, "users");
      box.querySelectorAll("#tf-ava-presets .ava-pick").forEach(b => b.classList.toggle("on", b === pk));
    };
    box.querySelector("#tf-cancel").onclick = () => { hubState.editing = null; renderHubEditor(); };
    box.querySelector("#tf-save").onclick = async () => {
      const body = {
        name: box.querySelector("#tf-name").value.trim(),
        avatar: box.querySelector("#tf-avatar").value.trim(),
        description: box.querySelector("#tf-desc").value.trim(),
        members: order,
        original_name: t.name || undefined,
      };
      const resp = await fetch("/api/expert-teams", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok) return toast((d.error || "保存失败"), "circle-x");
      hubState.editing = null;
      toast("专家团已保存，立即生效");
      renderHubPage();
    };
  }
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/**
 * 从 SKILL.md 正文里挖出几个「这技能到底能替我做什么」的具体例子。
 *
 * 起因是用户点了「立即使用」，输入框里只多了一句「用「xiaohongshu-topic」技能帮我：」，
 * 原话是「都没什么特殊点格式啊」——等于把空白页原样还给了用户。
 * 技能作者基本都会写「## 适用场景」，里头那些「…」引号短句本身就是现成的任务描述，直接拿来当例子。
 * 挖不到就退回条目文字；再挖不到就只给占位模板，至少让人知道该往哪儿写。
 */
function skillExamples(md) {
  const body = String(md || "").replace(/^---[\s\S]*?\n---\n/, ""); // 前言里的 description 是给模型看的，不当例子
  // 只从「适用场景」那一节里挖。试过退回全文前 1200 字，挖出来的是 #b0aea5、pptxgenjs、app_id
  // 这类代码片段——技能说明书里带引号的东西大多是配置和字段名，不是任务。宁可一条不给。
  // 不加 m 标志：加了的话 $ 表示「行尾」，配上懒惰量词，这一节只截到第一行就收工了
  const sec = /(?:^|\n)#{1,4}[ \t]*(?:适用场景|使用场景|什么时候用|何时使用|when to use)[^\n]*\n([\s\S]*?)(?=\n#{1,4}[ \t]|$)/i.exec(body);
  if (!sec) return [];
  const seg = sec[1];
  const out = [];
  const push = (t) => {
    t = String(t).replace(/\*\*/g, "").replace(/`/g, "").replace(/^[-*\d.、）)\s]+/, "")
      .replace(/[（(][^）)]*[）)]/g, "")            // 括号里的补充说明拿掉，别把一句话拦腰截断
      .replace(/[，。；、,.;:：]+$/, "").trim();
    if (t.length < 4 || t.length > 40 || out.includes(t)) return;
    if (/[=_`{}<>#\\|]|https?:/.test(t)) return;          // 看着像代码/配置/链接的一律不要
    if (!/[\u4e00-\u9fa5]{3,}/.test(t) && t.split(/\s+/).length < 3) return; // 光秃秃一个英文单词也不是任务
    out.push(t);
  };
  for (const m of seg.matchAll(/[「“"]([^」”"\n]{4,40})[」”"]/g)) push(m[1]);
  if (out.length < 3) for (const line of seg.split("\n")) {
    const m = /^\s*[-*]\s+(.+)$/.exec(line);
    if (m) push(m[1]);
  }
  // 有的作者把适用场景写成一句话，用顿号串起来（「写公众号文章、把已有 Markdown 排版成…」）——按顿号拆开就是几件事
  if (!out.length) for (const part of seg.replace(/\n/g, "").split(/[、；;]/)) push(part);
  return out.slice(0, 4);
}

// ---- Tab 2：技能（技能包＝可热装的能力说明书） ----
async function renderHubSkills(box) {
  const list = hubState._skills.filter(s => hubMatch(hubState.q, s.name, s.description));
  // 技能装在这台服务器的 skills/ 目录里，一份大家共用：装/改/删归平台管理员，用是所有人的。
  // 「推荐技能」和「从 GitHub 安装」对普通成员整节都不画——那是一排他点了只会得到 403 的按钮，
  // 摆在那儿只是在推销他买不到的东西。
  const po = amPlatformOwner();
  // 推荐技能只在首次进来时拉一次，之后放缓存里 —— 搜索框每敲一下都重绘 body，不该每次都打一趟接口
  if (po && !hubState._defaults) {
    hubState._defaults = await fetch("/api/skills/defaults/list").then(r => r.json()).catch(() => []);
  }
  const defs = (hubState._defaults || []).filter(s => hubMatch(hubState.q, s.name, s.title, s.why, s.author));
  const missing = (hubState._defaults || []).filter(s => !s.installed);
  box.innerHTML = `
    ${po ? `<div class="ex-editor hub-install-box">
      <div class="hub-sec-title">${ic("download")} 从 GitHub 安装 <span class="sub">支持整仓库、tree 子目录、blob 单文件和 raw 直链；安装后立即生效</span></div>
      <div class="row"><input id="sk-url" placeholder="粘贴 GitHub 技能地址，例如 anthropics/skills/tree/main/skills/docx" style="flex:1">
        <button class="btn-brand" id="sk-install" style="flex:none">安装</button></div>
      <div id="sk-install-msg" class="ab-empty" style="margin-top:6px"></div>
    </div>` : ""}
    <div id="hub-editor"></div>
    <div class="hub-sec-title" style="margin-top:14px">${po ? "已安装技能" : "可用技能"} <span class="sub">${
      po ? "本机 skills/ 目录与插件带入的能力" : "这台服务器已经装好的能力；装新技能归平台管理员"}</span></div>
    <div class="card-grid" id="hub-grid">
      ${po ? `<div class="ex-card add" id="sk-add">${ic("plus")}添加技能<span class="add-sub">手写一份操作说明书，保存立即生效</span></div>` : ""}
      ${list.map((s, i) => `
        <div class="ex-card" data-si="${i}">
          ${s.plugin ? `<span class="flag">插件</span>` : ""}
          <div class="hd"><div class="av">${ic(s.plugin ? "puzzle" : "wrench")}</div><div class="nm"><span>${esc(s.name)}</span>${
            s.plugin ? `<span class="al">来自插件 ${esc(s.plugin)}</span>` : ""}</div></div>
          <div class="ds">${esc(s.description || "（无描述）")}</div>
          <div class="ops"><button class="primary sk-use">立即使用</button><button class="sk-view">正文</button>${
            s.plugin || !po ? "" : '<button class="sk-edit">修改</button><button class="sk-del">删除</button>'}</div>
          <div class="sk-start" style="display:none"></div>
          <pre class="sk-preview" style="display:none"></pre>
        </div>`).join("")}
      ${list.length ? "" : `<div class="hub-empty">${hubState.q ? `没有找到与「${esc(hubState.q)}」匹配的技能` : "暂无技能"}</div>`}
    </div>
    ${defs.length ? `
    <div class="hub-sec-title" style="margin-top:14px">${ic("sparkles")} 推荐技能
      <span class="sub">不随本项目打包，点一下从上游仓库现取（只下这一个子目录，不拖整仓）。协议与作者都写在卡片上，装谁的东西自己心里有数</span>
      ${missing.length ? `<button class="btn-brand" id="sk-def-all" style="float:right;padding:4px 12px;font-size: 13px">一键装齐缺的 ${missing.length} 个</button>` : ""}</div>
    <div class="card-grid">
      ${defs.map((s, i) => `
        <div class="ex-card" data-di="${i}">
          ${s.installed ? '<span class="flag">已安装</span>' : ""}
          <div class="hd"><div class="av">${ic("sparkles")} </div><div class="nm"><span>${esc(s.title)}</span><span class="al">${esc(s.name)}</span></div></div>
          <div class="ds">${esc(s.why)}</div>
          <div class="tg"><i>${ic("scroll-text")} ${esc(s.license)}</i><i>${ic("user")} ${esc(s.author)}</i><i>${ic("save")} ${fmtBytes(s.installed ? s.installed_bytes : s.bytes)}</i></div>
          <div class="ds" style="font-size: 12px"><a href="${esc(s.url)}" target="_blank" rel="noreferrer" style="word-break:break-all">${esc(s.repo)}/${esc(s.subpath)}</a></div>
          <div class="ops">${s.installed
            ? '<button class="sk-def-reinstall">重新下载</button>'
            : '<button class="primary sk-def-install">安装</button>'}</div>
          <div class="ab-empty sk-def-msg" style="margin-top:4px"></div>
        </div>`).join("")}
    </div>` : ""}`;

  // 推荐技能：装一个 / 装齐缺的。装完刷新缓存再重绘，卡片上的「已安装」和真实体积才对得上。
  const installDefaults = async (names, msgEl, btn, force) => {
    const label = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "下载中…"; }
    if (msgEl) msgEl.textContent = "正在从上游仓库下载…（首次要十几秒）";
    try {
      const resp = await fetch("/api/skills/defaults/install", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ names, force: !!force }),
      });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(d.error || "安装失败");
      const failed = (d.results || []).filter(r => r.status === "failed");
      const skipped = (d.results || []).flatMap(r => r.skipped || []);
      if (failed.length) toast(`${failed.length} 个没装上：${failed.map(f => f.name + "（" + f.error + "）").join("；")}`);
      else toast(`已装好 ${(d.results || []).length} 个技能，立即可用`);
      // 超大文件被跳过必须说出来，不然技能跑一半报「文件不存在」谁也想不到是装的时候吞了
      if (skipped.length) toast(`注意：${skipped.length} 个超大文件没下载（${skipped.slice(0, 3).map(s => s.path).join("、")}），用到时可能会缺资源`);
      hubState._defaults = null;
      renderHubPage();
    } catch (e) {
      if (msgEl) setMsg(msgEl, "circle-x", e.message, "err");
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  };
  const allBtn = box.querySelector("#sk-def-all");
  if (allBtn) allBtn.onclick = () => installDefaults(missing.map(s => s.name), null, allBtn);
  box.querySelectorAll(".ex-card[data-di]").forEach(card => {
    const s = defs[+card.dataset.di];
    const btn = card.querySelector(".sk-def-install") || card.querySelector(".sk-def-reinstall");
    if (btn) btn.onclick = () => installDefaults([s.name], card.querySelector(".sk-def-msg"), btn, s.installed);
  });

  const skAdd = box.querySelector("#sk-add");
  if (skAdd) skAdd.onclick = () => { hubState.editing = { type: "skill", data: null }; renderHubSkillEditor(); };
  const skInstall = box.querySelector("#sk-install");
  if (skInstall) skInstall.onclick = async () => {
    const url = box.querySelector("#sk-url").value.trim();
    const msg = box.querySelector("#sk-install-msg");
    if (!url) return;
    const go = async (extra) => {
      setMsg(msg, "loader-circle", "安装中…（整仓库首次下载可能要十几秒）");
      const resp = await fetch("/api/skills/install", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, ...extra }) });
      const d = await resp.json().catch(() => ({}));
      if (resp.ok) {
        setMsg(msg, "circle-check", `已安装 ${d.installed.length} 个：${d.installed.map(s => s.name).join("、")}`, "ok");
        setTimeout(renderHubPage, 1000);
        return;
      }
      if (d.needs) return showScanGate(msg, d, go);   // 体检没过：把清单摊开，让人自己判
      setMsg(msg, "circle-x", d.error || "安装失败", "err");
    };
    go({}).catch(e => setMsg(msg, "circle-x", e.message, "err"));
  };
  box.querySelectorAll(".ex-card[data-si]").forEach(card => {
    const s = list[+card.dataset.si];
    // 「立即使用」不再只往输入框丢半句话：先把这技能能干的几件事摆出来，挑一件就带着格式进任务框
    card.querySelector(".sk-use").onclick = async () => {
      const panel = card.querySelector(".sk-start");
      if (panel.style.display !== "none") { panel.style.display = "none"; return; }
      panel.style.display = "";
      panel.innerHTML = '<div class="sk-start-hint">正在读这份说明书…</div>';
      if (s._md === undefined) {
        s._md = await fetch("/api/skills/" + encodeURIComponent(s.name))
          .then(r => r.json()).then(d => d.content || "").catch(() => "");
      }
      const eg = skillExamples(s._md);
      panel.innerHTML =
        `<div class="sk-start-hint">${eg.length ? "挑一件最像你要做的事，下一步再补素材：" : "这份说明书没写「适用场景」，先照这个格式说清你要什么："}</div>` +
        (eg.length ? `<div class="sk-eg">${eg.map((t, i) => `<button class="chip" data-i="${i}">${esc(t)}</button>`).join("")}</div>` : "") +
        `<button class="sk-own">我自己写一句${ic("arrow-right")}</button>`;
      panel.querySelectorAll(".chip").forEach(b => b.onclick = () => startTaskUsing("skill", s.name,
        `${eg[+b.dataset.i]}\n\n__把素材和背景贴在这一行：要做的是什么、给谁看、手上已经有的内容__`));
      panel.querySelector(".sk-own").onclick = () => startTaskUsing("skill", s.name,
        `__一句话说清你要它做出什么__\n\n素材/背景：`);
    };
    card.querySelector(".sk-view").onclick = async () => {
      const pre = card.querySelector(".sk-preview");
      if (pre.style.display !== "none") { pre.style.display = "none"; return; }
      const d = await fetch("/api/skills/" + encodeURIComponent(s.name)).then(r => r.json()).catch(() => null);
      pre.textContent = d ? d.content : "加载失败";
      pre.style.display = "";
    };
    // 插件带来的技能归插件所有，卡片上根本不画改/删按钮 —— 要动就去「插件」页卸载整个插件
    const edit = card.querySelector(".sk-edit");
    if (edit) edit.onclick = async () => {
      const d = await fetch("/api/skills/" + encodeURIComponent(s.name)).then(r => r.json()).catch(() => null);
      if (!d) return toast("加载失败", "circle-x");
      hubState.editing = { type: "skill", data: d };
      renderHubSkillEditor();
    };
    const del = card.querySelector(".sk-del");
    if (del) del.onclick = async () => {
      if (!confirm(`删除技能「${s.name}」？（会删掉整个技能目录）`)) return;
      const resp = await fetch("/api/skills/" + encodeURIComponent(s.name), { method: "DELETE" });
      if (!resp.ok) { const d = await resp.json().catch(() => ({})); return toast((d.error || "删除失败"), "circle-x"); }
      renderHubPage();
    };
  });
  renderHubSkillEditor();
}

function renderHubSkillEditor() {
  const box = document.getElementById("hub-editor");
  if (!box) return;
  const ed = hubState.editing;
  if (!ed || ed.type !== "skill") { box.innerHTML = ""; return; }
  const x = ed.data || {};
  box.innerHTML = `
    <div class="ex-editor">
      <div class="hub-sec-title">${x.name ? `编辑技能「${esc(x.name)}」` : "手写一个技能"} <span class="sub">技能＝写给智能体看的操作说明书，它按需加载</span></div>
      <div class="row"><div style="flex:1 1 200px"><label>技能名</label><input id="skf-name" value="${esc(x.name || "")}" placeholder="如 feishu-doc"></div>
        <div style="flex:2 1 300px"><label>一句话描述（AI 据此判断什么任务该用它）</label><input id="skf-desc" value="${esc(x.description || "")}"></div></div>
      <div class="row"><div style="flex:1"><label>正文（Markdown：步骤、代码示例、注意事项）</label>
        <textarea id="skf-content" rows="14" style="font-family:var(--mono,ui-monospace,monospace);font-size: 13px">${esc(x.content || "")}</textarea></div></div>
      <div style="display:flex;gap:8px"><button class="btn-brand" id="skf-save">保存</button>
        <button id="skf-cancel" style="padding:6px 14px">取消</button></div>
    </div>`;
  box.querySelector("#skf-cancel").onclick = () => { hubState.editing = null; renderHubSkillEditor(); };
  // 保存失败的话要有地方摊开体检清单——toast 那一行塞不下文件名和行号
  const skfMsg = document.createElement("div");
  skfMsg.className = "sk-install-msg";
  box.querySelector(".ex-editor").appendChild(skfMsg);
  box.querySelector("#skf-save").onclick = async () => {
    const save = async (extra) => {
      const resp = await fetch("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: box.querySelector("#skf-name").value.trim(),
          description: box.querySelector("#skf-desc").value.trim(),
          content: box.querySelector("#skf-content").value,
          original_name: x.name || undefined,
          ...extra,
        }) });
      const d = await resp.json().catch(() => ({}));
      if (resp.ok) {
        hubState.editing = null;
        toast("技能已保存，立即生效");
        renderHubPage();
        return;
      }
      if (d.needs) return showScanGate(skfMsg, d, save);
      toast((d.error || "保存失败"), "circle-x");
    };
    save({}).catch(e => toast(e.message, "circle-x"));
  };
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/**
 * 技能装之前的体检没过时，画出来的那块东西。
 *
 * 为什么不是弹一句红字了事：这道检查唯一的价值就是**让人看见具体哪一行**。
 * 只说「该技能存在安全风险」，用户能做的只有点确定或者放弃，跟没检查一样；
 * 而且这种提示见多了，人就练成了看都不看直接点。所以这里摊开到文件 + 行号 + 原文片段，
 * 外加它会连哪些外网地址 —— 判断交给人，但得先给人可判断的东西。
 *
 * 两档按钮不一样：warn 是「我看过了，装」；block 是平台管理员才给的「仍然安装」，
 * 点下去会记进日志和技能目录里的 .install.json（谁、什么时候、放行了哪一条）。
 */
function showScanGate(msgEl, d, retry) {
  const scan = d.scan || { findings: [], hosts: [] };
  const isBlock = d.needs === "force";
  const rows = (scan.findings || []).slice(0, 20).map(f => `
    <div class="sk-scan-row ${f.level === "block" ? "is-block" : ""}">
      <div class="sk-scan-where">${ic(f.level === "block" ? "circle-x" : "triangle-alert")} ${esc(f.file)}${f.line ? ":" + f.line : ""}</div>
      <div class="sk-scan-why">${esc(f.why || "")}</div>
      ${f.excerpt ? `<pre class="sk-scan-ex">${esc(f.excerpt)}</pre>` : ""}
    </div>`).join("");
  const more = (scan.findings || []).length > 20 ? `<div class="sk-scan-more">…另外 ${scan.findings.length - 20} 处</div>` : "";
  const hosts = (scan.hosts || []).length
    ? `<div class="sk-scan-hosts">${ic("globe")} 会连这些地址：${esc(scan.hosts.slice(0, 12).join("、"))}${scan.hosts.length > 12 ? " …" : ""}</div>` : "";

  msgEl.style.color = "";
  msgEl.innerHTML = `
    <div class="sk-scan ${isBlock ? "is-block" : ""}">
      <div class="sk-scan-head">${ic(isBlock ? "shield" : "triangle-alert")} ${isBlock
        ? "这份技能里有不该出现在办公技能里的写法，默认没装。"
        : "装之前有几处要你看一眼——不是说它一定有问题，是这几处只有你能判断。"}</div>
      ${rows}${more}${hosts}
      <div class="sk-scan-foot">
        <button class="btn-brand sk-scan-go">${isBlock ? "仍然安装（会留档）" : "我看过了，装"}</button>
        <button class="sk-scan-no">算了</button>
        <span class="sk-scan-note">${isBlock
          ? "强装这一下会记进系统日志和技能目录里的 .install.json。只有平台管理员能点。"
          : "静态检查只能认出已知的那些写法，点过去不等于它是安全的。"}</span>
      </div>
    </div>`;
  msgEl.querySelector(".sk-scan-no").onclick = () => setMsg(msgEl, "", "");
  msgEl.querySelector(".sk-scan-go").onclick = () => retry(isBlock ? { force: true } : { confirm: true });
}

// ---- Tab 4：插件（Agent Plugins 1.0.0 标准包）----
// 一个插件包能同时带技能和 MCP 连接器。装坏的、部分零件被跳过的，都要在卡片上明说为什么，
// 不能装完显示「成功」结果里面少了一半东西。
async function renderHubPlugins(box) {
  box.innerHTML = '<div class="hub-empty">加载中…</div>';
  // 插件把技能和 MCP 连接器一起装进这台服务器，装/更新/卸载都是服务器级动作，归平台管理员。
  // 成员看得到装了哪些（他的 agent 用的就是这些），但不画那三颗点了必挂的按钮。
  const po = amPlatformOwner();
  const data = await fetch("/api/plugins").then(r => r.json()).catch(() => ({ spec: "", plugins: [], mcp: { connected: [], failures: [] } }));
  const list = (data.plugins || []).filter(p => hubMatch(hubState.q, p.name, p.description, p.author,
    (p.skills || []).map(s => s.name).join(" "), (p.mcp_servers || []).map(s => s.name).join(" ")));
  const conn = new Set(((data.mcp || {}).connected || []).map(c => c.name));
  const fails = Object.fromEntries((((data.mcp || {}).failures) || []).map(f => [f.name, f.error]));
  box.innerHTML = `
    ${po ? `<div class="ex-editor" style="margin-top:14px">
      <div class="hub-sec-title">${ic("download")} 安装插件
        <span class="sub">遵循 <a href="https://agent-plugins.org" target="_blank" rel="noreferrer">Agent Plugins ${esc(data.spec || "1.0.0")}</a> 的开放标准（Vercel 等厂商共同制定）：仓库根或子目录下有 <code>plugin.json</code> 即可，装一次技能和 MCP 一起进来</span></div>
      <div class="row"><input id="pl-url" placeholder="https://github.com/owner/repo 或 https://github.com/owner/repo/tree/main/plugins/xxx" style="flex:1">
        <button class="btn-brand" id="pl-install" style="flex:none">安装</button></div>
      <div id="pl-msg" class="ab-empty" style="margin-top:6px"></div>
    </div>` : ""}
    <div class="hub-sec-title" style="margin-top:14px">已装插件
      <span class="sub">共 ${list.length} 个 · ${po
        ? "技能立即生效；它带的 MCP 服务器装完自动连上、卸载时自动停掉"
        : "这些是平台管理员给这台服务器装的，你的智能体直接就能用"}</span></div>
    <div class="card-grid">
      ${list.map((p, i) => `
        <div class="ex-card" data-pi="${i}">
          <span class="flag" style="${p.ok ? "" : "background:var(--owb-err);color:#fff"}">${p.ok ? ic("puzzle") + " 插件" : "装不上"}</span>
          <div class="hd"><div class="av">${ic(p.ok ? "puzzle" : "triangle-alert")}</div>
            <div class="nm"><span>${esc(p.name)}</span><span class="al">${esc([p.version && "v" + p.version, p.license, p.author].filter(Boolean).join(" · ") || "未标注版本")}</span></div></div>
          <div class="ds">${esc(p.description || (p.ok ? "（插件没写 description）" : p.error))}</div>
          ${p.ok ? `<div class="tg">
            ${(p.skills || []).map(s => `<i title="${esc(s.description || "")}">${ic("wrench")} ${esc(s.name)}</i>`).join("")}
            ${(p.mcp_servers || []).map(s => `<i style="color:var(${conn.has(s.name) ? "--owb-ok" : "--owb-err"})" title="${esc(fails[s.name] || "")}">${ic(conn.has(s.name) ? "plug" : "triangle-alert")} ${esc(s.name)}（${esc(s.transport)}）</i>`).join("")}
            ${(p.skills || []).length || (p.mcp_servers || []).length ? "" : "<i>这个插件没带任何可用组件</i>"}
            <i>${ic("save")} ${fmtBytes(p.bytes)}</i></div>` : ""}
          ${(p.warnings || []).length ? `<div class="ds" style="font-size: 12px;color:var(--owb-warn,#b26a00)">${ic("triangle-alert")} 有零件被跳过：<br>${p.warnings.map(w => "· " + esc(w)).join("<br>")}</div>` : ""}
          ${p.homepage || p.repository ? `<div class="ds" style="font-size: 12px"><a href="${esc(p.homepage || p.repository)}" target="_blank" rel="noreferrer" style="word-break:break-all">${esc(p.homepage || p.repository)}</a></div>` : ""}
          <div class="ops">${po ? `${p.source ? '<button class="pl-upd" title="从当初安装的地址重新拉一遍">更新</button>' : ""}<button class="pl-del">卸载</button>` : ""}</div>
        </div>`).join("")}
      ${list.length ? "" : `<div class="hub-empty">${hubState.q ? `没有找到与「${esc(hubState.q)}」匹配的插件` : (po
        ? "还没装插件。上面填一个带 plugin.json 的 GitHub 地址就能装"
        : "这台服务器还没装插件。装插件归平台管理员，需要什么跟他说一声")}</div>`}
    </div>`;
  const plInstall = box.querySelector("#pl-install");
  if (plInstall) plInstall.onclick = async () => {
    const url = box.querySelector("#pl-url").value.trim();
    const msg = box.querySelector("#pl-msg");
    if (!url) return;
    setMsg(msg, "loader-circle", "安装中…（要先下载仓库，可能十几秒）");
    try {
      const resp = await fetch("/api/plugins/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(d.error || "安装失败");
      const it = d.installed || {};
      const parts = [`已装 ${it.name}`];
      if ((it.skills || []).length) parts.push(`技能 ${it.skills.length} 个：${it.skills.join("、")}`);
      if ((it.mcp_servers || []).length) parts.push(`MCP ${it.mcp_servers.length} 个，已连上 ${(d.mcp_started || []).length} 个`);
      if ((it.warnings || []).length) parts.push(`${it.warnings.length} 个零件被跳过（见卡片）`);
      setMsg(msg, "circle-check", parts.join(" · "), "ok");
      setTimeout(renderHubBody, 800);
    } catch (e) { setMsg(msg, "circle-x", e.message, "err"); }
  };
  box.querySelectorAll(".ex-card[data-pi]").forEach(card => {
    const p = list[+card.dataset.pi];
    if (!po) return;
    const upd = card.querySelector(".pl-upd");
    if (upd) upd.onclick = async () => {
      upd.disabled = true; upd.textContent = "更新中…";
      try {
        const resp = await fetch("/api/plugins/" + encodeURIComponent(p.name) + "/update", { method: "POST" });
        const d = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(d.error || "更新失败");
        const u = d.updated || {};
        toast(u.from_version && u.from_version !== u.version
          ? `${u.name} 已从 v${u.from_version} 更到 v${u.version || "?"}`
          : `${u.name} 已是最新（v${u.version || "?"}，重新拉了一遍）`, "circle-check");
        renderHubBody();
      } catch (e) { upd.disabled = false; upd.textContent = "更新"; toast(e.message, "circle-x"); }
    };
    card.querySelector(".pl-del").onclick = async () => {
      if (!confirm(`卸载插件「${p.name}」？它带的技能和连接器会一起消失（插件产生的数据会保留，重装还在）`)) return;
      const resp = await fetch("/api/plugins/" + encodeURIComponent(p.name), { method: "DELETE" });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok) return toast((d.error || "卸载失败"), "circle-x");
      if (d.note) toast(d.note);
      renderHubBody();
    };
  });
}

// ---- Tab 3：连接器（MCP）----
