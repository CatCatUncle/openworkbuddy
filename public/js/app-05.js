async function renderHubMcp(box) {
  box.innerHTML = '<div class="hub-empty">加载中…</div>';
  const data = await fetch("/api/mcp").then(r => r.json()).catch(() => ({ servers: [], total_tools: 0 }));
  const list = data.servers
    .map((sv, i) => ({ sv, i }))
    .filter(({ sv }) => (!hubState.mine || sv.connected) && hubMatch(hubState.q, sv.name, sv.command, sv.url, (sv.args || []).join(" ")));
  // 原样存回去用的形状：远程的只回 name+url，请求头后端会沿用原来那份（GET 不回令牌）
  const isRemote = sv => sv.transport === "streamable-http" || (!sv.command && !!sv.url);
  const keep = sv => isRemote(sv)
    ? { name: sv.name, url: sv.url }
    : { name: sv.name, command: sv.command, args: sv.args, env: sv.env };
  // 插件声明的服务器归插件管：存回 config 会把它复制成一条我们自己的配置，卸载插件也删不掉了
  const ownServers = () => data.servers.filter(sv => !sv.plugin).map(keep);
  const save = async (servers) => {
    const msg = box.querySelector("#mcp-msg");
    if (msg) msg.textContent = "连接中…（npx 首次要下载包，最长约 1 分钟）";
    const resp = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ servers }) });
    const d = await resp.json().catch(() => ({}));
    if (!resp.ok) toast("❌ " + (d.error || "保存失败"));
    renderHubBody();
  };
  box.innerHTML = `
    <div class="hub-sec-title" style="margin-top:14px">已接入的外部工具
      <span class="sub">通过 MCP（本地 stdio / 远程 Streamable HTTP）给智能体接外部能力，当前 ${data.servers.length} 个服务器 · <b>${data.total_tools}</b> 个工具已注入，任务里可直接调用</span></div>
    <div class="card-grid">
      <div class="ex-card add" id="mcp-open-add">＋ 添加连接器</div>
      ${list.map(({ sv, i }) => `
        <div class="ex-card" data-mi="${i}">
          ${sv.plugin ? `<span class="flag">来自插件 ${esc(sv.plugin)}</span>` : ""}
          <div class="hd"><div class="av">${sv.connected ? "🔌" : "⚠️"}</div>
            <div class="nm"><span>${esc(sv.name)}</span><span class="al" style="color:var(${sv.connected ? "--wb-ok" : "--wb-err"})">${sv.connected ? `已连接 · ${sv.tools.length} 个工具` : "未连接"}</span></div></div>
          <div class="ds" style="font-family:var(--mono,ui-monospace,monospace);font-size: 12px;word-break:break-all">${isRemote(sv)
            ? `<b style="font-family:inherit;opacity:.6">远程 ·</b> ` + esc(sv.url) + ((sv.header_keys || []).length ? ` <span style="opacity:.7">（带 ${sv.header_keys.length} 个请求头：${esc(sv.header_keys.join("、"))}）</span>` : "")
            : `<b style="font-family:inherit;opacity:.6">本地 ·</b> ` + esc(sv.command) + " " + esc((sv.args || []).join(" "))}</div>
          <div class="tg">${sv.connected
            ? (sv.tools || []).slice(0, 8).map(t => `<i title="${esc(t.description || "")}">${esc(t.name)}</i>`).join("") + ((sv.tools || []).length > 8 ? `<i>…共 ${sv.tools.length} 个</i>` : "")
            : `<i style="color:var(--wb-err-text)">${esc(sv.error || "命令启动失败或握手超时，详见应用日志")}</i>`}</div>
          <div class="ops">${sv.plugin
            ? '<button disabled title="这条是插件声明的，要去「插件」页卸载整个插件">插件提供</button>'
            : '<button class="mcp-del">删除</button>'}</div>
        </div>`).join("")}
      ${list.length ? "" : `<div class="hub-empty">${hubState.mine ? "没有已连接的连接器" : "还没有连接器"}</div>`}
    </div>
    <div class="ex-editor" id="mcp-add-form" style="display:none">
      <div class="hub-sec-title">添加连接器
        <span class="sub">本地进程走 stdio；托管在别人服务器上的走 Streamable HTTP，填地址就行</span></div>
      <div class="row" style="gap:14px">
        <label style="display:flex;gap:5px;align-items:center;flex:none"><input type="radio" name="mcp-kind" value="stdio" checked style="width:auto">本地命令（stdio）</label>
        <label style="display:flex;gap:5px;align-items:center;flex:none"><input type="radio" name="mcp-kind" value="http" style="width:auto">远程地址（Streamable HTTP）</label>
      </div>
      <div class="row"><div style="flex:1 1 150px"><label>名称</label><input id="mcp-name" placeholder="filesystem"></div>
        <div class="mcp-f-stdio" style="flex:1 1 120px"><label>命令</label><input id="mcp-cmd" placeholder="npx"></div>
        <div class="mcp-f-stdio" style="flex:2 1 320px"><label>参数（空格分隔）</label><input id="mcp-args" placeholder="-y @modelcontextprotocol/server-filesystem /Users/你的用户名/Documents"></div>
        <div class="mcp-f-http" style="flex:2 1 320px;display:none"><label>地址</label><input id="mcp-url" placeholder="https://example.com/mcp"></div>
        <div class="mcp-f-http" style="flex:2 1 320px;display:none"><label>请求头（可选，每行 Key: Value）</label><input id="mcp-headers" placeholder="Authorization: Bearer 你的令牌"></div></div>
      <div style="display:flex;gap:8px;align-items:center"><button class="btn-brand" id="mcp-add">添加并连接</button>
        <button id="mcp-cancel" style="padding:6px 14px">取消</button><span class="ab-empty" id="mcp-msg"></span></div>
    </div>`;
  const form = box.querySelector("#mcp-add-form");
  box.querySelector("#mcp-open-add").onclick = () => { form.style.display = ""; form.scrollIntoView({ behavior: "smooth", block: "nearest" }); };
  box.querySelector("#mcp-cancel").onclick = () => { form.style.display = "none"; };
  box.querySelectorAll(".ex-card[data-mi]").forEach(card => {
    const sv = data.servers[+card.dataset.mi];
    const del = card.querySelector(".mcp-del");
    if (del) del.onclick = () => {
      if (!confirm(`删除连接器「${sv.name}」？`)) return;
      save(data.servers.filter(x => !x.plugin && x.name !== sv.name).map(keep));
    };
  });
  const kindOf = () => (box.querySelector('input[name="mcp-kind"]:checked') || {}).value || "stdio";
  box.querySelectorAll('input[name="mcp-kind"]').forEach(r => r.onchange = () => {
    const http = kindOf() === "http";
    box.querySelectorAll(".mcp-f-stdio").forEach(el => el.style.display = http ? "none" : "");
    box.querySelectorAll(".mcp-f-http").forEach(el => el.style.display = http ? "" : "none");
  });
  box.querySelector("#mcp-add").onclick = () => {
    const name = box.querySelector("#mcp-name").value.trim();
    if (!name) return toast("❌ 名称必填");
    if (kindOf() === "http") {
      const url = box.querySelector("#mcp-url").value.trim();
      if (!url) return toast("❌ 远程连接器要填地址");
      // 「Key: Value」按第一个冒号切，令牌里本身带冒号也不会被切坏
      const headers = {};
      box.querySelector("#mcp-headers").value.split(/[\n;]+/).map(s => s.trim()).filter(Boolean).forEach(line => {
        const at = line.indexOf(":");
        if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      });
      return save(ownServers().concat([{ name, url, headers }]));
    }
    const cmd = box.querySelector("#mcp-cmd").value.trim();
    const args = box.querySelector("#mcp-args").value.trim().split(/\s+/).filter(Boolean);
    if (!cmd) return toast("❌ 本地连接器要填命令");
    save(ownServers().concat([{ name, command: cmd, args, env: {} }]));
  };
}

