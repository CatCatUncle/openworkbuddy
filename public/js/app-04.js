async function updateEvalView() {
  if (pageKind !== "eval") return;
  const st = await fetch("/api/eval/status").then((r) => r.json()).catch(() => null);
  if (pageKind !== "eval" || !st) return;
  const state = document.getElementById("ev-state"), log = document.getElementById("ev-log"), histBox = document.getElementById("ev-hist"), btn = document.getElementById("ev-start");
  if (!state || !log || !histBox) return;
  if (st.running) {
    state.textContent = `⏳ ${st.model} 评测中… ${Math.round((Date.now() - st.startedAt) / 1000)}s`;
    if (btn) btn.disabled = true;
    if (!assistTimer) assistTimer = setInterval(updateEvalView, 2000);
  } else {
    if (assistTimer) { clearInterval(assistTimer); assistTimer = null; }
    if (btn) btn.disabled = false;
    state.textContent = st.startedAt ? (st.exit === 0 ? "✅ 上一轮题题稳过" : st.exit == null ? "" : "🟡 上一轮有失分，看日志或点历史行看明细") : "";
  }
  if (st.lines && st.lines.length) {
    log.style.display = "";
    log.textContent = st.lines.join("\n");
    if (st.running) log.scrollTop = log.scrollHeight;
  }
  const hj = await fetch("/api/eval/history").then((r) => r.json()).catch(() => null);
  if (pageKind !== "eval") return;
  const hist = Array.isArray(hj) ? hj : (hj && hj.runs) || [];
  const baseline = (hj && !Array.isArray(hj) && hj.baseline) || null;
  if (!hist.length) { histBox.textContent = "还没跑过。选个模型点「开始评测」，或命令行 npm run eval"; return; }
  const blBanner = baseline
    ? `<div style="font-size:12px;color:var(--wb-text-3);margin:0 0 6px">📌 当前基线：${esc(baseline.model || "")} · ${esc(String(baseline.at || "").slice(0, 16).replace("T", " "))} · <code>${esc(baseline.commit || "—")}</code>（每次跑批自动逐题对比）</div>`
    : `<div style="font-size:12px;color:var(--wb-text-3);margin:0 0 6px">还没钉基线——点开一次成绩，点「📌 设为基线」，之后每轮自动对比退步/进步</div>`;
  const th = (t, tip) => `<th style="padding:6px 8px" ${tip ? `title="${esc(tip)}"` : ""}>${t}</th>`;
  histBox.innerHTML = blBanner + `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr style="color:var(--wb-text-3);text-align:left">${th("时间")}${th("模型")}${th("次数", "每题重复几次")}${th("pass@1", "各题通过率的平均：能不能做对")}${th("稳定全过", "k 次全过的题数：稳不稳。⚡=有题时过时不过")}${th("Δ基线", "与钉住的基线逐题对比")}${th("AI 评委", "逐条质量维度二元判定的达标率（旧格式为 1-5 均分）")}${th("人工", "人工打星的均分")}${th("tokens")}${th("版本", "跑分时的代码 commit")}</tr>
      ${hist.map((h) => {
        const p1 = h.pass1_avg != null ? h.pass1_avg : h.score_pct;
        const scoreColor = p1 >= 100 ? "var(--wb-ok)" : p1 >= 80 ? "var(--wb-text)" : "var(--wb-err)";
        const bl = h.baseline;
        const dCell = !bl ? "—" : (bl.regressions && bl.regressions.length
          ? `<span style="color:var(--wb-err-text)" title="退步：${esc(bl.regressions.join(", "))}">🔻${bl.regressions.length}题</span>`
          : (bl.improvements && bl.improvements.length ? `<span style="color:var(--wb-ok-text)" title="进步：${esc(bl.improvements.join(", "))}">↑${bl.improvements.length}题</span>` : `<span title="与基线持平">±0</span>`));
        const jd = h.judge ? (h.judge.avg_pct != null ? "⚖️ " + h.judge.avg_pct + "%" : (h.judge.avg != null ? "⚖️ " + h.judge.avg + "/5" : "—")) : "—";
        return `<tr data-dir="${esc(h.dir || "")}" style="border-top:1px solid var(--wb-line);cursor:pointer">
          <td style="padding:6px 8px;white-space:nowrap">${esc(String(h.at || "").slice(0, 16).replace("T", " "))}</td>
          <td style="padding:6px 8px">${esc(h.model || "")}</td>
          <td style="padding:6px 8px">${h.repeat || 1}×</td>
          <td style="padding:6px 8px;font-weight:700;color:${scoreColor}">${p1}%</td>
          <td style="padding:6px 8px">${h.full_pass}/${h.tasks}${(h.flaky_tasks || []).length ? ` <span title="不稳定：${esc((h.flaky_tasks || []).join(", "))}">⚡${h.flaky_tasks.length}</span>` : ""}</td>
          <td style="padding:6px 8px">${dCell}</td>
          <td style="padding:6px 8px">${jd}</td>
          <td style="padding:6px 8px">${h.human && h.human.avg ? "★ " + h.human.avg : "—"}</td>
          <td style="padding:6px 8px">${((h.tokens_total || 0) / 1000).toFixed(0)}k</td>
          <td style="padding:6px 8px"><code style="font-size:12px">${esc(h.commit || "—")}</code></td>
        </tr>`;
      }).join("")}
    </table>`;
  histBox.querySelectorAll("tr[data-dir]").forEach((tr) => { if (tr.dataset.dir) tr.onclick = () => openEvalDetail(tr.dataset.dir); });
}
async function openEvalDetail(dir) {
  const box = document.getElementById("ev-detail");
  if (!box) return;
  if (evalDetailDir === dir) { evalDetailDir = null; box.innerHTML = ""; return; }
  evalDetailDir = dir;
  box.innerHTML = `<div style="font-size:13px;color:var(--wb-text-3);margin:0 0 10px">加载明细…</div>`;
  const j = await fetch("/api/eval/run/" + encodeURIComponent(dir)).then((r) => r.json()).catch(() => null);
  if (evalDetailDir !== dir) return;
  if (!j || j.error) { box.innerHTML = ""; evalDetailDir = null; return toast("❌ " + ((j && j.error) || "明细加载失败")); }
  const p1 = j.pass1_avg != null ? j.pass1_avg : j.score_pct;
  const jdHead = j.judge ? (j.judge.avg_pct != null ? ` · 评委质量 ${j.judge.avg_pct}%（${esc(j.judge.model || "")}）` : (j.judge.avg != null ? ` · AI 评委 ${j.judge.avg}/5（${esc(j.judge.model || "")}）` : "")) : "";
  const blHead = j.baseline ? (j.baseline.regressions && j.baseline.regressions.length ? ` · <span style="color:var(--wb-err-text)">🔻对比基线退步 ${esc(j.baseline.regressions.join(", "))}</span>` : " · 对比基线无退步") : "";
  const head = `<div style="display:flex;align-items:center;gap:10px;margin:0 0 8px;flex-wrap:wrap">
      <b style="font-size:14px">${esc(String(j.at || "").slice(0, 16).replace("T", " "))} · ${esc(j.model || "")}${(j.repeat || 1) > 1 ? ` · 每题 ${j.repeat} 次` : ""}</b>
      <span style="font-size:12px;color:var(--wb-text-3)">pass@1 均值 ${p1}% · 稳定全过 ${j.full_pass}/${j.tasks}${jdHead}${j.human && j.human.avg ? ` · 人工 ★${j.human.avg}（已评 ${j.human.scored} 题）` : ""}${j.commit ? ` · 版本 ${esc(j.commit)}` : ""}${blHead}</span>
      <a href="#" id="ev-pin" class="link" style="margin-left:auto;font-size:12px;white-space:nowrap">📌 设为基线</a>
      <a href="#" id="ev-close" class="link" style="font-size:12px">收起 ✕</a>
    </div>`;
  const rows = (j.results || []).map((r) => {
    const k = r.k || 1;
    const passes = r.passes != null ? r.passes : (r.passed === r.total ? 1 : 0);
    const icon = passes === k ? "✅" : passes ? "⚡" : (r.passed ? "🟡" : "❌");
    const lv = r.level ? `<span style="font-size:11px;padding:1px 6px;border-radius:5px;background:var(--wb-bg);border:1px solid var(--wb-line);color:var(--wb-text-3)">L${r.level}${r.kind ? "·" + esc(r.kind) : ""}</span>` : "";
    const cells = (r.attempts && r.attempts.length > 1) ? `<span style="display:inline-flex;gap:3px" title="每格一次尝试">${r.attempts.map((a) => `<span title="第${a.n}次：${a.passed}/${a.total}${a.fail_code ? " · " + (EV_FAIL_LABELS[a.fail_code] || a.fail_code) : ""}" style="width:17px;height:17px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;background:${a.passed === a.total ? "rgba(34,197,94,.15)" : "rgba(239,68,68,.15)"};color:${a.passed === a.total ? "var(--wb-ok)" : "var(--wb-err)"}">${a.passed === a.total ? "✓" : "✗"}</span>`).join("")}</span>` : "";
    const chips = (r.fail_codes || []).map((c) => `<span style="font-size:11px;padding:1px 7px;border-radius:999px;background:rgba(239,68,68,.12);color:var(--wb-err-text)">${EV_FAIL_LABELS[c] || esc(c)}</span>`).join("");
    const checks = (r.checks || []).map((c) => `<div style="font-size:12px;color:${c.ok ? "var(--wb-ok)" : "var(--wb-err)"}">${c.ok ? "✓" : "✗"} ${esc(c.name)}${c.note ? `<span style="color:var(--wb-text-3)"> — ${esc(c.note)}</span>` : ""}</div>`).join("");
    const judge = r.judge && r.judge.dims
      ? `<div style="margin-top:6px;font-size:12px">⚖️ 质量维度 <b>${r.judge.passed}/${r.judge.total}</b>${r.judge.dims.map((d) => `<div style="color:${d.pass ? "var(--wb-ok)" : "var(--wb-err)"}">${d.pass ? "✓" : "✗"} ${esc(d.q)}${d.note ? `<span style="color:var(--wb-text-3)"> — ${esc(d.note)}</span>` : ""}</div>`).join("")}</div>`
      : r.judge && r.judge.score
        ? `<div style="margin-top:6px;font-size:12px">⚖️ AI 评委 <b>${r.judge.score}/5</b> — ${esc(r.judge.verdict || "")}${(r.judge.reasons || []).length ? `<div style="color:var(--wb-text-3)">${r.judge.reasons.map((x) => "· " + esc(x)).join("<br>")}</div>` : ""}${(r.judge.deductions || []).length ? `<div style="color:var(--wb-err-text)">${r.judge.deductions.map((x) => "扣分：" + esc(x)).join("<br>")}</div>` : ""}</div>`
        : (r.judge && r.judge.error ? `<div style="margin-top:6px;font-size:12px;color:var(--wb-text-3)">⚖️ 评委失败：${esc(r.judge.error)}</div>` : "");
    const hs = (r.human && r.human.score) || 0;
    const stars = [1, 2, 3, 4, 5].map((n) => `<button class="ev-star" data-task="${esc(r.id)}" data-star="${n}" title="人工打 ${n} 分" style="border:none;background:none;cursor:pointer;font-size:16px;padding:0 1px;line-height:1;color:${n <= hs ? "#f59e0b" : "var(--wb-text-3)"}">${n <= hs ? "★" : "☆"}</button>`).join("");
    return `<div style="border:1px solid var(--wb-line);border-radius:10px;padding:10px 12px;margin:0 0 8px;background:var(--wb-card)">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <b style="font-size:13px">${icon} ${esc(r.name)}</b>${lv}${cells}${chips}
        <span style="font-size:12px;color:var(--wb-text-3)">${k > 1 ? `${passes}/${k} 次全过 · 首轮 ` : ""}${r.passed}/${r.total} · ${r.elapsed_s}s · ${r.tool_calls || 0} 步${r.tool_errors ? `（${r.tool_errors} 次工具报错）` : ""}${r.stopped ? " · " + esc(r.stopped) : ""}${r.crashed ? " · 崩溃" : ""}</span>
        <span style="margin-left:auto;white-space:nowrap;display:flex;align-items:center">${stars}<input class="ev-cmt" data-task="${esc(r.id)}" placeholder="点评（可选）" value="${esc((r.human && r.human.comment) || "")}" style="width:150px;margin-left:6px;padding:3px 8px;border:1px solid var(--wb-line);border-radius:6px;background:var(--wb-bg);color:var(--wb-text);font-size:12px"></span>
      </div>
      <div style="margin-top:6px">${checks}</div>
      ${judge}
      ${r.final_text ? `<details style="margin-top:6px"><summary style="font-size:12px;color:var(--wb-text-3);cursor:pointer">最终回复摘录</summary><pre style="white-space:pre-wrap;font-size:12px;max-height:200px;overflow:auto;margin:4px 0 0;background:var(--wb-bg);border-radius:8px;padding:8px 10px">${esc(String(r.final_text).slice(0, 1500))}</pre></details>` : ""}
    </div>`;
  }).join("");
  box.innerHTML = `<div style="margin:0 0 14px">${head}${rows}</div>`;
  box.querySelector("#ev-close").onclick = (e) => { e.preventDefault(); evalDetailDir = null; box.innerHTML = ""; };
  box.querySelector("#ev-pin").onclick = async (e) => {
    e.preventDefault();
    const r = await fetch("/api/eval/baseline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir }) }).then((x) => x.json()).catch(() => null);
    if (!r || r.error) return toast("❌ " + ((r && r.error) || "钉基线失败"));
    toast("📌 已设为基线，之后每轮自动对比");
    updateEvalView();
  };
  const saveHuman = async (taskId, score) => {
    const cmt = box.querySelector(`.ev-cmt[data-task="${taskId}"]`);
    const r = await fetch("/api/eval/human", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir, task_id: taskId, score, comment: cmt ? cmt.value : "" }) }).then((x) => x.json()).catch(() => null);
    if (!r || r.error) return toast("❌ " + ((r && r.error) || "保存失败"));
    toast("★ 人工分已保存");
    evalDetailDir = null;
    openEvalDetail(dir);
    updateEvalView();
  };
  box.querySelectorAll(".ev-star").forEach((b) => b.onclick = () => saveHuman(b.dataset.task, +b.dataset.star));
  box.querySelectorAll(".ev-cmt").forEach((inp) => inp.onchange = () => {
    const row = (j.results || []).find((x) => x.id === inp.dataset.task);
    if (row && row.human && row.human.score) saveHuman(inp.dataset.task, row.human.score);
  });
}
async function renderLibPage() {
  const page = document.getElementById("assist-page");
  if (!page) return;
  const [lib, ws] = await Promise.all([
    fetch("/api/library").then(r => r.json()).catch(() => ({ files: [], notes: [] })),
    fetch("/api/files").then(r => r.json()).catch(() => []),
  ]);
  const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  const q = libState.q.toLowerCase();
  const hit = (n) => !q || n.toLowerCase().includes(q);
  const icon = (n) => /\.html?$/i.test(n) ? "🌐" : /\.csv$/i.test(n) ? "📊" : /\.(md|markdown)$/i.test(n) ? "📝" : /\.(png|jpe?g|gif|webp|svg)$/i.test(n) ? "🖼️" : /\.pdf$/i.test(n) ? "📕" : "📄";
  const item = (src, name, size) => `
    <div class="lib-it ${libState.pick && libState.pick.src === src && libState.pick.name === name ? "active" : ""}" data-src="${src}" data-name="${esc(name)}">
      <span>${icon(name)}</span><span class="nm" title="${esc(name)}">${esc(name)}</span>${size !== undefined ? `<span class="sz">${fmtSize(size)}</span>` : ""}
    </div>`;
  const recents = JSON.parse(localStorage.getItem("wb_lib_recent") || "[]");
  page.innerHTML = `
    <div class="lib-page">
      <div class="lib-side">
        <div class="hub-search"><input id="lb-q" placeholder="搜索资料" value="${esc(libState.q)}"></div>
        <div class="lib-it ${libState.pick && libState.pick.src === "notes" ? "active" : ""}" data-src="notes" data-name="" style="margin-top:10px"><span>💡</span><span class="nm">灵感笔记（${(lib.notes || []).length}）</span></div>
        ${recents.length ? `<div class="sec">最近</div>` + recents.filter(r => hit(r.name)).slice(0, 6).map(r => item(r.src, r.name)).join("") : ""}
        <div class="sec">我的文档 <a href="#" id="lb-up" class="link" style="font-size: 13px">＋ 上传</a><input type="file" id="lb-file" multiple style="display:none"></div>
        ${(lib.files || []).filter(f => hit(f.name)).map(f => item("lib", f.name, f.size)).join("") || '<div style="font-size: 13px;color:var(--wb-text-3);padding:4px 8px">还没有参考资料</div>'}
        <div class="sec">本地产物（当前项目）</div>
        ${ws.filter(f => hit(f.name)).slice(0, 60).map(f => item("ws", f.name, f.size)).join("") || '<div style="font-size: 13px;color:var(--wb-text-3);padding:4px 8px">工作目录还没有成果文件</div>'}
      </div>
      <div class="lib-prev" id="lb-prev"><div class="ph">左边挑一个文件看内容<br><br>📝 Markdown 直接排版 · 📊 CSV 变表格 · 🌐 HTML 真渲染<br>任务里 AI 也能读这里的资料（library_list / library_read）</div></div>
    </div>`;
  const qEl = page.querySelector("#lb-q");
  qEl.oninput = () => { libState.q = qEl.value; clearTimeout(page._t); page._t = setTimeout(renderLibPage, 200); };
  page.querySelector("#lb-up").onclick = (e) => { e.preventDefault(); page.querySelector("#lb-file").click(); };
  page.querySelector("#lb-file").onchange = async (e) => {
    for (const file of e.target.files) {
      const data_b64 = await new Promise((ok) => { const rd = new FileReader(); rd.onload = () => ok(rd.result.split(",")[1]); rd.readAsDataURL(file); });
      await fetch("/api/library/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, data_b64 }) });
    }
    toast("✅ 已上传");
    renderLibPage();
  };
  page.querySelectorAll(".lib-it").forEach(el => el.onclick = () => {
    libState.pick = { src: el.dataset.src, name: el.dataset.name };
    if (el.dataset.src !== "notes") {
      const rec = [{ src: el.dataset.src, name: el.dataset.name }, ...recents.filter(r => !(r.src === el.dataset.src && r.name === el.dataset.name))].slice(0, 8);
      localStorage.setItem("wb_lib_recent", JSON.stringify(rec));
    }
    page.querySelectorAll(".lib-it").forEach(x => x.classList.toggle("active", x === el));
    renderLibPreview(page.querySelector("#lb-prev"), lib);
  });
  if (libState.pick) renderLibPreview(page.querySelector("#lb-prev"), lib);
}
async function renderLibPreview(prev, lib) {
  const { src, name } = libState.pick || {};
  if (!src) return;
  if (src === "notes") {
    prev.innerHTML = `
      <div style="font-weight:600;margin-bottom:10px">💡 灵感笔记</div>
      <div style="display:flex;gap:6px;margin-bottom:10px">
        <input id="lb-note" placeholder="随手记一条灵感/偏好，回车保存" style="flex:1">
        <button class="btn-brand" id="lb-note-save" style="flex:none">保存</button>
      </div>
      <div>${(lib.notes || []).map(n =>
        `<div class="lib-note">${esc(n.text)}<div class="lm"><span>${esc((n.at || "").slice(0, 16).replace("T", " "))}</span><a href="#" class="link danger" data-nid="${esc(n.id)}">删除</a></div></div>`).join("")
        || '<div class="ph">还没有灵感笔记</div>'}</div>`;
    const save = async () => {
      const text = prev.querySelector("#lb-note").value.trim();
      if (!text) return;
      await fetch("/api/library/note", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      renderLibPage();
    };
    prev.querySelector("#lb-note-save").onclick = save;
    prev.querySelector("#lb-note").onkeydown = (e) => { if (e.key === "Enter") save(); };
    prev.querySelectorAll("a[data-nid]").forEach(a => a.onclick = async (e) => {
      e.preventDefault();
      await fetch("/api/library/note/" + encodeURIComponent(a.dataset.nid), { method: "DELETE" });
      renderLibPage();
    });
    return;
  }
  const url = src === "lib" ? "/api/library/file/" + encodeURIComponent(name) : "/api/files/view/" + encodeURIComponent(name);
  const bar = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
    <b style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</b>
    <a class="link" href="${url}" ${src === "lib" ? "download" : 'target="_blank"'}>${src === "lib" ? "下载" : "新窗口打开"}</a>
    ${src === "lib" ? `<a class="link danger" href="#" id="lb-del">删除</a>` : ""}
  </div>`;
  prev.innerHTML = bar + '<div class="ph">加载中…</div>';
  const body = prev.lastElementChild;
  const wireDel = () => {
    const d = prev.querySelector("#lb-del");
    if (d) d.onclick = async (e) => {
      e.preventDefault();
      if (!confirm(`删除资料「${name}」？`)) return;
      await fetch("/api/library/file/" + encodeURIComponent(name), { method: "DELETE" });
      libState.pick = null;
      renderLibPage();
    };
  };
  try {
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(name)) {
      body.outerHTML = `<img src="${url}" style="max-width:100%;border-radius:8px">`;
    } else if (/\.pdf$/i.test(name)) {
      body.outerHTML = `<iframe src="${url}"></iframe>`;
    } else if (/\.html?$/i.test(name)) {
      // HTML 真渲染。sandbox 掐掉同源和弹窗：资料是外来的，不能让它碰应用本身
      const text = await fetch(url).then(r => r.text());
      const blob = URL.createObjectURL(new Blob([text], { type: "text/html" }));
      body.outerHTML = `<iframe src="${blob}" sandbox="allow-scripts"></iframe>`;
    } else {
      const r = await fetch(url);
      if (!r.ok) throw new Error("读取失败");
      const text = await r.text();
      if (text.length > 400000) body.outerHTML = '<div class="ph">文件太大，预览不动，请下载后本地打开</div>';
      else if (/\.csv$/i.test(name)) body.outerHTML = csvToTable(text);
      else if (/\.(md|markdown)$/i.test(name)) body.outerHTML = `<div class="md">${renderMd(text)}</div>`;
      else body.outerHTML = `<pre class="raw">${esc(text)}</pre>`;
    }
  } catch (e) {
    body.outerHTML = `<div class="ph">预览失败：${esc(e.message)}</div>`;
  }
  wireDel();
}

// ================= 专家 · 技能 · 连接器（主区页面，三合一） =================
// 把原来分散在三个弹窗里的专家/技能/MCP 合成一页：左边挑 Tab，右边搜索，中间是卡片广场。
const hubState = { tab: "experts", sub: "expert", cat: "全部", q: "", mine: false, editing: null };
// 精选场景：点一下就带着写好的提示词开一条新任务。全是本地已具备的能力，不画饼。
const HUB_SCENES = [
  { ic: "📊", tt: "把 Excel 变成周报", dd: "读数据 → 算指标 → 生成带图表的周报文档", p: "把工作区里的数据文件读进来，算出核心指标的环比变化，生成一份带图表的周报（Word），结论写在最前面。" },
  { ic: "🔍", tt: "一个课题深挖到底", dd: "多轮检索取证 + 自我挑刺，出带来源的研究报告", p: "帮我深度研究「」这个课题：先拆成子问题，逐个联网查证并读原文，写完初稿后自己找一轮反面证据，最后输出带来源清单的研究报告。" },
  { ic: "🎨", tt: "做一个能直接开的网页", dd: "单文件 HTML，手机上不塌，做完自动自检", p: "做一个「」主题的单页网站：单文件 HTML，CSS/JS 内联不依赖外部资源，移动端优先，深浅色都要好看。做完读回文件自查一遍再交付。" },
  { ic: "🖼️", tt: "把材料做成 PPT", dd: "整理要点 → 排版 → 输出 16:9 演示文稿", p: "把工作区里的材料整理成一份 16:9 的 PPT：每页一个主题，标题写结论不写标签，数据页配图表。" },
  { ic: "⚖️", tt: "竞品横向对比", dd: "定维度 → 逐条查证 → 出对比表和差异化建议", p: "帮我对比「A / B / C」这几个产品：先定出对比维度，逐个联网查证填表（查不到写「未公开」不许猜），最后出对比表 + 我方该走的差异化路线。" },
  { ic: "📝", tt: "会议记录变纪要", dd: "提炼决议、待办（谁/做什么/什么时候）、待议项", p: "把我贴的这段会议记录整理成纪要：分「结论与决议」「待办（谁·做什么·何时前）」「待议」三段，原文没说的不许推断。" },
];
const HUB_TABS = [["experts", "专家"], ["skills", "技能"], ["mcp", "连接器"], ["plugins", "插件"]];
const fmtBytes = n => !n ? "—" : n < 1024 ? n + " B" : n < 1024 * 1024 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1) + " MB";

async function renderHubPage() {
  const page = document.getElementById("assist-page");
  if (!page) return;
  page.innerHTML = '<div class="hub-empty">加载中…</div>';
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
      <div class="hub-search"><input id="hub-q" placeholder="${qHint}" value="${esc(hubState.q)}"></div>
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
  const cats = ["全部", ...new Set(experts.map(e => e.category || "未分类"))];
  const scenes = hubState.mine || hubState.q ? "" : `
    <div class="hub-sec-title">精选场景 <span class="sub">点一下带着写好的提示词开新任务</span></div>
    <div class="feat-scroll">${HUB_SCENES.map((s, i) =>
      `<div class="feat-card" data-scene="${i}"><div class="ic">${s.ic}</div><div class="tt">${esc(s.tt)}</div><div class="dd">${esc(s.dd)}</div><div class="go">用这个开始 →</div></div>`).join("")}</div>`;
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
      `<div class="ex-card add" id="team-add">＋ 创建专家团</div>` +
      list.map((t, i) => `
        <div class="ex-card" data-ti="${i}">
          <div class="hd"><div class="av">${esc(t.avatar || "👥")}</div><div class="nm"><span>${esc(t.name)}</span><span class="al">${t.members.length} 位成员</span></div></div>
          <div class="ds">${esc(t.description || "（无说明）")}</div>
          <div class="tg">${t.members.map((m, j) => `<i>${j + 1}. ${esc(m)}</i>`).join("")}</div>
          <div class="ops"><button class="primary t-use">整团召唤</button><button class="t-edit">修改</button><button class="t-del">解散</button></div>
        </div>`).join("") +
      (list.length ? "" : `<div class="hub-empty">${hubState.q ? `没有找到与「${esc(hubState.q)}」匹配的专家团` : "暂无专家团"}</div>`);
    grid.querySelector("#team-add").onclick = () => { hubState.editing = { type: "team", data: null }; renderHubEditor(); };
    grid.querySelectorAll(".ex-card[data-ti]").forEach(card => {
      const t = list[+card.dataset.ti];
      card.querySelector(".t-use").onclick = () => { startTaskWith(`请把下面这个任务整体委派给专家团「${t.name}」（用 delegate_to_team）：\n\n`); toast(`已成功召唤专家团「${t.name}」`); };
      card.querySelector(".t-edit").onclick = () => { hubState.editing = { type: "team", data: t }; renderHubEditor(); };
      card.querySelector(".t-del").onclick = async () => {
        if (!confirm(`解散专家团「${t.name}」？（团里的专家本身不受影响）`)) return;
        await fetch("/api/expert-teams/" + encodeURIComponent(t.name), { method: "DELETE" });
        renderHubPage();
      };
    });
  } else {
    const list = experts.filter(e =>
      (hubState.cat === "全部" || (e.category || "未分类") === hubState.cat) &&
      (!hubState.mine || !e.builtin) &&
      hubMatch(hubState.q, e.name, e.alias, e.description, (e.tags || []).join(" ")));
    grid.innerHTML =
      `<div class="ex-card add" id="ex-add">＋ 创建专家<span class="add-sub">创建属于你的专家，分享专业知识</span></div>` +
      list.map((e, i) => `
        <div class="ex-card" data-ei="${i}">
          ${e.builtin ? '<span class="flag">官方</span>' : ""}
          <div class="hd"><div class="av">${esc(e.avatar || "🧑‍💼")}</div>
            <div class="nm"><span>${esc(e.name)}</span>${e.alias ? `<span class="al">${esc(e.alias)}</span>` : ""}</div></div>
          <div class="ds">${esc(e.description || "（无说明）")}</div>
          <div class="tg">${(e.tags || []).map(t => `<i>${esc(t)}</i>`).join("")}${(e.skills || []).map(s => `<i>🧰 ${esc(s)}</i>`).join("")}</div>
          <div class="ops"><button class="primary e-use">立即召唤</button><button class="e-edit">修改</button><button class="e-del">删除</button></div>
        </div>`).join("") +
      (list.length ? "" : `<div class="hub-empty">${
        hubState.mine ? "还没有创建任何专家" :
        hubState.q ? `没有找到与「${esc(hubState.q)}」匹配的专家，试试其他关键词` : "暂无该分类的专家"}</div>`) +
      (hubState.q && list.length ? `<div class="hub-count">搜索「${esc(hubState.q)}」找到 ${list.length} 位专家</div>` : "");
    grid.querySelector("#ex-add").onclick = () => { hubState.editing = { type: "expert", data: null }; renderHubEditor(); };
    grid.querySelectorAll(".ex-card[data-ei]").forEach(card => {
      const e = list[+card.dataset.ei];
      card.querySelector(".e-use").onclick = () => { startTaskWith(`请把下面这个任务委派给专家「${e.name}」：\n\n`); toast(`已成功召唤专家「${e.name}」`); };
      card.querySelector(".e-edit").onclick = () => { hubState.editing = { type: "expert", data: e }; renderHubEditor(); };
      card.querySelector(".e-del").onclick = async () => {
        if (!confirm(`删除专家「${e.name}」？${e.builtin ? "（这是内置专家，删了可以从 experts.json 恢复）" : ""}`)) return;
        await fetch("/api/experts/" + encodeURIComponent(e.name), { method: "DELETE" });
        renderHubPage();
      };
    });
  }
  renderHubEditor();
}

// ---- 专家 / 专家团 编辑器 ----
// 角色模板：从零写一份像样的角色设定是新建专家最大的门槛，选一个改改比空屏开写容易得多
const EXPERT_TEMPLATES = [
  { tt: "调研专员", alias: "查得深", avatar: "🔍", cat: "研究分析", desc: "行业/竞品/事实类调研，需要联网查证、多来源交叉核实时委派",
    tags: "行业调研，信息核实，来源分级", skills: ["deep-research"],
    sys: "你是一名严谨的调研专员。\n\n工作方式：\n1) 先列出要回答的 3-5 个关键问题，再动手搜\n2) 每个结论至少两个独立来源交叉验证，标注来源与日期\n3) 查不到就写查不到，给出下一步建议\n\n红线：不编造数据、链接和来源；转述与原文观点分开写。" },
  { tt: "数据分析师", alias: "算得清", avatar: "📊", cat: "研究分析", desc: "数据清洗、统计、出图表和 Excel 报表的活委派给它",
    tags: "数据清洗，统计分析，可视化", skills: ["data-viz", "excel-report"],
    sys: "你是一名数据分析师。\n\n工作方式：\n1) 先看清数据结构和口径，列出脏数据的处理规则\n2) 结论必须能从数据里复算出来，写明计算口径\n3) 图表配一句话结论，别让读者自己猜\n\n红线：样本太小或口径存疑时明说局限，不硬给结论。" },
  { tt: "文案主笔", alias: "笔头快", avatar: "✍️", cat: "内容创作", desc: "推文、文案、长文档的撰写和改写委派给它",
    tags: "公众号推文，长文写作，改写润色", skills: ["wechat-article", "docx"],
    sys: "你是一名文案主笔。\n\n工作方式：\n1) 动笔前先确认目标读者和这篇要达成什么\n2) 口语化、短句、多分段；每篇附一句话摘要和 3 个候选标题\n3) 改写保留原意，大改前列出改动点\n\n红线：不编造案例和数字；不用「赋能」「抓手」这类空话。" },
  { tt: "PPT 设计师", alias: "排得美", avatar: "🎨", cat: "办公文档", desc: "汇报、路演、课件类 PPT 的结构和制作委派给它",
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
          <select id="ef-tpl" style="width:auto;font-size: 13px;padding:4px 8px"><option value="">从角色模板起稿…</option>${EXPERT_TEMPLATES.map((t, i) => `<option value="${i}">${t.avatar} ${esc(t.tt)}</option>`).join("")}</select></div>
        <div class="row">
          <div style="flex:0 0 90px"><label>头像</label><input id="ef-avatar" maxlength="4" value="${esc(x.avatar || "🧑‍💼")}" style="text-align:center;font-size:18px"></div>
          <div style="flex:1 1 160px"><label>名字 <span class="lh">委派时点名用 · <span id="ef-ncnt">${(x.name || "").length}</span>/20</span></label><input id="ef-name" maxlength="20" value="${esc(x.name || "")}" placeholder="如 调研专员"></div>
          <div style="flex:1 1 120px"><label>花名 <span class="lh">可空</span></label><input id="ef-alias" value="${esc(x.alias || "")}" placeholder="如 查得深"></div>
          <div style="flex:1 1 120px"><label>分类</label><input id="ef-cat" value="${esc(x.category || "")}" placeholder="如 研究分析" list="ef-cats">
            <datalist id="ef-cats">${[...new Set(experts.map(e => e.category))].map(c => `<option value="${esc(c)}">`).join("")}</datalist></div>
        </div>
        <div class="row"><div style="flex:1"><div id="ef-ava-presets" style="display:flex;flex-wrap:wrap;gap:2px;margin-top:-4px">${AVATAR_PRESETS.map(e => `<span class="ava-pick" data-e="${e}">${e}</span>`).join("")}</div></div></div>
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
    box.querySelector("#ef-ava-presets").onclick = (ev) => {
      const pk = ev.target.closest(".ava-pick");
      if (pk) box.querySelector("#ef-avatar").value = pk.dataset.e;
    };
    box.querySelector("#ef-name").oninput = (ev) => { box.querySelector("#ef-ncnt").textContent = ev.target.value.length; };
    box.querySelector("#ef-tpl").onchange = (ev) => {
      const t = EXPERT_TEMPLATES[+ev.target.value];
      if (!t) return;
      const set = (id, v) => { box.querySelector("#" + id).value = v; };
      // 名字空着才填（编辑已有专家时别把名字顶掉）；说明/标签/提示词按模板覆盖
      if (!box.querySelector("#ef-name").value.trim()) { set("ef-name", t.tt); box.querySelector("#ef-ncnt").textContent = t.tt.length; }
      if (!box.querySelector("#ef-alias").value.trim()) set("ef-alias", t.alias);
      set("ef-avatar", t.avatar); set("ef-cat", t.cat); set("ef-desc", t.desc); set("ef-tags", t.tags); set("ef-sys", t.sys);
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
      if (!resp.ok) return toast("❌ " + (d.error || "保存失败"));
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
          <div style="flex:0 0 90px"><label>头像</label><input id="tf-avatar" maxlength="4" value="${esc(t.avatar || "👥")}" style="text-align:center;font-size:18px"></div>
          <div style="flex:1"><label>团队名称</label><input id="tf-name" value="${esc(t.name || "")}" placeholder="如 汇报三件套"></div>
        </div>
        <div class="row"><div style="flex:1"><label>说明（协调者据此决定什么活整团派）</label>
          <input id="tf-desc" value="${esc(t.description || "")}" placeholder="这个团适合干什么"></div></div>
        <div class="row"><div style="flex:1"><label>成员与顺序（至少 2 位；点击加入，再点移除。列表顺序＝执行顺序）</label>
          <div class="sk-pick" id="tf-pool">${experts.map(e =>
            `<label class="${picked.includes(e.name) ? "on" : ""}" data-n="${esc(e.name)}">${esc(e.avatar || "🧑‍💼")} ${esc(e.name)}</label>`).join("")}</div>
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
            `<a href="#" data-up="${i}" title="前移" style="text-decoration:none">↑</a><a href="#" data-rm="${i}" title="移除" style="text-decoration:none">✕</a></span>`).join("")
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
      if (!resp.ok) return toast("❌ " + (d.error || "保存失败"));
      hubState.editing = null;
      toast("专家团已保存，立即生效");
      renderHubPage();
    };
  }
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---- Tab 2：技能（技能包＝可热装的能力说明书） ----
async function renderHubSkills(box) {
  const list = hubState._skills.filter(s => hubMatch(hubState.q, s.name, s.description));
  // 推荐技能只在首次进来时拉一次，之后放缓存里 —— 搜索框每敲一下都重绘 body，不该每次都打一趟接口
  if (!hubState._defaults) {
    hubState._defaults = await fetch("/api/skills/defaults/list").then(r => r.json()).catch(() => []);
  }
  const defs = hubState._defaults.filter(s => hubMatch(hubState.q, s.name, s.title, s.why, s.author));
  const missing = hubState._defaults.filter(s => !s.installed);
  box.innerHTML = `
    ${defs.length ? `
    <div class="hub-sec-title" style="margin-top:14px">🌟 推荐技能
      <span class="sub">不随本项目打包，点一下从上游仓库现取（只下这一个子目录，不拖整仓）。协议与作者都写在卡片上，装谁的东西自己心里有数</span>
      ${missing.length ? `<button class="btn-brand" id="sk-def-all" style="float:right;padding:4px 12px;font-size: 13px">一键装齐缺的 ${missing.length} 个</button>` : ""}</div>
    <div class="card-grid">
      ${defs.map((s, i) => `
        <div class="ex-card" data-di="${i}">
          ${s.installed ? '<span class="flag">已安装</span>' : ""}
          <div class="hd"><div class="av">🌟</div><div class="nm"><span>${esc(s.title)}</span><span class="al">${esc(s.name)}</span></div></div>
          <div class="ds">${esc(s.why)}</div>
          <div class="tg"><i>📜 ${esc(s.license)}</i><i>👤 ${esc(s.author)}</i><i>💾 ${fmtBytes(s.installed ? s.installed_bytes : s.bytes)}</i></div>
          <div class="ds" style="font-size: 12px"><a href="${esc(s.url)}" target="_blank" rel="noreferrer" style="word-break:break-all">${esc(s.repo)}/${esc(s.subpath)}</a></div>
          <div class="ops">${s.installed
            ? '<button class="sk-def-reinstall">重新下载</button>'
            : '<button class="primary sk-def-install">安装</button>'}</div>
          <div class="ab-empty sk-def-msg" style="margin-top:4px"></div>
        </div>`).join("")}
    </div>` : ""}
    <div class="ex-editor" style="margin-top:14px">
      <div class="hub-sec-title">⬇️ 从 GitHub 安装 <span class="sub">整仓库 / tree 子目录 / blob 单文件 / raw 直链都行，装完立即生效不用重启</span></div>
      <div class="row"><input id="sk-url" placeholder="https://github.com/anthropics/skills/tree/main/skills/docx" style="flex:1">
        <button class="btn-brand" id="sk-install" style="flex:none">安装</button></div>
      <div id="sk-install-msg" class="ab-empty" style="margin-top:6px"></div>
    </div>
    <div id="hub-editor"></div>
    <div class="hub-sec-title" style="margin-top:14px">我的技能 <span class="sub">本机 skills/ 目录里的，加上插件带进来的</span></div>
    <div class="card-grid" id="hub-grid">
      <div class="ex-card add" id="sk-add">＋ 添加技能<span class="add-sub">手写一份操作说明书，智能体按需加载</span></div>
      ${list.map((s, i) => `
        <div class="ex-card" data-si="${i}">
          ${s.plugin ? `<span class="flag">插件</span>` : ""}
          <div class="hd"><div class="av">${s.plugin ? "🧩" : "🧰"}</div><div class="nm"><span>${esc(s.name)}</span>${
            s.plugin ? `<span class="al">来自插件 ${esc(s.plugin)}</span>` : ""}</div></div>
          <div class="ds">${esc(s.description || "（无描述）")}</div>
          <div class="ops"><button class="primary sk-use">立即使用</button><button class="sk-view">正文</button>${
            s.plugin ? "" : '<button class="sk-edit">修改</button><button class="sk-del">删除</button>'}</div>
          <pre class="sk-preview" style="display:none"></pre>
        </div>`).join("")}
      ${list.length ? "" : `<div class="hub-empty">${hubState.q ? `没有找到与「${esc(hubState.q)}」匹配的技能` : "暂无技能"}</div>`}
    </div>`;

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
      if (msgEl) { msgEl.style.color = "var(--wb-err)"; msgEl.textContent = "❌ " + e.message; }
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

  box.querySelector("#sk-add").onclick = () => { hubState.editing = { type: "skill", data: null }; renderHubSkillEditor(); };
  box.querySelector("#sk-install").onclick = async () => {
    const url = box.querySelector("#sk-url").value.trim();
    const msg = box.querySelector("#sk-install-msg");
    if (!url) return;
    msg.style.color = ""; msg.textContent = "安装中…（整仓库首次下载可能要十几秒）";
    try {
      const resp = await fetch("/api/skills/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(d.error || "安装失败");
      msg.textContent = `✅ 已安装 ${d.installed.length} 个：${d.installed.map(s => s.name).join("、")}`;
      setTimeout(renderHubPage, 1000);
    } catch (e) { msg.style.color = "var(--wb-err)"; msg.textContent = "❌ " + e.message; }
  };
  box.querySelectorAll(".ex-card[data-si]").forEach(card => {
    const s = list[+card.dataset.si];
    card.querySelector(".sk-use").onclick = () => startTaskWith(`用「${s.name}」技能帮我：`);
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
      if (!d) return toast("❌ 加载失败");
      hubState.editing = { type: "skill", data: d };
      renderHubSkillEditor();
    };
    const del = card.querySelector(".sk-del");
    if (del) del.onclick = async () => {
      if (!confirm(`删除技能「${s.name}」？（会删掉整个技能目录）`)) return;
      const resp = await fetch("/api/skills/" + encodeURIComponent(s.name), { method: "DELETE" });
      if (!resp.ok) { const d = await resp.json().catch(() => ({})); return toast("❌ " + (d.error || "删除失败")); }
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
  box.querySelector("#skf-save").onclick = async () => {
    const resp = await fetch("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: box.querySelector("#skf-name").value.trim(),
        description: box.querySelector("#skf-desc").value.trim(),
        content: box.querySelector("#skf-content").value,
        original_name: x.name || undefined,
      }) });
    const d = await resp.json().catch(() => ({}));
    if (!resp.ok) return toast("❌ " + (d.error || "保存失败"));
    hubState.editing = null;
    toast("技能已保存，立即生效");
    renderHubPage();
  };
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---- Tab 4：插件（Agent Plugins 1.0.0 标准包）----
// 一个插件包能同时带技能和 MCP 连接器。装坏的、部分零件被跳过的，都要在卡片上明说为什么，
// 不能装完显示「成功」结果里面少了一半东西。
async function renderHubPlugins(box) {
  box.innerHTML = '<div class="hub-empty">加载中…</div>';
  const data = await fetch("/api/plugins").then(r => r.json()).catch(() => ({ spec: "", plugins: [], mcp: { connected: [], failures: [] } }));
  const list = (data.plugins || []).filter(p => hubMatch(hubState.q, p.name, p.description, p.author,
    (p.skills || []).map(s => s.name).join(" "), (p.mcp_servers || []).map(s => s.name).join(" ")));
  const conn = new Set(((data.mcp || {}).connected || []).map(c => c.name));
  const fails = Object.fromEntries((((data.mcp || {}).failures) || []).map(f => [f.name, f.error]));
  box.innerHTML = `
    <div class="ex-editor" style="margin-top:14px">
      <div class="hub-sec-title">⬇️ 安装插件
        <span class="sub">遵循 <a href="https://agent-plugins.org" target="_blank" rel="noreferrer">Agent Plugins ${esc(data.spec || "1.0.0")}</a> 的开放标准（Vercel 等厂商共同制定）：仓库根或子目录下有 <code>plugin.json</code> 即可，装一次技能和 MCP 一起进来</span></div>
      <div class="row"><input id="pl-url" placeholder="https://github.com/owner/repo 或 https://github.com/owner/repo/tree/main/plugins/xxx" style="flex:1">
        <button class="btn-brand" id="pl-install" style="flex:none">安装</button></div>
      <div id="pl-msg" class="ab-empty" style="margin-top:6px"></div>
    </div>
    <div class="hub-sec-title" style="margin-top:14px">已装插件
      <span class="sub">共 ${list.length} 个 · 技能立即生效；它带的 MCP 服务器装完自动连上、卸载时自动停掉</span></div>
    <div class="card-grid">
      ${list.map((p, i) => `
        <div class="ex-card" data-pi="${i}">
          <span class="flag" style="${p.ok ? "" : "background:var(--wb-err);color:#fff"}">${p.ok ? "🧩 插件" : "装不上"}</span>
          <div class="hd"><div class="av">${p.ok ? "🧩" : "⚠️"}</div>
            <div class="nm"><span>${esc(p.name)}</span><span class="al">${esc([p.version && "v" + p.version, p.license, p.author].filter(Boolean).join(" · ") || "未标注版本")}</span></div></div>
          <div class="ds">${esc(p.description || (p.ok ? "（插件没写 description）" : p.error))}</div>
          ${p.ok ? `<div class="tg">
            ${(p.skills || []).map(s => `<i title="${esc(s.description || "")}">🧰 ${esc(s.name)}</i>`).join("")}
            ${(p.mcp_servers || []).map(s => `<i style="color:var(${conn.has(s.name) ? "--wb-ok" : "--wb-err"})" title="${esc(fails[s.name] || "")}">${conn.has(s.name) ? "🔌" : "⚠️"} ${esc(s.name)}（${esc(s.transport)}）</i>`).join("")}
            ${(p.skills || []).length || (p.mcp_servers || []).length ? "" : "<i>这个插件没带任何可用组件</i>"}
            <i>💾 ${fmtBytes(p.bytes)}</i></div>` : ""}
          ${(p.warnings || []).length ? `<div class="ds" style="font-size: 12px;color:var(--wb-warn,#b26a00)">⚠️ 有零件被跳过：<br>${p.warnings.map(w => "· " + esc(w)).join("<br>")}</div>` : ""}
          ${p.homepage || p.repository ? `<div class="ds" style="font-size: 12px"><a href="${esc(p.homepage || p.repository)}" target="_blank" rel="noreferrer" style="word-break:break-all">${esc(p.homepage || p.repository)}</a></div>` : ""}
          <div class="ops">${p.source ? '<button class="pl-upd" title="从当初安装的地址重新拉一遍">更新</button>' : ""}<button class="pl-del">卸载</button></div>
        </div>`).join("")}
      ${list.length ? "" : `<div class="hub-empty">${hubState.q ? `没有找到与「${esc(hubState.q)}」匹配的插件` : "还没装插件。上面填一个带 plugin.json 的 GitHub 地址就能装"}</div>`}
    </div>`;
  box.querySelector("#pl-install").onclick = async () => {
    const url = box.querySelector("#pl-url").value.trim();
    const msg = box.querySelector("#pl-msg");
    if (!url) return;
    msg.style.color = ""; msg.textContent = "安装中…（要先下载仓库，可能十几秒）";
    try {
      const resp = await fetch("/api/plugins/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(d.error || "安装失败");
      const it = d.installed || {};
      const parts = [`✅ 已装 ${it.name}`];
      if ((it.skills || []).length) parts.push(`技能 ${it.skills.length} 个：${it.skills.join("、")}`);
      if ((it.mcp_servers || []).length) parts.push(`MCP ${it.mcp_servers.length} 个，已连上 ${(d.mcp_started || []).length} 个`);
      if ((it.warnings || []).length) parts.push(`⚠️ ${it.warnings.length} 个零件被跳过（见卡片）`);
      msg.textContent = parts.join(" · ");
      setTimeout(renderHubBody, 800);
    } catch (e) { msg.style.color = "var(--wb-err)"; msg.textContent = "❌ " + e.message; }
  };
  box.querySelectorAll(".ex-card[data-pi]").forEach(card => {
    const p = list[+card.dataset.pi];
    const upd = card.querySelector(".pl-upd");
    if (upd) upd.onclick = async () => {
      upd.disabled = true; upd.textContent = "更新中…";
      try {
        const resp = await fetch("/api/plugins/" + encodeURIComponent(p.name) + "/update", { method: "POST" });
        const d = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(d.error || "更新失败");
        const u = d.updated || {};
        toast(u.from_version && u.from_version !== u.version
          ? `✅ ${u.name} 已从 v${u.from_version} 更到 v${u.version || "?"}`
          : `✅ ${u.name} 已是最新（v${u.version || "?"}，重新拉了一遍）`);
        renderHubBody();
      } catch (e) { upd.disabled = false; upd.textContent = "更新"; toast("❌ " + e.message); }
    };
    card.querySelector(".pl-del").onclick = async () => {
      if (!confirm(`卸载插件「${p.name}」？它带的技能和连接器会一起消失（插件产生的数据会保留，重装还在）`)) return;
      const resp = await fetch("/api/plugins/" + encodeURIComponent(p.name), { method: "DELETE" });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok) return toast("❌ " + (d.error || "卸载失败"));
      if (d.note) toast(d.note);
      renderHubBody();
    };
  });
}

// ---- Tab 3：连接器（MCP）----