// ================= 参考模板库（照着抄的提示词，点一下填进输入框） =================
// 每条都对应本地真实具备的能力（技能包 / 工具 / 专家团），不写做不到的画饼模板。
const PROMPT_TPLS = [
  { c: "网页", ic: "🖥️", t: "做一个工作台/仪表盘", d: "多卡片布局的单页应用，能直接双击打开",
    p: `做一个「__主题__工作台」单页网站：\n\n【内容】顶部标题栏 + 关键指标卡 4 个 + 主区域（__放什么__）+ 侧边__放什么__\n【数据】用我工作区里的 __文件名__；没有数据就先造 8 条像真的示例数据，并在页面上标注「示例数据」\n【技术】单文件 HTML，CSS/JS 全部内联，不依赖任何外部 CDN，断网也能打开\n【体验】移动端优先，深浅色都要好看；交互要有 hover/点击反馈\n\n做完把文件读回来自查一遍：有没有引用外部资源、有没有空的 onclick。` },
  { c: "网页", ic: "🎯", t: "做一个产品落地页", d: "首屏＋卖点＋FAQ＋行动召唤",
    p: `帮我做一个「__产品名__」的落地页（单文件 HTML）：\n\n首屏一句话说清「给谁解决什么问题」，别写形容词堆砌；\n三个核心卖点，每个配一句具体的场景说明（不要「高效」「智能」这种空词）；\n一段常见问题 FAQ（5 条）；\n底部行动召唤按钮。\n\n风格：__简洁克制 / 科技感 / 温暖__。CSS 内联，移动端优先。` },
  { c: "研究", ic: "🔍", t: "深度研究一个课题", d: "拆子问题→逐个查证→自我挑刺→带来源报告",
    p: `帮我深度研究「__课题__」：\n\n1) 先把它拆成 5 个以内的子问题，列出来给我看；\n2) 逐个联网检索并打开原文核对，不要只看搜索摘要；\n3) 写完初稿后自己找一轮反面证据，能推翻的结论就改掉；\n4) 输出研究报告：结论先行 → 论据 → 不确定的地方 → 来源清单（带链接和日期）。\n\n查不到的就写「未找到公开信息」，绝对不许编数字和来源。` },
  { c: "研究", ic: "⚖️", t: "竞品横向对比", d: "先定维度再逐条填表，出差异化建议",
    p: `帮我对比「__A__ / __B__ / __C__」：\n\n先定出 6-8 个对比维度（定价、目标用户、核心能力、部署方式、生态、短板…），列出来；\n逐条联网查证填表，每格标注信息来源和获取日期；查不到写「未公开」，不许推测；\n最后给：① 对比表 ② 各自最适合谁 ③ 如果我要做同类产品，切哪个缝隙。` },
  { c: "数据", ic: "📊", t: "数据文件变分析报告", d: "读数→算指标→画图→写结论",
    p: `读取工作区里的 __文件名__，做一份分析：\n\n1) 先告诉我这份数据有多少行、有哪些字段、有没有缺失或异常值；\n2) 算出这几个指标：__指标1__、__指标2__ 的环比/同比变化；\n3) 画 2-3 张图（趋势 + 构成），存成图片；\n4) 输出一份 Word 报告：结论写最前面，图表跟在对应结论后面。\n\n算不出来的指标直接说算不出来，别用估计值糊弄。` },
  { c: "数据", ic: "📈", t: "把结论做成图表", d: "指定图表类型，输出可直接用的图片",
    p: `把下面这组数据画成图：\n\n__粘贴数据__\n\n要求：__折线/柱状/饼图/散点__，中文标签不要乱码，坐标轴带单位，标题写结论不写「XX图」。\n生成图片存到工作区，并告诉我文件名。` },
  { c: "办公", ic: "🖼️", t: "材料整理成 PPT", d: "16:9，每页一个主题，标题写结论",
    p: `把 __工作区里的 XX 文件 / 下面这段内容__ 整理成一份 16:9 的 PPT：\n\n页数控制在 __10__ 页以内；\n每页一个主题，标题直接写结论（比如「获客成本降了 32%」而不是「获客成本分析」）；\n有数据的页配图表，没数据的页别硬凑图；\n最后一页是行动建议，具体到谁在什么时候做什么。` },
  { c: "办公", ic: "📝", t: "会议记录变纪要", d: "决议 / 待办 / 待议 三段式",
    p: `把下面这段会议记录整理成纪要：\n\n__粘贴记录__\n\n分三段：\n【结论与决议】已经拍板的事；\n【待办】谁 · 做什么 · 什么时候前完成（没说负责人就写「待认领」）；\n【待议】有争议或没结论的。\n\n原文里没说的一律不许补充推断。` },
  { c: "办公", ic: "🗓️", t: "写本周周报", d: "读工作区产出，自动汇总成周报",
    p: `帮我写这周的周报：\n\n先看看工作区里这周新增/修改了哪些文件，作为素材；\n补充这些我口述的进展：__…__\n\n格式：本周完成（带可验证的结果，不写「推进了」这种虚词）→ 下周计划 → 需要支持的事。\n控制在一页内。` },
  { c: "内容", ic: "✍️", t: "写一篇公众号文章", d: "先给选题角度再动笔",
    p: `写一篇关于「__主题__」的公众号文章：\n\n先给我 3 个不同的切入角度，我选一个你再动笔；\n目标读者是 __谁__，他们最关心 __什么__；\n开头 3 句话内必须让读者觉得「这说的是我」；\n中间要有具体的例子或数字，不要通篇讲道理；\n字数 __1500__ 字左右。` },
  { c: "内容", ic: "📮", t: "一条内容改成多平台版本", d: "同一个内核，不同平台的话术",
    p: `把下面这条内容改写成三个版本：\n\n__粘贴原文__\n\n① 公众号（正式、有结构、能读 3 分钟）\n② 小红书（口语、有情绪、带 emoji 和话题标签）\n③ 朋友圈（100 字内，一句话钩子）\n\n内核信息保持一致，别为了适配平台把事实改了。` },
  { c: "团队", ic: "👥", t: "整团派活（专家团接力）", d: "一句话把复杂任务交给一支团队",
    p: `请把下面这个任务整体委派给专家团「__团队名__」（用 delegate_to_team）：\n\n__任务描述，越具体越好：要什么、给谁看、什么格式、什么时候要__\n\n拿回结果后你自己核一遍：说生成的文件真的存在吗？数据有出处吗？没问题再交给我。` },
  { c: "团队", ic: "🧑‍💼", t: "指名派给某个专家", d: "点名让某位专家单独干",
    p: `请把这件事委派给专家「__专家名__」：\n\n__任务描述__\n\n它汇报完你要替我核一遍再转给我。` },
  { c: "自动化", ic: "⏰", t: "让它每天自动干一件事", d: "配合侧栏「自动化」建定时任务",
    p: `每天早上帮我做这件事（我待会去「自动化」里把它设成定时任务）：\n\n__要做什么__\n\n输出格式：__…__。如果当天没有值得说的变化，就明确回一句「今天无异常」，不要为了凑字数编内容。` },
];

function renderPromptPage() {
  const page = document.getElementById("assist-page");
  if (!page) return;
  const cats = ["全部", ...new Set(PROMPT_TPLS.map(t => t.c))];
  if (!renderPromptPage._cat) renderPromptPage._cat = "全部";
  const draw = () => {
    const cat = renderPromptPage._cat;
    const q = (page.querySelector("#tpl-q")?.value || "").trim().toLowerCase();
    const list = PROMPT_TPLS.filter(t =>
      (cat === "全部" || t.c === cat) &&
      (!q || (t.t + t.d + t.p).toLowerCase().includes(q)));
    page.querySelector("#tpl-grid").innerHTML = list.map((t, i) => `
      <div class="tpl-card${q && !(t.t + t.d).toLowerCase().includes(q) ? " open" : ""}" data-i="${PROMPT_TPLS.indexOf(t)}">
        <div class="hd"><span class="ic">${t.ic}</span><span class="tt">${esc(t.t)}</span><span class="ct">${esc(t.c)}</span><span class="chev">▶</span></div>
        <div class="dd">${esc(t.d)}</div>
        <pre>${esc(t.p)}</pre>
        <div class="ops"><button class="primary tpl-use">填进输入框</button><button class="tpl-copy">复制</button></div>
      </div>`).join("") || '<div class="hub-empty">没有匹配的模板</div>';
    page.querySelectorAll(".tpl-card").forEach(card => {
      const t = PROMPT_TPLS[+card.dataset.i];
      card.onclick = (e) => { if (e.target.closest("button")) return; card.classList.toggle("open"); };
      card.querySelector(".tpl-use").onclick = () => startTaskWith(t.p);
      card.querySelector(".tpl-copy").onclick = async (e) => {
        try { await navigator.clipboard.writeText(t.p); e.target.textContent = "已复制"; setTimeout(() => e.target.textContent = "复制", 1200); }
        catch { toast("❌ 复制失败，手动选中上面的文字吧"); }
      };
    });
  };
  page.innerHTML = `
    <div class="hub-head">
      <div class="hub-sec-title" style="margin:0">照着抄就行 <span class="sub">点卡片看全文；带 __下划线__ 的地方换成你的内容；「填进输入框」直接开一条新任务</span></div>
      <div class="hub-search" style="margin-left:auto"><input id="tpl-q" placeholder="搜模板…"></div>
    </div>
    <div class="hub-chips" style="margin:4px 0 14px">${cats.map(c =>
      `<span class="chip ${renderPromptPage._cat === c ? "active" : ""}" data-c="${esc(c)}">${esc(c)}</span>`).join("")}</div>
    <div class="tpl-grid" id="tpl-grid"></div>`;
  page.querySelectorAll(".chip[data-c]").forEach(c => c.onclick = () => {
    renderPromptPage._cat = c.dataset.c;
    page.querySelectorAll(".chip[data-c]").forEach(x => x.classList.toggle("active", x === c));
    draw();
  });
  page.querySelector("#tpl-q").oninput = draw;
  draw();
}

/**
 * 从广场里点「派活」/「填进输入框」：回到新任务并把提示词填进输入框。
 * 模板里的 __占位__ 直接选中第一个，用户接着打字就替换掉了；没有占位符就把光标放末尾。
 */
function startTaskWith(text) {
  document.getElementById("new-task").click();
  inputEl.value = text;
  inputEl.dispatchEvent(new Event("input"));   // 先让输入框按新内容撑高，否则下面的定位会被这次改高冲掉
  inputEl.focus();
  const m = /__[^_\n]*__/.exec(text);
  if (m) inputEl.setSelectionRange(m.index, m.index + m[0].length);
  else inputEl.setSelectionRange(text.length, text.length);
  // 长模板会把输入框滚到末尾，用户看不见开头。选区在开头就直接滚回顶部。
  inputEl.scrollTop = 0;
}

// ================= 定时任务（可视化，不写 cron） =================
function cronToHuman(cron) {
  const m = cron.match(/^(\d+) (\d+) (\S+) \* (\S+)$/);
  if (cron.startsWith("*/30")) return "每 30 分钟";
  if (m) {
    const time = `${m[2].padStart(2,"0")}:${m[1].padStart(2,"0")}`;
    if (m[3] === "*" && m[4] === "*") return `每天 ${time}`;
    if (m[4] === "1-5") return `工作日 ${time}`;
    if (m[3] === "*" && /^\d$/.test(m[4])) return `每周${"日一二三四五六"[+m[4]]} ${time}`;
    if (/^\d+$/.test(m[3])) return `每月 ${m[3]} 日 ${time}`;
  }
  if (/^(\d+) \* \* \* \*$/.test(cron)) return `每小时第 ${cron.split(" ")[0]} 分`;
  return cron;
}

// ================= 设置中心 =================
const SETTING_CATS = [
  ["models", "模型"],
  ["search", "联网搜索"],
  ["agent", "智能体设置"],
  ["security", "安全中心"],
  ["shortcuts", "快捷键"],
  ["persona", "个性化"],
  ["memory", "记忆"],
  ["evolve", "自进化"],
  ["data", "数据管理"],
  ["im", "助理设置"],
  ["about", "关于"],
];
async function renderSettings(active) {
  const s = await fetch("/api/settings").then(r => r.json());
  mBody.innerHTML = `<div class="settings-layout">
    <div class="settings-nav">${SETTING_CATS.map(([k, label]) =>
      `<div class="cat ${k === active ? "active" : ""}" data-cat="${k}">${label}</div>`).join("")}</div>
    <div class="settings-pane" id="settings-pane"></div>
  </div>`;
  mBody.querySelector(".settings-nav").addEventListener("click", (e) => {
    const cat = e.target.closest(".cat");
    if (cat) renderSettings(cat.dataset.cat);
  });
  const pane = mBody.querySelector("#settings-pane");
  if (active === "models") renderModelsPane(pane, s);
  else if (active === "search") renderSearchPane(pane, s);
  else if (active === "agent") renderAgentPane(pane, s);
  else if (active === "persona") renderPersonaPane(pane, s);
  else if (active === "memory") renderMemoryPane(pane);
  else if (active === "evolve") renderEvolvePane(pane);
  else if (active === "data") renderDataPane(pane, s);
  else if (active === "security") renderSecurityPane(pane, s);
  else if (active === "shortcuts") renderShortcutsPane(pane, s);
  else if (active === "im") renderImPane(pane, s);
  else renderAboutPane(pane);
}
async function saveSettings(patch, msgEl) {
  const resp = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
  const data = await resp.json().catch(() => ({}));
  if (msgEl) msgEl.textContent = resp.ok ? "✓ 已保存并生效" : (data.error || "保存失败");
  if (resp.ok) refreshSettingsCache();
  return resp.ok;
}
// 渠道预设：选一个就把接口地址/协议填好，只差 Key 和模型名
const CHANNEL_PRESETS = [
  { label: "选择渠道预设…", provider: "openai", base: "", model: "" },
  { label: "OpenAI 官方", provider: "openai", base: "https://api.openai.com/v1", model: "gpt-5.2" },
  { label: "Anthropic Claude 官方", provider: "anthropic", base: "", model: "claude-sonnet-5" },
  { label: "OpenRouter（聚合）", provider: "openai", base: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat" },
  { label: "火山方舟（豆包/DeepSeek）", provider: "openai", base: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-1-6-250615" },
  { label: "阿里云百炼（通义）", provider: "openai", base: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-max" },
  { label: "DeepSeek 官方", provider: "openai", base: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { label: "智谱 GLM", provider: "openai", base: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-plus" },
  { label: "Kimi（月之暗面）", provider: "openai", base: "https://api.moonshot.cn/v1", model: "kimi-k2-0905-preview" },
  { label: "Ollama 本地", provider: "openai", base: "http://localhost:11434/v1", model: "qwen3:14b" },
];
function renderModelsPane(pane, s) {
  const md = { image: {}, video: {}, tts: {}, vision: {}, ...(s.media || {}) };
  pane.innerHTML = `
    <div style="color:var(--wb-text-2);margin-bottom:10px">选择当前使用的模型，或添加模型。内置 OpenAI / Anthropic / OpenRouter / 火山方舟 / 阿里百炼 / DeepSeek / 智谱 / Kimi / Ollama 渠道预设，任何 OpenAI 兼容接口也都支持。输入框右下角可快速切换。</div>
    <div id="model-list">${s.models.map((m, i) => `
      <div class="card-item" style="display:flex;align-items:center;gap:10px">
        <input type="radio" name="active" style="width:auto;margin:0" ${m.name === s.active_model ? "checked" : ""} data-i="${i}">
        <div style="flex:1;min-width:0">
          <div class="t">${esc(m.name)} <span style="font-weight:400;color:var(--wb-text-3);font-size: 12px">${esc(m.model)}${m.api_key ? "" : " · ⚠ 未填 Key"}${healthBadge(m.name)}</span></div>
          <div class="d" style="font-size: 12px">${esc(m.base_url || "Anthropic 官方")}</div>
        </div>
        <a href="#" class="link" data-edit="${i}">编辑</a>
        <a href="#" class="link" data-dup="${i}" title="复用此条的接口地址和 Key，换个模型名即成新模型">复制</a>
        <a href="#" class="link danger" data-del="${i}">删除</a>
      </div>`).join("")}
    </div>
    <div id="model-form" style="display:none;border-top:1px solid var(--wb-border);padding-top:10px">
      <select id="mf-channel">${CHANNEL_PRESETS.map((c, i) => `<option value="${i}">${esc(c.label)}</option>`).join("")}</select>
      <input id="mf-name" placeholder="名称（如：我的vLLM）">
      <div class="form-row">
        <select id="mf-provider"><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select>
        <input id="mf-model" placeholder="模型名（如 deepseek-chat）">
      </div>
      <input id="mf-base" placeholder="Base URL（如 https://api.deepseek.com/v1）">
      <input id="mf-key" type="password" placeholder="API Key">
      <button class="btn-brand" id="mf-save">保存模型</button>
      <button class="btn-plain" id="mf-cancel">取消</button>
    </div>
    <button class="btn-plain" id="mf-new" style="margin-top:6px">＋ 添加自定义模型</button>
    <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size: 13px;color:var(--wb-text-2);cursor:pointer">
      <input type="checkbox" id="mf-follow-last" style="width:auto;margin:0" ${s.model_follow_last ? "checked" : ""}>
      新对话自动沿用上次手动选过的模型（不勾则新对话总是用全局默认）
    </label>
    <div style="border-top:1px solid var(--wb-border);margin-top:14px;padding-top:12px">
      <div class="card-item">
        <div class="t">👁 视觉模型（看图）</div>
        <div class="d" style="margin-bottom:6px">给 look_at_image 工具用：你粘贴（⌘V）或拖进来的截图，它带着问题去看，拿回文字。<b>不填也能用</b>——会直接拿上面选中的主模型看；主模型是纯文本的（如 deepseek-chat）会明确报错，那时在这儿填一个能看图的模型即可（GPT / Claude / Gemini / GLM / Qwen-VL 系的多模态版本，OpenAI 兼容接口）。</div>
        <input id="mvi-base" placeholder="接口地址（如 https://openrouter.ai/api/v1，留空=用主模型）" value="${esc((md.vision || {}).base_url || "")}">
        <div class="form-row">
          <input id="mvi-key" type="password" placeholder="API Key" value="${esc((md.vision || {}).api_key || "")}">
          <input id="mvi-model" placeholder="模型名（如 gpt-5-mini / z-ai/glm-5.3-flash / qwen-vl-max）" value="${esc((md.vision || {}).model || "")}">
        </div>
      </div>
      <div class="card-item">
        <div class="t">🎨 图像模型</div>
        <div class="d" style="margin-bottom:6px">给 agent 的 generate_image 工具用（对话里说「画一张…」即可，成图存进工作空间）。支持 OpenAI 兼容 /images/generations（含 new-api 等聚合网关）；接口地址含 dashscope 时自动走通义 qwen-image 原生协议。</div>
        <input id="mi-base" placeholder="接口地址（如 https://dashscope.aliyuncs.com/api/v1 或 https://api.openai.com/v1）" value="${esc(md.image.base_url || "")}">
        <div class="form-row">
          <input id="mi-key" type="password" placeholder="API Key" value="${esc(md.image.api_key || "")}">
          <input id="mi-model" placeholder="模型名（如 qwen-image / gpt-image-1）" value="${esc(md.image.model || "")}">
        </div>
      </div>
      <div class="card-item">
        <div class="t">🎬 视频模型</div>
        <div class="d" style="margin-bottom:6px">给 generate_video 工具用，生成通常 1~5 分钟。支持 DashScope 万相（地址含 dashscope，模型如 wan2.2-t2v-plus）与火山方舟 Seedance（地址含 ark/volces）两种协议。</div>
        <input id="mv-base" placeholder="接口地址（如 https://dashscope.aliyuncs.com/api/v1）" value="${esc(md.video.base_url || "")}">
        <div class="form-row">
          <input id="mv-key" type="password" placeholder="API Key" value="${esc(md.video.api_key || "")}">
          <input id="mv-model" placeholder="模型名（如 wan2.2-t2v-plus / doubao-seedance-1-0-pro-250528）" value="${esc(md.video.model || "")}">
        </div>
      </div>
      <div class="card-item">
        <div class="t">🎙️ 语音合成（TTS）</div>
        <div class="d" style="margin-bottom:6px">给 text_to_speech 工具用（视频配音、播客旁白）。支持 OpenAI 兼容 /audio/speech（含 new-api 等聚合网关，模型如 tts-1 / gpt-4o-mini-tts）；接口地址含 dashscope 时自动走通义 qwen-tts 原生协议（模型如 qwen-tts，音色如 Cherry / Serena）。</div>
        <input id="mt-base" placeholder="接口地址（如 https://api.openai.com/v1 或 https://dashscope.aliyuncs.com/api/v1）" value="${esc((md.tts || {}).base_url || "")}">
        <div class="form-row">
          <input id="mt-key" type="password" placeholder="API Key" value="${esc((md.tts || {}).api_key || "")}">
          <input id="mt-model" placeholder="模型名（如 tts-1 / qwen-tts）" value="${esc((md.tts || {}).model || "")}">
          <input id="mt-voice" placeholder="默认音色（如 alloy / Cherry，可空）" value="${esc((md.tts || {}).voice || "")}">
        </div>
      </div>
      <button class="btn-brand" id="media-save">保存视觉 / 图像 / 视频 / 语音模型</button>
    </div>
    <span class="ok-msg" id="models-msg"></span>`;
  const msg = pane.querySelector("#models-msg");
  let editIndex = -1;
  const form = pane.querySelector("#model-form");
  const showForm = (m) => {
    form.style.display = "";
    pane.querySelector("#mf-name").value = m?.name || "";
    pane.querySelector("#mf-provider").value = m?.provider || "openai";
    pane.querySelector("#mf-model").value = m?.model || "";
    pane.querySelector("#mf-base").value = m?.base_url || "";
    pane.querySelector("#mf-key").value = m?.api_key || "";
  };
  pane.querySelector("#mf-channel").onchange = () => {
    const idx = +pane.querySelector("#mf-channel").value;
    const c = CHANNEL_PRESETS[idx];
    if (!c || idx === 0) return; // 第 0 项是占位提示
    pane.querySelector("#mf-provider").value = c.provider;
    pane.querySelector("#mf-base").value = c.base;
    pane.querySelector("#mf-model").value = c.model;
    if (!pane.querySelector("#mf-name").value) pane.querySelector("#mf-name").value = c.label.replace(/（.*/, "");
  };
  pane.querySelector("#mf-new").onclick = () => { editIndex = -1; showForm(null); };
  pane.querySelector("#mf-follow-last").onchange = (e) => saveSettings({ model_follow_last: e.target.checked }, msg);
  pane.querySelector("#mf-cancel").onclick = () => (form.style.display = "none");
  pane.querySelectorAll("a[data-edit]").forEach(a => a.onclick = (e) => { e.preventDefault(); editIndex = +a.dataset.edit; showForm(s.models[editIndex]); });
  // 复制：复用同一接口地址和 Key 快速配另一个模型（OpenRouter 换模型场景），只需填名称和模型名
  pane.querySelectorAll("a[data-dup]").forEach(a => a.onclick = (e) => {
    e.preventDefault();
    editIndex = -1;
    showForm({ ...s.models[+a.dataset.dup], name: "", model: "" });
    pane.querySelector("#mf-name").focus();
  });
  pane.querySelectorAll("a[data-del]").forEach(a => a.onclick = async (e) => {
    e.preventDefault();
    if (!confirm("确认删除该模型？")) return;
    s.models.splice(+a.dataset.del, 1);
    await saveSettings({ models: s.models }, msg);
    renderSettings("models");
  });
  pane.querySelectorAll("input[name=active]").forEach(r => r.onchange = async () => {
    await saveSettings({ active_model: s.models[+r.dataset.i].name }, msg);
    renderSettings("models");
  });
  pane.querySelector("#media-save").onclick = async () => {
    const v = (id) => pane.querySelector("#" + id).value.trim();
    await saveSettings({
      media: {
        image: { base_url: v("mi-base"), api_key: v("mi-key"), model: v("mi-model") },
        video: { base_url: v("mv-base"), api_key: v("mv-key"), model: v("mv-model") },
        tts: { base_url: v("mt-base"), api_key: v("mt-key"), model: v("mt-model"), voice: v("mt-voice") },
        vision: { base_url: v("mvi-base"), api_key: v("mvi-key"), model: v("mvi-model") },
      },
    }, msg);
  };
  pane.querySelector("#mf-save").onclick = async () => {
    const entry = {
      name: pane.querySelector("#mf-name").value.trim(),
      provider: pane.querySelector("#mf-provider").value,
      model: pane.querySelector("#mf-model").value.trim(),
      base_url: pane.querySelector("#mf-base").value.trim(),
      api_key: pane.querySelector("#mf-key").value.trim(),
    };
    if (!entry.name || !entry.model) return toast("❌ 名称和模型名必填");
    if (editIndex >= 0) s.models[editIndex] = entry; else s.models.push(entry);
    await saveSettings({ models: s.models }, msg);
    renderSettings("models");
  };
}
// 联网搜索：provider 可切（Jina / Tavily / Brave），各自独立 key；没 key 自动退免费 DuckDuckGo
function renderSearchPane(pane, s) {
  const sc = s.search || {};
  pane.innerHTML = `
    <div class="card-item">
      <div class="t">搜索服务商</div>
      <div class="d" style="margin-bottom:6px">web_search 工具用哪家搜索 API。所选服务商没填 Key 或调用失败时，自动回退到免费 DuckDuckGo。</div>
      <select id="sr-provider">
        <option value="jina">Jina（s.jina.ai）</option>
        <option value="tavily">Tavily</option>
        <option value="brave">Brave Search</option>
      </select>
      <div class="t" style="margin-top:10px">Jina API Key</div>
      <input id="sr-jina" type="password" placeholder="jina_..." value="${esc(sc.jina_key || "")}">
      <div class="t" style="margin-top:8px">Tavily API Key</div>
      <input id="sr-tavily" type="password" placeholder="tvly-..." value="${esc(sc.tavily_key || "")}">
      <div class="t" style="margin-top:8px">Brave API Key</div>
      <input id="sr-brave" type="password" placeholder="BSA..." value="${esc(sc.brave_key || "")}">
    </div>
    <button class="btn-brand" id="sr-save">保存</button>
    <button class="btn-plain" id="sr-test">测试搜索</button>
    <span class="ok-msg" id="sr-msg"></span>`;
  pane.querySelector("#sr-provider").value = sc.provider || "jina";
  const msg = pane.querySelector("#sr-msg");
  const collect = () => ({
    provider: pane.querySelector("#sr-provider").value,
    jina_key: pane.querySelector("#sr-jina").value.trim(),
    tavily_key: pane.querySelector("#sr-tavily").value.trim(),
    brave_key: pane.querySelector("#sr-brave").value.trim(),
  });
  pane.querySelector("#sr-save").onclick = () => saveSettings({ search: collect() }, msg);
  pane.querySelector("#sr-test").onclick = async (e) => {
    e.target.disabled = true;
    msg.textContent = "保存并测试中…";
    const ok = await saveSettings({ search: collect() });
    if (ok) {
      const r = await fetch("/api/search/test").then(x => x.json()).catch(() => ({ error: "请求失败" }));
      msg.textContent = r.ok ? `✓ ${r.provider} 可用：${r.sample}` : `✗ ${r.error || "测试失败"}`;
    } else msg.textContent = "保存失败";
    e.target.disabled = false;
  };
}
function renderAgentPane(pane, s) {
  pane.innerHTML = `
    <div class="card-item">
      <div class="t">执行权限模式</div>
      <div class="d">输入框下方「权限」下拉可随时切换：Ask 只问答 · Plan 只出计划 · Craft 完整执行交付</div>
    </div>
    <div class="card-item">
      <div class="t">最大执行步数</div>
      <div class="d" style="margin-bottom:6px">单个任务 Agent 循环上限，防止失控（默认 25）</div>
      <input id="ag-steps" type="number" min="1" max="100" value="${s.agent.max_steps}">
      <div class="t" style="margin-top:8px">单工具超时（秒）</div>
      <input id="ag-timeout" type="number" min="5" value="${Math.round(s.agent.tool_timeout_ms / 1000)}">
      <div class="t" style="margin-top:8px">任务最大运行时间（分钟）</div>
      <div class="d" style="margin-bottom:6px">整个任务（含专家子代理）的墙上时间预算，超时强制收尾（默认 10）</div>
      <input id="ag-runtime" type="number" min="1" value="${Math.round((s.agent.max_runtime_ms || 600000) / 60000)}">
      <div class="t" style="margin-top:8px">自动续跑轮数</div>
      <div class="d" style="margin-bottom:6px">任务撞到步数/时间上限但还没做完时，自动重置预算接着跑的最大轮数。0 = 关闭（默认）。开启后长任务会按 PROGRESS.md 的进度接着做，直到完成或轮数用完；手动停止不会续跑。注意：每一轮都是真实计费</div>
      <input id="ag-rounds" type="number" min="0" max="20" value="${s.agent.auto_continue_rounds || 0}">
      <div class="t" style="margin-top:8px">模型卡壳超时（秒）</div>
      <div class="d" style="margin-bottom:6px">连续这么久收不到模型的任何输出（正文/思考/写文件的参数流都算）才判定连接挂死、强制收尾；只要还在逐字输出就不会掐断（默认 300）</div>
      <input id="ag-llm-timeout" type="number" min="30" value="${Math.round((s.agent.llm_timeout_ms || 300000) / 1000)}">
      <div class="t" style="margin-top:8px">token 预算（万 tokens）</div>
      <div class="d" style="margin-bottom:6px">单个任务（含专家子代理和自动续跑）的 token 总量上限，超过后强制收尾且不再自动续跑，防止长任务烧钱失控。0 = 不限（默认）。用到 80% 会先提醒</div>
      <input id="ag-tokbudget" type="number" min="0" step="1" value="${Math.round((s.agent.max_tokens_budget || 0) / 10000)}">
      <div class="t" style="margin-top:8px">备用渠道（主模型挂起自动换道）</div>
      <div class="d" style="margin-bottom:6px">主模型连续卡壳超时或服务端持续报错时，自动切到这里选的渠道接着跑当前任务，并在任务流里醒目播报。默认关闭：不选就绝不悄悄换模型，宁可如实报错。每个任务最多换一次道</div>
      <select id="ag-failover">
        <option value="">关闭（默认，不自动换道）</option>
        ${(s.models || []).map((m) => `<option value="${esc(m.name)}"${(s.agent.failover_model || "") === m.name ? " selected" : ""}>${esc(m.name)}（${esc(m.model)}）${String(m.api_key || "").trim() || /ollama|本地/i.test(m.name || "") ? "" : "（未配 Key）"}</option>`).join("")}
      </select>
      <div class="t" style="margin-top:8px">上下文预算（千字符）</div>
      <div class="d" style="margin-bottom:6px">超出后自动截短较早的工具输出（最近 3 步始终保留原文），避免长任务撞模型上下文上限整个失败。上下文大的模型可以调高（默认 120）</div>
      <input id="ag-ctx" type="number" min="20" max="2000" value="${Math.round((s.agent.max_context_chars || 120000) / 1000)}">
    </div>
    <button class="btn-brand" id="ag-save">保存</button><span class="ok-msg" id="ag-msg"></span>`;
  pane.querySelector("#ag-save").onclick = () =>
    saveSettings({ agent: {
      max_steps: +pane.querySelector("#ag-steps").value,
      tool_timeout_ms: +pane.querySelector("#ag-timeout").value * 1000,
      max_runtime_ms: +pane.querySelector("#ag-runtime").value * 60000,
      auto_continue_rounds: +pane.querySelector("#ag-rounds").value,
      llm_timeout_ms: +pane.querySelector("#ag-llm-timeout").value * 1000,
      max_context_chars: +pane.querySelector("#ag-ctx").value * 1000,
      max_tokens_budget: Math.round(+pane.querySelector("#ag-tokbudget").value * 10000) || 0,
      failover_model: pane.querySelector("#ag-failover").value,
    } }, pane.querySelector("#ag-msg"));
}
function renderPersonaPane(pane, s) {
  const a = { name: "OpenWorkBuddy", avatar: "🤖", ...(s.assistant || {}) };
  pane.innerHTML = `
    <div class="card-item">
      <div class="t">助理的名字和头像</div>
      <div class="d" style="margin-bottom:10px">给它起个自己顺口的名字。名字会同时改掉界面标题、侧栏和系统提示词——你喊它这个名字它就认。</div>
      ${avatarEditorHtml("as", a.avatar, a.name)}
      <input id="as-name" maxlength="24" placeholder="OpenWorkBuddy" value="${esc(a.name)}" style="margin-top:10px">
      <div style="margin-top:8px"><button class="btn-brand" id="as-save">保存身份</button><span class="ok-msg" id="as-msg"></span></div>
    </div>
    <div class="card-item">
      <div class="t">个性化偏好</div>
      <div class="d" style="margin-bottom:8px">希望它遵循的风格与偏好，会注入每次任务。例如：回复简洁；PPT 用深色科技风；周报署名"张三"。</div>
      <textarea id="ps-text" rows="8" placeholder="例如：所有文档默认用简体中文；数据分析结论放最前面…">${esc(s.persona)}</textarea>
    </div>
    ${petCardHtml(s.pet || {})}
    <button class="btn-brand" id="ps-save">保存</button><span class="ok-msg" id="ps-msg"></span>`;
  bindPetCard(pane, s.pet || {});
  const ed = bindAvatarEditor(pane, "as", a.avatar, () => pane.querySelector("#as-name").value.trim() || "OpenWorkBuddy");
  pane.querySelector("#as-save").onclick = async () => {
    const msg = pane.querySelector("#as-msg");
    const ok = await saveSettings({ assistant: { name: pane.querySelector("#as-name").value, avatar: ed.value() } }, msg);
    if (!ok) return;
    assistant = await fetch("/api/assistant").then(r => r.json()).catch(() => assistant);
    applyAssistantIdentity();
  };
  pane.querySelector("#ps-save").onclick = () => saveSettings({ persona: pane.querySelector("#ps-text").value }, pane.querySelector("#ps-msg"));
}
// ================= 桌面宠物 =================
function petCardHtml(p) {
  const on = p.enabled !== false;
  return `
    <div class="card-item">
      <div class="t">🐱 桌面宠物</div>
      <div class="d" style="margin-bottom:10px"><b>默认没有宠物</b>——直接在对话里说「把这张图做成桌面宠物」并传一张照片，它就现场给你做一只；这里是手动开关和微调。<br>做出来之后，它会在桌面角落实时显示 agent 在干什么：干活时敲键盘、<b>要问你问题时跳起来并弹系统通知</b>（这条最有用——主窗口被盖住时，它提的问题很容易被漏掉，超时就按默认继续了）。点它开关主窗口，拖动换位置，右键有菜单（含免打扰）。空白处不吃鼠标，不会挡住底下的应用。${p.available === false ? '<br><span style="color:var(--wb-warn,#c60)">当前是纯服务端模式（npm start），宠物只在桌面版 <code>npm run app</code> 下出现。</span>' : ""}</div>
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;color:var(--wb-text-2);cursor:pointer"><input type="checkbox" id="pet-on" style="width:auto;margin:0"${on ? " checked" : ""}> 显示桌面宠物</label>
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;color:var(--wb-text-2);cursor:pointer"><input type="checkbox" id="pet-notify" style="width:auto;margin:0"${p.notify !== false ? " checked" : ""}> 要提问时弹系统通知 + 图标跳动</label>
      <div class="t" style="margin-top:10px">形象</div>
      <div class="d" style="margin-bottom:6px">可以换成你自己或朋友的照片——上传后自动裁成圆形，配上呼吸、摇摆、跳跃的动效"活"起来。图片只存在本机 <code>data/</code> 目录，不上传任何服务器。</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="pet-char" style="max-width:200px">
          <option value="cat"${p.character !== "photo" ? " selected" : ""}>内置小猫</option>
          <option value="photo"${p.character === "photo" ? " selected" : ""}>我的照片${p.has_photo ? "" : "（还没上传）"}</option>
        </select>
        <button class="btn-plain" id="pet-pick">上传照片</button>
        ${p.has_photo ? '<button class="btn-plain" id="pet-drop">删除照片</button>' : ""}
        <input type="file" id="pet-file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">
      </div>
      <div class="t" style="margin-top:10px">大小 <span id="pet-scale-v" style="color:var(--wb-text-3)">${Math.round((p.scale || 1) * 100)}%</span></div>
      <input type="range" id="pet-scale" min="0.6" max="2" step="0.1" value="${p.scale || 1}">
      <div class="t" style="margin-top:6px">透明度 <span id="pet-op-v" style="color:var(--wb-text-3)">${Math.round((p.opacity || 1) * 100)}%</span></div>
      <input type="range" id="pet-op" min="0.25" max="1" step="0.05" value="${p.opacity || 1}">
      <div style="margin-top:8px"><span class="ok-msg" id="pet-msg"></span></div>
    </div>`;
}
function bindPetCard(pane, p) {
  const msg = pane.querySelector("#pet-msg");
  const q = (id) => pane.querySelector(id);
  const save = (patch) => saveSettings({ pet: patch }, msg);
  q("#pet-on").onchange = (e) => save({ enabled: e.target.checked });
  q("#pet-notify").onchange = (e) => save({ notify: e.target.checked });
  q("#pet-char").onchange = (e) => {
    if (e.target.value === "photo" && !p.has_photo) { msg.textContent = "先上传一张照片"; e.target.value = "cat"; return; }
    save({ character: e.target.value });
  };
  const scale = q("#pet-scale"), op = q("#pet-op");
  scale.oninput = () => { q("#pet-scale-v").textContent = Math.round(scale.value * 100) + "%"; };
  scale.onchange = () => save({ scale: Number(scale.value) });
  op.oninput = () => { q("#pet-op-v").textContent = Math.round(op.value * 100) + "%"; };
  op.onchange = () => save({ opacity: Number(op.value) });

  q("#pet-pick").onclick = () => q("#pet-file").click();
  q("#pet-file").onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    msg.textContent = "处理中…";
    try {
      // 前端先裁成 320×320 正方形再传：原图动辄好几 MB，宠物窗口只有 88px，
      // 传原图既浪费又会把 data URL 撑大（形象是通过 IPC 直接推给宠物窗口的）
      const dataUrl = await squareThumb(f, 320);
      const r = await fetch("/api/pet/avatar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data_url: dataUrl }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { msg.textContent = j.error || "上传失败"; return; }
      msg.textContent = "✓ 形象已换上";
      renderSettings("persona");
    } catch (err) { msg.textContent = "读取图片失败：" + err.message; }
  };
  const drop = q("#pet-drop");
  if (drop) drop.onclick = async () => {
    if (!confirm("删除已上传的照片，换回内置小猫？")) return;
    await fetch("/api/pet/avatar", { method: "DELETE" });
    renderSettings("persona");
  };
}
/** 把任意图片裁成居中正方形缩略图（保持比例，取中间）。GIF 会被拍成静态第一帧 */
function squareThumb(file, size) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("读不出这个文件"));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("这不是一张能解码的图片"));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const cv = document.createElement("canvas");
        cv.width = cv.height = size;
        const cx = cv.getContext("2d");
        cx.imageSmoothingQuality = "high";
        cx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        resolve(cv.toDataURL("image/png"));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

async function renderMemoryPane(pane) {
  const m = await fetch("/api/memory").then(r => r.json());
  const items = m.items || [];
  const rows = items.length
    ? items.map(it => `
      <div class="mem-row">
        <span class="mem-tag">${it.scope === m.shared_tag ? "共享" : esc(it.scope)}</span>
        <span class="mem-txt">${esc(it.text)}</span>
        <span class="mem-src">${it.source === "user" ? "手动" : "AI 记的"}</span>
        <a href="#" class="link danger" data-del="${esc(it.id)}">删</a>
      </div>`).join("")
    : '<div style="color:var(--wb-text-3);font-size: 14px;padding:6px 0">还没有。你说「以后都这样」「记住…」时它会自己记一条；也可以在下面手动加。</div>';
  pane.innerHTML = `
    <div class="card-item">
      <div class="t">📌 记住的事（AI 自己记的 + 你手动加的）</div>
      <div class="d" style="margin-bottom:8px">一条一句话，跨任务保留。标「共享」的所有账号都看得到，标账号名的只跟着那个人走。每人最多 ${esc(String((m.limits || {}).max_items || 120))} 条。</div>
      <div id="mem-items">${rows}</div>
      <div class="form-row" style="margin-top:8px">
        <input id="mem-new" placeholder="手动加一条，例如：周报只要三段——进展 / 问题 / 下周计划">
        <button class="btn-plain" id="mem-add" style="flex:0 0 auto">加进去</button>
      </div>
      <label style="display:flex;align-items:center;gap:6px;font-size: 13px;color:var(--wb-text-3);margin-top:6px;cursor:pointer">
        <input type="checkbox" id="mem-shared" style="width:auto;margin:0"> 这条给这台机器上所有账号共用
      </label>
    </div>
    <div class="card-item">
      <div class="t">📝 背景说明（全局共享，原样进提示词）</div>
      <div class="d" style="margin-bottom:8px">适合放团队/业务背景、常用数据口径、固定模板要求这种成段的东西。所有账号共用一份。</div>
      <textarea id="mem-text" rows="8" placeholder="例如：我们公司是做跨境电商的，主营美妆品类；周报收件人是运营部…">${esc(m.content)}</textarea>
    </div>
    <div class="card-item">
      <div class="t">🚚 记忆搬家（导出 / 从其它 agent 导入）</div>
      <div class="d" style="margin-bottom:8px">导出成一份 Markdown 到哪都能用。导入自动扫描本机 Claude Code / Codex / Claude Cowork 的记忆文件；腾讯 WorkBuddy 等没有固定文件的，从它界面里把记忆复制出来粘到下面即可。「导入为条目」逐行进上面的条目区（自动去重），「并入背景说明」整段接到背景说明后面。</div>
      <div style="margin-bottom:8px"><button class="btn-plain" id="mem-export">📤 导出全部记忆（.md）</button></div>
      <div id="mem-scan" style="font-size: 13px;color:var(--wb-text-2)">扫描中…</div>
      <textarea id="mem-paste" rows="4" placeholder="或把其它 agent 的记忆文本粘到这里…" style="margin-top:8px"></textarea>
      <div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn-plain" id="mem-paste-items">导入为条目</button>
        <button class="btn-plain" id="mem-paste-manual">并入背景说明</button>
        <span class="ok-msg" id="mem-imp-msg"></span>
      </div>
    </div>
    <button class="btn-brand" id="mem-save">保存背景说明</button><span class="ok-msg" id="mem-msg"></span>`;
  pane.querySelector("#mem-save").onclick = async () => {
    const resp = await fetch("/api/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: pane.querySelector("#mem-text").value }) });
    pane.querySelector("#mem-msg").textContent = resp.ok ? "✓ 已保存" : "保存失败";
  };
  pane.querySelector("#mem-add").onclick = async () => {
    const text = pane.querySelector("#mem-new").value.trim();
    if (!text) return;
    const r = await fetch("/api/memory/item", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, shared: pane.querySelector("#mem-shared").checked }),
    }).then(r => r.json()).catch(() => ({ note: "网络错误" }));
    toast(r.note || (r.ok ? "已记住" : "没记成"));
    if (r.ok) renderMemoryPane(pane);
  };
  // ---- 记忆搬家 ----
  pane.querySelector("#mem-export").onclick = () => { location.href = "/api/memory/export"; };
  const impMsg = pane.querySelector("#mem-imp-msg");
  const showImp = (r) => {
    if (r.error) { impMsg.textContent = "❌ " + r.error; return; }
    impMsg.textContent = r.note || `✓ 导入 ${r.added} 条${r.skipped ? `，跳过 ${r.skipped} 条（重复/太长/含敏感信息）` : ""}`;
  };
  const doImport = async (body) => {
    impMsg.textContent = "导入中…";
    const r = await fetch("/api/memory/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json()).catch(() => ({ error: "网络错误" }));
    showImp(r);
    if (r.ok && r.added) setTimeout(() => renderMemoryPane(pane), 900);
  };
  pane.querySelector("#mem-paste-items").onclick = () => {
    const t = pane.querySelector("#mem-paste").value.trim();
    if (!t) return toast("先把要导入的内容粘进来");
    doImport({ text: t, mode: "items" });
  };
  pane.querySelector("#mem-paste-manual").onclick = () => {
    const t = pane.querySelector("#mem-paste").value.trim();
    if (!t) return toast("先把要导入的内容粘进来");
    doImport({ text: t, mode: "manual" });
  };
  const scanBox = pane.querySelector("#mem-scan");
  fetch("/api/memory/import/scan").then(r => r.json()).then(d => {
    const list = d.sources || [];
    scanBox.innerHTML = list.length ? list.map((s, i) => `
      <div style="display:flex;align-items:center;gap:10px;padding:4px 0;border-bottom:1px solid var(--wb-border)">
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis" title="${esc(s.path)}">${esc(s.label)}</span>
        <span style="color:var(--wb-text-3)">${fmtSize(s.size)}</span>
        <a href="#" class="link" data-imp-i="${i}" data-imp-mode="items">导入为条目</a>
        <a href="#" class="link" data-imp-i="${i}" data-imp-mode="manual">并入背景说明</a>
      </div>`).join("") : "本机没扫到其它 agent 的记忆文件（Claude Code / Codex / Claude Cowork）。可以用下面的粘贴导入。";
    scanBox.querySelectorAll("[data-imp-i]").forEach(a => a.onclick = (e) => {
      e.preventDefault();
      const s = list[+a.dataset.impI];
      doImport({ path: s.path, mode: a.dataset.impMode });
    });
  }).catch(() => { scanBox.textContent = "扫描失败"; });
  pane.querySelectorAll("[data-del]").forEach(a => a.onclick = async (e) => {
    e.preventDefault();
    await fetch("/api/memory/item/" + encodeURIComponent(a.dataset.del), { method: "DELETE" });
    renderMemoryPane(pane);
  });
}
function renderDataPane(pane, s) {
  pane.innerHTML = `
    <div class="card-item">
      <div class="t">工作空间</div>
      <div class="d" style="margin-bottom:8px">Agent 读写文件与成果输出的文件夹（输入框下方也可快速切换）。</div>
      <div class="form-row">
        <input id="ws-dir" value="${esc(s.workspace_dir)}" placeholder="D:\\我的工作区">
        <button class="btn-plain" id="ws-pick" style="flex:0 0 auto">📂 选择文件夹</button>
      </div>
      <div style="margin-top:4px">
        <button class="btn-brand" id="ws-save">保存</button>
        <button class="btn-plain" id="ws-open">打开当前文件夹</button>
        <span class="ok-msg" id="ws-msg"></span>
      </div>
    </div>
    <div class="card-item">
      <div class="t">清理缓存</div>
      <div class="d" id="cache-desc">统计中…</div>
      <div style="margin-top:8px"><button class="btn-brand" id="cache-clear">🧹 清理缓存</button><span class="ok-msg" id="cache-msg"></span></div>
    </div>
    <div class="card-item">
      <div class="t">💾 数据备份与恢复</div>
      <div class="d" style="margin-bottom:8px">一键把会话记录、记忆、账号、用量、定时任务和全部配置（含 API Key）打包成 tar.gz 存到本机 backups/ 文件夹；换电脑就下载备份文件带走。<b>不含工作空间成果文件</b>（那些你自己看得见）。恢复会先自动备份当前现状，恢复后需重启应用生效。</div>
      <div style="margin-bottom:8px">
        <button class="btn-brand" id="bk-create">立即备份</button>
        <span class="ok-msg" id="bk-msg"></span>
      </div>
      <div id="bk-list" style="font-size: 13px;color:var(--wb-text-2)">加载中…</div>
    </div>
    <div class="card-item">
      <div class="t">数据说明</div>
      <div class="d">会话记录持久化在 data/sessions/ · 定时任务在 schedules.json · 配置在 config.json（含 API Key，默认不入 git）· 记忆在 data/memory.md 与 data/memories.json</div>
    </div>`;
  pane.querySelector("#ws-pick").onclick = async () => {
    const r = await fetch("/api/pick-folder", { method: "POST" }).then(r => r.json()).catch(() => ({}));
    if (r.path) pane.querySelector("#ws-dir").value = r.path;
    else if (r.error) toast("❌ " + r.error);
  };
  pane.querySelector("#ws-save").onclick = () => saveSettings({ workspace_dir: pane.querySelector("#ws-dir").value.trim(), workspace_permanent: true }, pane.querySelector("#ws-msg"))
    .then(ok => { if (ok) fetch("/api/files").then(r => r.json()).then(renderFiles); });
  pane.querySelector("#ws-open").onclick = () => fetch("/api/open-workspace", { method: "POST" });
  const cacheDesc = pane.querySelector("#cache-desc");
  const loadCache = () => fetch("/api/cache").then(r => r.json()).then(c => {
    cacheDesc.textContent = `界面缓存 ${fmtSize(c.ui)} · 临时脚本 ${fmtSize(c.tmp)}，共 ${fmtSize(c.total)}。只清可再生的缓存，不动会话记录、工作区文件和登录态。`;
  }).catch(() => { cacheDesc.textContent = "统计失败"; });
  loadCache();
  pane.querySelector("#cache-clear").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "清理中…";
    try {
      const r = await fetch("/api/cache/clear", { method: "POST" }).then(r => r.json());
      pane.querySelector("#cache-msg").textContent = r.ok ? `已释放 ${fmtSize(r.freed)}` : (r.error || "清理失败");
    } catch { pane.querySelector("#cache-msg").textContent = "清理失败"; }
    btn.disabled = false; btn.textContent = "🧹 清理缓存";
    loadCache();
  };
  // ---- 备份 ----
  const bkMsg = pane.querySelector("#bk-msg");
  const bkList = pane.querySelector("#bk-list");
  const loadBackups = () => fetch("/api/backup").then(r => r.json()).then(d => {
    if (d.error) { bkList.textContent = d.error; return; }
    const list = d.list || [];
    bkList.innerHTML = list.length ? list.map(b => `
      <div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--wb-border)">
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(b.name)}</span>
        <span style="color:var(--wb-text-3)">${fmtSize(b.size)}</span>
        <a href="#" class="link" data-bk-restore="${esc(b.name)}">恢复</a>
        <a href="/api/backup/download/${encodeURIComponent(b.name)}" class="link">下载</a>
        <a href="#" class="link danger" data-bk-del="${esc(b.name)}">删</a>
      </div>`).join("") : "还没有备份。";
    bkList.querySelectorAll("[data-bk-del]").forEach(a => a.onclick = async (e) => {
      e.preventDefault();
      if (!confirm(`确认删除备份 ${a.dataset.bkDel}？`)) return;
      await fetch("/api/backup/" + encodeURIComponent(a.dataset.bkDel), { method: "DELETE" });
      loadBackups();
    });
    bkList.querySelectorAll("[data-bk-restore]").forEach(a => a.onclick = async (e) => {
      e.preventDefault();
      if (!confirm(`确认恢复到备份 ${a.dataset.bkRestore} 的状态？\n\n当前数据会先自动备份一份，恢复后需重启应用生效。`)) return;
      bkMsg.textContent = "恢复中…";
      const r = await fetch("/api/backup/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: a.dataset.bkRestore }) }).then(r => r.json()).catch(() => ({ error: "网络错误" }));
      if (r.error) { bkMsg.textContent = "❌ " + r.error; return; }
      bkMsg.textContent = "";
      if (confirm("已恢复到磁盘（恢复前现状已自动备份）。\n\n现在重启应用让它完全生效？")) {
        const rr = await fetch("/api/backup/restart", { method: "POST" }).then(r => r.json()).catch(() => ({}));
        if (rr.error) toast("❌ " + rr.error);
      } else {
        toast("记得手动重启应用，恢复才完全生效");
      }
      loadBackups();
    });
  }).catch(() => { bkList.textContent = "加载失败"; });
  loadBackups();
  pane.querySelector("#bk-create").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "备份中…";
    const r = await fetch("/api/backup", { method: "POST" }).then(r => r.json()).catch(() => ({ error: "网络错误" }));
    bkMsg.textContent = r.ok ? `✓ 已备份：${r.name}` : ("❌ " + (r.error || "备份失败"));
    btn.disabled = false; btn.textContent = "立即备份";
    loadBackups();
  };
}
// 飞书扫码授权面板：靠本机 lark-cli 跑飞书官方设备码流程
let larkQrPoll = null;
async function renderLarkQr(pane) {
  const box = pane.querySelector("#fs-qr-body");
  if (!box) return;
  const st = await fetch("/api/feishu/lark-cli").then(r => r.json()).catch(() => ({ installed: false }));
  const btn = (id, txt, primary) => `<button class="${primary ? "btn-brand" : ""}" id="${id}" style="margin-right:6px">${txt}</button>`;
  if (!st.installed) {
    box.innerHTML = `本机没找到 lark-cli。装一下再回来：<br><code>npx @larksuite/cli@latest install</code><br>
      <div style="margin-top:8px">${btn("lk-recheck", "装好了，重新检测")}</div>`;
    box.querySelector("#lk-recheck").onclick = () => renderLarkQr(pane);
    return;
  }
  if (!st.configured) {
    box.innerHTML = `lark-cli v${esc(st.version)} 已装，但还没绑定飞书应用。
      把上面填的 App ID / App Secret 写进去就能扫码了（凭证走标准输入，不会出现在进程列表里）。
      <div style="margin-top:8px">${btn("lk-bind", "用上面的凭证绑定", true)}<span class="ok-msg" id="lk-msg"></span></div>`;
    box.querySelector("#lk-bind").onclick = async (e) => {
      const msg = box.querySelector("#lk-msg");
      e.target.disabled = true; msg.textContent = "绑定中…"; msg.style.color = "";
      const d = await fetch("/api/feishu/lark-cli/bind", { method: "POST" }).then(r => r.json()).catch(() => ({ error: "请求失败" }));
      if (d.ok) renderLarkQr(pane);
      else { e.target.disabled = false; msg.style.color = "var(--wb-err)"; msg.textContent = "❌ " + d.error; }
    };
    return;
  }
  const fsAppId = (pane.querySelector("#fs-appid") || {}).value;
  box.innerHTML = `lark-cli v${esc(st.version)} · 应用 <code>${esc(st.app_id)}</code>${st.users ? ` · 已授权：${esc(st.users)}` : " · 还没有用户授权"}
    <div style="margin-top:8px">${btn("lk-login", st.users ? "重新扫码授权" : "扫码授权", true)}${
      st.has_secret && fsAppId !== st.app_id ? btn("lk-import", "把这个应用的凭证填到上面") : ""}<span class="ok-msg" id="lk-msg"></span></div>
    <div id="lk-qr" style="margin-top:10px"></div>`;
  const msg = box.querySelector("#lk-msg");
  const imp = box.querySelector("#lk-import");
  if (imp) imp.onclick = async (e) => {
    e.target.disabled = true; msg.textContent = "导入中…"; msg.style.color = "";
    const d = await fetch("/api/feishu/lark-cli/import", { method: "POST" }).then(r => r.json()).catch(() => ({ error: "请求失败" }));
    if (d.ok) { msg.style.color = "var(--wb-ok)"; msg.textContent = "✅ 已填入并保存，可以点上面的「测试连接」了"; renderSettings("im"); }
    else { e.target.disabled = false; msg.style.color = "var(--wb-err)"; msg.textContent = "❌ " + d.error; }
  };
  box.querySelector("#lk-login").onclick = async (e) => {
    const qr = box.querySelector("#lk-qr");
    e.target.disabled = true; msg.textContent = "取授权链接…"; msg.style.color = "";
    const d = await fetch("/api/feishu/qr/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(r => r.json()).catch(() => ({ error: "请求失败" }));
    e.target.disabled = false;
    if (!d.ok) { msg.style.color = "var(--wb-err)"; msg.textContent = "❌ " + (d.error || "启动失败"); return; }
    msg.textContent = "";
    qr.innerHTML = `<div style="display:flex;gap:12px;align-items:flex-start">
      ${d.qr ? `<img src="${d.qr}" width="176" height="176" style="border:1px solid var(--wb-border);border-radius:8px;image-rendering:pixelated">` : ""}
      <div style="min-width:0">
        <div><b>用飞书 App 扫这个码</b>，或在浏览器打开下面的链接：</div>
        <div style="margin:6px 0"><a href="${esc(d.url)}" target="_blank" rel="noreferrer" style="word-break:break-all">${esc(d.url)}</a></div>
        <div id="lk-qr-st" style="color:var(--wb-text-3)">等待授权…（${d.expires_in} 秒内有效）</div>
        <div style="margin-top:8px"><button id="lk-cancel">取消</button></div>
      </div></div>`;
    qr.querySelector("#lk-cancel").onclick = () => {
      clearInterval(larkQrPoll); larkQrPoll = null;
      fetch("/api/feishu/qr/cancel", { method: "POST" }).catch(() => {});
      qr.innerHTML = "";
    };
    clearInterval(larkQrPoll);
    larkQrPoll = setInterval(async () => {
      const s2 = await fetch("/api/feishu/qr/status").then(r => r.json()).catch(() => null);
      const line = qr.querySelector("#lk-qr-st");
      if (!s2 || !line) { clearInterval(larkQrPoll); larkQrPoll = null; return; }
      if (s2.state === "ok") {
        clearInterval(larkQrPoll); larkQrPoll = null;
        qr.innerHTML = `<div style="color:var(--wb-ok-text)">✅ 授权成功${s2.user ? "：" + esc(s2.user) : ""}。现在 AI 可以用 lark-cli 以你的身份操作飞书了。</div>`;
        renderLarkQr(pane);
      } else if (s2.state === "error") {
        clearInterval(larkQrPoll); larkQrPoll = null;
        line.style.color = "var(--wb-err)";
        line.textContent = "❌ " + (s2.error || "授权失败");
      }
    }, 2500);
  };
}
function renderImPane(pane, s) {
  pane.innerHTML = `
    <div class="card-item">
      <div class="t">飞书机器人（长连接，无需公网地址）</div>
      <div class="d" style="margin-bottom:8px">飞书开放平台创建自建应用：① 添加「机器人」能力 ② 权限开通 im:message 与 im:message:send_as_bot ③ 事件订阅方式选「<b>使用长连接接收事件</b>」并添加 im.message.receive_v1 ④ 发布一个版本。填好凭证保存后自动建立长连接，在飞书私聊或 @机器人 即可远程下任务。</div>
      <input id="fs-appid" placeholder="App ID" value="${esc(s.im.feishu.app_id)}">
      <input id="fs-secret" type="password" placeholder="App Secret" value="${esc(s.im.feishu.app_secret)}">
      <input id="fs-vtoken" placeholder="Verification Token（可选，仅旧回调模式用）" value="${esc(s.im.feishu.verification_token)}">
      <div style="margin-top:8px"><button class="btn-brand" id="fs-test">测试连接</button><span class="ok-msg" id="fs-test-r"></span></div>
    </div>
    <div class="card-item" id="fs-qr-card">
      <div class="t">扫码授权「你本人」的飞书身份（可选）</div>
      <div class="d" style="margin-bottom:8px">上面那组凭证是<b>机器人</b>的身份，只够收发消息。要让 AI 以<b>你本人</b>的身份读日历、翻云文档、查邮件、建表格，就在这里扫码授权一次——走飞书官方设备码流程，密码不经过 OpenWorkBuddy。<br>依赖本机的 <a href="https://github.com/larksuite/cli" target="_blank" rel="noreferrer">lark-cli</a>（MIT），没装的话：<code>npx @larksuite/cli@latest install</code>。</div>
      <div id="fs-qr-body" class="d">检测 lark-cli…</div>
    </div>
    <div class="card-item">
      <div class="t">飞书云文档凭证（可选）</div>
      <div class="d" style="margin-bottom:8px">AI 用 feishu_doc_create 工具直接生成飞书云文档。默认用上面机器人的凭证；若那个应用没开「云文档」权限，可在这里另填一组开通了 <b>docx:document</b>（建议再加 drive:drive）权限的应用凭证。</div>
      <input id="fs-docid" placeholder="云文档 App ID（留空=用机器人凭证）" value="${esc(s.im.feishu.doc_app_id || "")}">
      <input id="fs-docsecret" type="password" placeholder="云文档 App Secret" value="${esc(s.im.feishu.doc_app_secret || "")}">
    </div>
    <div class="card-item">
      <div class="t">QQ 官方机器人（长连接，无需公网地址）</div>
      <div class="d" style="margin-bottom:8px">QQ 开放平台 <b>q.qq.com</b> 创建「机器人」：① 开发设置里拿 AppID / AppSecret ② 功能配置 → 消息列表里开启<b>私聊消息</b>和<b>群聊 @机器人 消息</b> ③ 沙箱环境只对白名单群/好友生效，正式使用需提交审核发布。填好保存后自动建立长连接，私聊机器人或群里 @它即可下任务。</div>
      <input id="qq-appid" placeholder="AppID" value="${esc(s.im.qq.app_id)}">
      <input id="qq-secret" type="password" placeholder="AppSecret" value="${esc(s.im.qq.app_secret)}">
      <div style="margin-top:8px"><button class="btn-brand" id="qq-test">测试连接</button><span class="ok-msg" id="qq-test-r"></span></div>
    </div>
    <div class="card-item">
      <div class="t">微信（扫码登录，无需公网地址）</div>
      <div class="d" style="margin-bottom:8px">微信自己的机器人通道：点下面按钮出二维码，用<b>要当机器人的那个微信号</b>扫码确认，之后本机主动长轮询收发消息，<b>不需要公网地址</b>。别人给这个微信号发消息就等于给 OpenWorkBuddy 下任务，结果直接回到微信聊天里。<br>⚠️ 登录态由微信控制，失效（服务端返回 -14）后需要重新扫码；图片/文件/视频本版只识别为占位标签，语音有微信自带转写就用转写文字。</div>
      <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">
        <div>
          <button class="btn-brand" id="ilk-qr">获取二维码</button>
          <button class="btn-plain" id="ilk-off" style="margin-left:6px">断开登录</button>
        </div>
        <div id="ilk-box" style="display:none"><img id="ilk-img" alt="微信登录二维码" style="width:180px;height:180px;border-radius:8px;background:#fff;padding:6px"></div>
      </div>
      <div class="ok-msg" id="ilk-r" style="margin-top:8px">${(s.im.wechat_ilink || {}).bot_id ? "已绑定微信号，状态见上方助理面板" : ""}</div>
    </div>
    <div class="card-item">
      <div class="t">企业微信自建应用（双向对话，需公网地址）</div>
      <div class="d" style="margin-bottom:8px">微信侧没有长连接模式，只能腾讯回调你：需要一个公网 HTTPS 地址指向本机（内网穿透/反向代理都行），回调路径填 <code>https://你的域名/im/wecom/events</code>。<br>企业微信管理后台 → 应用管理 → 自建应用：拿 AgentId 与 Secret，「我的企业」拿 CorpID；「接收消息 → 设置 API 接收」里随机生成 Token 与 EncodingAESKey 回填这里，再点保存让腾讯验证地址。结果通过应用消息主动推送，agent 跑几分钟也不怕超时。</div>
      <input id="wca-corp" placeholder="CorpID（我的企业 → 企业信息）" value="${esc(s.im.wecom_app.corp_id)}">
      <input id="wca-agent" placeholder="AgentId（自建应用页，纯数字）" value="${esc(s.im.wecom_app.agent_id)}">
      <input id="wca-secret" type="password" placeholder="应用 Secret" value="${esc(s.im.wecom_app.secret)}">
      <input id="wca-token" placeholder="Token（接收消息设置里生成）" value="${esc(s.im.wecom_app.token)}">
      <input id="wca-aes" type="password" placeholder="EncodingAESKey（43 位）" value="${esc(s.im.wecom_app.aes_key)}">
      <div style="margin-top:8px"><button class="btn-brand" id="wca-test">测试凭证</button><span class="ok-msg" id="wca-test-r"></span></div>
    </div>
    <div class="card-item">
      <div class="t">微信公众号（消息落在微信里，需公网地址 + 认证号）</div>
      <div class="d" style="margin-bottom:8px">公众平台 → 开发 → 基本配置：拿 AppID / AppSecret，服务器配置 URL 填 <code>https://你的域名/im/mp/events</code>，消息加解密方式选<b>安全模式</b>，Token 与 EncodingAESKey 回填这里。<br>⚠️ agent 执行常超过 5 秒，来不及走被动回复，结果走「客服消息」异步推送——该接口<b>需要已认证的服务号</b>，未认证订阅号会返回 48001，这里会如实报错不会假装成功。</div>
      <input id="mp-appid" placeholder="AppID" value="${esc(s.im.wechat_mp.app_id)}">
      <input id="mp-secret" type="password" placeholder="AppSecret" value="${esc(s.im.wechat_mp.app_secret)}">
      <input id="mp-token" placeholder="Token（服务器配置里自定义）" value="${esc(s.im.wechat_mp.token)}">
      <input id="mp-aes" type="password" placeholder="EncodingAESKey（43 位，安全模式必填）" value="${esc(s.im.wechat_mp.aes_key)}">
      <div style="margin-top:8px"><button class="btn-brand" id="mp-test">测试凭证</button><span class="ok-msg" id="mp-test-r"></span></div>
    </div>
    <div class="card-item">
      <div class="t">企业微信群推送</div>
      <div class="d" style="margin-bottom:8px">群里添加"群机器人"，webhook 地址粘贴到这里，任务与定时任务结果自动推送到群。只出不进，要双向对话用上面的自建应用。</div>
      <input id="wc-hook" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." value="${esc(s.im.wecom_bot_webhook)}">
    </div>
    <div class="card-item">
      <div class="t">钉钉机器人推送</div>
      <div class="d" style="margin-bottom:8px">钉钉群 → 群设置 → 机器人 → 添加「自定义机器人」，安全设置选<b>加签</b>，把 webhook 与加签密钥填到这里，任务与定时任务结果自动推送到群。</div>
      <input id="dt-hook" placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." value="${esc(s.im.dingtalk_webhook || "")}">
      <input id="dt-secret" type="password" placeholder="加签密钥 SEC...（安全设置未选加签则留空）" value="${esc(s.im.dingtalk_secret || "")}">
    </div>
    <div class="card-item">
      <div class="t">通用 Webhook 密钥</div>
      <div class="d" style="margin-bottom:8px">外部工具（微信框架/钉钉 outgoing/快捷指令）调用 POST /im/task 时的校验密钥。</div>
      <input id="wh-secret" placeholder="自定义一个密钥" value="${esc(s.im.webhook_secret)}">
    </div>
    <div class="card-item">
      <div class="t">会话管理</div>
      <div class="d" style="margin-bottom:8px">IM 里长时间没对话后，下一条消息自动开启新会话（旧上下文不再带入，节省 token、避免话题串味）。设为 0 关闭。</div>
      <div style="display:flex;align-items:center;gap:8px;font-size: 14px">超过 <input id="im-idle" type="number" min="0" max="720" style="width:80px;margin:0" value="${esc(String(s.im.session_idle_hours ?? 0))}"> 小时未对话，自动开启新会话</div>
    </div>
    <div class="card-item">
      <div class="t">其他助理通道</div>
      <div class="d">微信客服号、微信小程序、企微「智能助理」等入口依赖腾讯的定向接入资质，复刻版<b>暂未内置</b>（不做假连接）。已有第三方微信/QQ 框架的话，用上面的「通用 Webhook」即可桥接同样效果。</div>
    </div>
    <button class="btn-brand" id="im-save">保存</button><span class="ok-msg" id="im-msg"></span>`;
  const imPayload = () => ({
      im: {
        feishu: {
          app_id: pane.querySelector("#fs-appid").value.trim(),
          app_secret: pane.querySelector("#fs-secret").value.trim(),
          verification_token: pane.querySelector("#fs-vtoken").value.trim(),
          doc_app_id: pane.querySelector("#fs-docid").value.trim(),
          doc_app_secret: pane.querySelector("#fs-docsecret").value.trim(),
        },
        qq: {
          app_id: pane.querySelector("#qq-appid").value.trim(),
          app_secret: pane.querySelector("#qq-secret").value.trim(),
        },
        wecom_app: {
          corp_id: pane.querySelector("#wca-corp").value.trim(),
          agent_id: pane.querySelector("#wca-agent").value.trim(),
          secret: pane.querySelector("#wca-secret").value.trim(),
          token: pane.querySelector("#wca-token").value.trim(),
          aes_key: pane.querySelector("#wca-aes").value.trim(),
        },
        wechat_mp: {
          app_id: pane.querySelector("#mp-appid").value.trim(),
          app_secret: pane.querySelector("#mp-secret").value.trim(),
          token: pane.querySelector("#mp-token").value.trim(),
          aes_key: pane.querySelector("#mp-aes").value.trim(),
        },
        wecom_bot_webhook: pane.querySelector("#wc-hook").value.trim(),
        dingtalk_webhook: pane.querySelector("#dt-hook").value.trim(),
        dingtalk_secret: pane.querySelector("#dt-secret").value.trim(),
        session_idle_hours: +pane.querySelector("#im-idle").value || 0,
        webhook_secret: pane.querySelector("#wh-secret").value.trim(),
      },
    });
  pane.querySelector("#im-save").onclick = () =>
    saveSettings(imPayload(), pane.querySelector("#im-msg")).then(ok => { if (ok) setTimeout(refreshImStatus, 1500); });
  pane.querySelector("#fs-test").onclick = async () => {
    const r = pane.querySelector("#fs-test-r");
    r.style.color = "";
    r.textContent = "测试中…";
    try {
      const resp = await fetch("/im/feishu/test", { method: "POST" });
      const d = await resp.json();
      if (d.ok) {
        r.textContent = `✅ 凭证有效${d.bot_name ? `，机器人「${d.bot_name}」` : ""}，长连接：${WS_STATE_TXT[d.ws.state] || d.ws.state}`;
      } else {
        r.style.color = "var(--wb-err)";
        r.textContent = `❌ ${d.error || "测试失败"}`;
      }
    } catch (e) {
      r.style.color = "var(--wb-err)";
      r.textContent = `❌ ${e.message}`;
    }
    refreshImStatus();
  };
  renderLarkQr(pane);
  // 测试按钮先保存再测：服务端拿的是 config 里的值，不先落盘就会测出「未配置」
  const wireTest = (btnId, outId, url, body, onOk) => {
    pane.querySelector(btnId).onclick = async () => {
      const r = pane.querySelector(outId);
      r.style.color = "";
      r.textContent = "保存中…";
      try {
        if (!(await saveSettings(imPayload(), pane.querySelector("#im-msg")))) {
          r.textContent = "";
          return;
        }
        r.textContent = "测试中…";
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {}),
        });
        const d = await resp.json();
        if (d.ok) r.textContent = onOk(d);
        else {
          r.style.color = "var(--wb-err)";
          r.textContent = `❌ ${d.error || "测试失败"}`;
        }
      } catch (e) {
        r.style.color = "var(--wb-err)";
        r.textContent = `❌ ${e.message}`;
      }
      refreshImStatus();
    };
  };
  wireTest("#qq-test", "#qq-test-r", "/im/qq/test", {},
    (d) => `✅ 凭证有效，长连接：${WS_STATE_TXT[d.ws && d.ws.state] || (d.ws && d.ws.state) || "启动中"}`);
  wireTest("#wca-test", "#wca-test-r", "/im/wechat/test", { which: "wecom" },
    () => "✅ 凭证有效（CorpID + Secret 能换到 access_token）。回调地址还需你自己暴露公网 HTTPS 并在后台点「保存」验证。");
  wireTest("#mp-test", "#mp-test-r", "/im/wechat/test", { which: "mp" },
    () => "✅ 凭证有效（AppID + AppSecret 能换到 access_token）。回调地址还需你自己暴露公网 HTTPS 并在公众平台点「提交」验证。");

  // 微信扫码登录：取码 → 轮询状态（服务端一次挂最多 35 秒，回 wait 就接着问）
  const ilkR = pane.querySelector("#ilk-r"), ilkBox = pane.querySelector("#ilk-box"), ilkImg = pane.querySelector("#ilk-img");
  let ilkRun = 0; // 每次点「获取二维码」自增，旧轮询看见对不上就自己退出，防止两轮并行
  const ilkSay = (txt, err) => { ilkR.style.color = err ? "var(--wb-err)" : ""; ilkR.textContent = txt; };
  pane.querySelector("#ilk-qr").onclick = async () => {
    const run = ++ilkRun;
    ilkBox.style.display = "none";
    ilkSay("正在取二维码…");
    let qrcode;
    try {
      const d = await fetch("/im/wechat/qrcode", { method: "POST" }).then(r => r.json());
      if (!d.ok) return ilkSay(`❌ ${d.error || "取二维码失败"}`, true);
      if (!d.image) return ilkSay("❌ 二维码渲染失败（服务端缺 qrcode 依赖）", true);
      qrcode = d.qrcode;
      ilkImg.src = d.image;
      ilkBox.style.display = "";
      ilkSay("请用要当机器人的微信扫码，并在手机上点确认");
    } catch (e) { return ilkSay(`❌ ${e.message}`, true); }
    for (;;) {
      if (run !== ilkRun) return; // 已经重新取码了，这轮作废
      let d;
      try {
        d = await fetch(`/im/wechat/qrcode-status?qrcode=${encodeURIComponent(qrcode)}`).then(r => r.json());
      } catch (e) { await new Promise(z => setTimeout(z, 2000)); continue; } // 网络抖动不算失败，接着问
      if (run !== ilkRun) return;
      if (!d.ok) return ilkSay(`❌ ${d.error || "轮询失败"}`, true);
      if (d.status === "confirmed") {
        ilkBox.style.display = "none";
        ilkSay(`✅ 已连接微信${d.ilink && d.ilink.bot_id ? `（${d.ilink.bot_id}）` : ""}，现在给这个微信号发消息即可下任务`);
        refreshImStatus();
        return;
      }
      if (d.status === "expired") {
        ilkBox.style.display = "none";
        return ilkSay("二维码已过期，请重新获取", true);
      }
      if (d.status === "scaned") ilkSay("已扫码，请在手机上点确认");
    }
  };
  pane.querySelector("#ilk-off").onclick = async () => {
    ilkRun++; // 断开也要作废在跑的轮询，否则它扫码成功后又把登录态写回来
    ilkBox.style.display = "none";
    ilkSay("断开中…");
    try {
      const d = await fetch("/im/wechat/disconnect", { method: "POST" }).then(r => r.json());
      ilkSay(d.ok ? "已断开，登录态已清除" : `❌ ${d.error || "断开失败"}`, !d.ok);
    } catch (e) { ilkSay(`❌ ${e.message}`, true); }
    refreshImStatus();
  };
}

// ================= 安全中心面板 =================
