async function renderHubMcp(box) {
  box.innerHTML = '<div class="hub-empty">加载中…</div>';
  // 连接器的配置里躺着 API Key 和令牌（env / headers），加一条就等于替整台服务器接了个外部系统——
  // 这是最不该摆给每个人的一颗按钮。成员看得到接了哪些、注入了多少工具（他的 agent 用的就是这些），
  // 但「＋ 添加连接器」「接入」「删除」和那张填 Key 的表单整块都不画。
  const po = amPlatformOwner();
  const [data, cat] = await Promise.all([
    fetch("/api/mcp").then(r => r.json()).catch(() => ({ servers: [], total_tools: 0 })),
    fetch("/api/mcp/catalog").then(r => r.json()).catch(() => ({ items: [], categories: [], tools: {} })),
  ]);
  const list = data.servers
    .map((sv, i) => ({ sv, i }))
    .filter(({ sv }) => (!hubState.mine || sv.connected) && hubMatch(hubState.q, sv.name, sv.command, sv.url, (sv.args || []).join(" ")));
  // 原样存回去用的形状：远程只回 name+url，本地只回 name+command+args。
  // 请求头和环境变量里都是令牌，GET 只给键名；POST 不带它们时后端沿用原来那份，别把 Key 洗没了。
  const isRemote = sv => sv.transport === "streamable-http" || (!sv.command && !!sv.url);
  const keep = sv => isRemote(sv)
    ? { name: sv.name, url: sv.url }
    : { name: sv.name, command: sv.command, args: sv.args };
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
  // ---- 推荐连接器（预设目录）：搜索框一起过滤；「只看已连接」时不显示 ----
  const configured = new Set(data.servers.map(sv => sv.name));
  const items = cat.items || [];
  const tools = cat.tools || {};
  const presets = hubState.mine ? [] : items.filter(it => hubMatch(hubState.q, it.name, it.label, it.desc, it.category));
  const keyCount = it => Object.keys(it.env || {}).length + Object.keys(it.headers || {}).length;
  const missingTool = it => it.needs && !tools[it.needs] ? it.needs : "";
  const presetCard = it => {
    const on = configured.has(it.name), miss = missingTool(it), keys = keyCount(it);
    return `<div class="ex-card" data-pi="${items.indexOf(it)}">
      ${on ? '<span class="flag">已接入</span>' : miss ? `<span class="flag" style="color:var(--wb-err-text)">没找到 ${esc(miss)}</span>` : ""}
      <div class="hd"><div class="av">${it.icon || "🔌"}</div>
        <div class="nm"><span>${esc(it.label || it.name)}</span><span class="al">${esc(it.name)}</span></div></div>
      <div class="ds">${esc(it.desc || "")}</div>
      <div class="tg">${it.kind === "http" ? "<i>远程</i>" : `<i>${esc(String(it.command || "").split(/[\\/]/).pop())}</i>`}${keys ? `<i>要填 ${keys} 个 Key</i>` : "<i>免 Key</i>"}${it.docs ? `<a class="mcp-docs-link" href="${esc(it.docs)}" target="_blank" rel="noopener">去哪拿 →</a>` : ""}</div>
      ${po ? `<div class="ops"><button class="mcp-use${on ? "" : " primary"}"${on ? " disabled" : ""}>${on ? "已接入" : "接入"}</button></div>` : ""}
    </div>`;
  };
  const presetSec = !po || !presets.length ? "" : `
    <div class="hub-sec-title" style="margin-top:22px">推荐连接器
      <span class="sub">点「接入」我会把启动命令填好，要 Key 的填上就能连；都是官方或社区现成的 MCP 服务器</span></div>
    ${!tools.uvx && presets.some(it => it.needs === "uvx") ? '<div class="hub-desc">本机没找到 uvx：标着 uvx 的连接器要先装 uv（macOS 装法：brew install uv）</div>' : ""}
    ${!tools.npx && presets.some(it => it.needs && it.needs !== "uvx") ? '<div class="hub-desc">本机没找到 npx：先装 Node.js（自带 npx）再来接本地连接器</div>' : ""}
    ${(cat.categories || []).map(c => {
      const its = presets.filter(it => it.category === c);
      return its.length ? `<div class="hub-desc" style="margin-top:12px">${esc(c)}</div><div class="card-grid">${its.map(presetCard).join("")}</div>` : "";
    }).join("")}`;
  box.innerHTML = `
    <div class="hub-sec-title" style="margin-top:14px">已接入的外部工具
      <span class="sub">通过 MCP（本地 stdio / 远程 Streamable HTTP）给智能体接外部能力，当前 ${data.servers.length} 个服务器 · <b>${data.total_tools}</b> 个工具已注入，任务里可直接调用</span></div>
    <div class="card-grid">
      ${po ? `<div class="ex-card add" id="mcp-open-add">＋ 添加连接器</div>` : ""}
      ${list.map(({ sv, i }) => `
        <div class="ex-card" data-mi="${i}">
          ${sv.plugin ? `<span class="flag">来自插件 ${esc(sv.plugin)}</span>` : ""}
          <div class="hd"><div class="av">${sv.connected ? "🔌" : "⚠️"}</div>
            <div class="nm"><span>${esc(sv.name)}</span><span class="al" style="color:var(${sv.connected ? "--wb-ok" : "--wb-err"})">${sv.connected ? `已连接 · ${sv.tools.length} 个工具` : "未连接"}</span></div></div>
          <div class="ds" style="font-family:var(--mono,ui-monospace,monospace);font-size: 12px;word-break:break-all">${isRemote(sv)
            ? `<b style="font-family:inherit;opacity:.6">远程 ·</b> ` + esc(sv.url) + ((sv.header_keys || []).length ? ` <span style="opacity:.7">（带 ${sv.header_keys.length} 个请求头：${esc(sv.header_keys.join("、"))}）</span>` : "")
            : `<b style="font-family:inherit;opacity:.6">本地 ·</b> ` + esc(sv.command) + " " + esc((sv.args || []).join(" ")) + ((sv.env_keys || []).length ? ` <span style="opacity:.7">（带 ${sv.env_keys.length} 个环境变量：${esc(sv.env_keys.join("、"))}）</span>` : "")}</div>
          <div class="tg">${sv.connected
            ? (sv.tools || []).slice(0, 8).map(t => `<i title="${esc(t.description || "")}">${esc(t.name)}</i>`).join("") + ((sv.tools || []).length > 8 ? `<i>…共 ${sv.tools.length} 个</i>` : "")
            : `<i style="color:var(--wb-err-text)">${esc(sv.error || "命令启动失败或握手超时，详见应用日志")}</i>`}</div>
          <div class="ops">${!po ? "" : sv.plugin
            ? '<button disabled title="这条是插件声明的，要去「插件」页卸载整个插件">插件提供</button>'
            : '<button class="mcp-del">删除</button>'}</div>
        </div>`).join("")}
      ${list.length ? "" : `<div class="hub-empty">${hubState.mine ? "没有已连接的连接器" : (po
        ? "还没有连接器，从下面的推荐里挑一个点「接入」"
        : "这台服务器还没接外部系统。接连接器要填 API Key，归平台管理员，需要什么跟他说一声")}</div>`}
    </div>
    ${!po ? "" : `<div class="ex-editor" id="mcp-add-form" style="display:none;margin-top:14px">
      <div class="hub-sec-title">添加连接器
        <span class="sub">本地进程走 stdio；托管在别人服务器上的走 Streamable HTTP，填地址就行</span></div>
      <div class="row" style="gap:14px">
        <label style="display:flex;gap:5px;align-items:center;flex:none"><input type="radio" name="mcp-kind" value="stdio" checked style="width:auto">本地命令（stdio）</label>
        <label style="display:flex;gap:5px;align-items:center;flex:none"><input type="radio" name="mcp-kind" value="http" style="width:auto">远程地址（Streamable HTTP）</label>
      </div>
      <div class="row"><div style="flex:1 1 150px"><label>名称</label><input id="mcp-name" placeholder="filesystem"></div>
        <div class="mcp-f-stdio" style="flex:1 1 120px"><label>命令</label><input id="mcp-cmd" placeholder="npx"></div>
        <div class="mcp-f-stdio" style="flex:2 1 320px"><label>参数（空格分隔）</label><input id="mcp-args" placeholder="-y @modelcontextprotocol/server-filesystem ~/Documents"></div>
        <div class="mcp-f-http" style="flex:2 1 320px;display:none"><label>地址</label><input id="mcp-url" placeholder="https://example.com/mcp"></div>
        <div class="mcp-f-http" style="flex:2 1 320px;display:none"><label>请求头（可选，每行 Key: Value）</label><input id="mcp-headers" placeholder="Authorization: Bearer 你的令牌"></div></div>
      <div class="row"><div class="mcp-f-stdio" style="flex:1 1 100%"><label>环境变量 <span class="lh">API Key 之类放这里，每行一个 KEY=值，不需要就空着</span></label>
        <textarea id="mcp-env" rows="2" placeholder="BRAVE_API_KEY=你的 Key"></textarea></div></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn-brand" id="mcp-add">添加并连接</button>
        <button id="mcp-cancel" style="padding:6px 14px">取消</button>
        <a id="mcp-docs" href="#" target="_blank" rel="noopener" style="display:none;font-size:13px">去哪拿 Key →</a>
        <span class="ab-empty" id="mcp-msg"></span></div>
    </div>`}` + presetSec;
  const form = box.querySelector("#mcp-add-form");
  if (!po) return; // 下面全是写的那条路：表单、接入、删除，成员一颗都没画，也就没什么可绑
  const openForm = () => { form.style.display = ""; form.scrollIntoView({ behavior: "smooth", block: "nearest" }); };
  box.querySelector("#mcp-open-add").onclick = openForm;
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
  const syncKind = () => {
    const http = kindOf() === "http";
    box.querySelectorAll(".mcp-f-stdio").forEach(el => el.style.display = http ? "none" : "");
    box.querySelectorAll(".mcp-f-http").forEach(el => el.style.display = http ? "" : "none");
  };
  box.querySelectorAll('input[name="mcp-kind"]').forEach(r => r.onchange = syncKind);
  // 「接入」：把预设填进表单，缺 Key 的把光标停在 Key 上，不缺的直接可以点「添加并连接」
  box.querySelectorAll(".ex-card[data-pi] .mcp-use").forEach(b => b.onclick = () => {
    const it = items[+b.closest(".ex-card").dataset.pi];
    if (!it) return;
    const http = it.kind === "http";
    box.querySelector(`input[name="mcp-kind"][value="${http ? "http" : "stdio"}"]`).checked = true;
    syncKind();
    box.querySelector("#mcp-name").value = it.name;
    box.querySelector("#mcp-cmd").value = it.command || "";
    box.querySelector("#mcp-args").value = (it.args || []).join(" ");
    box.querySelector("#mcp-url").value = it.url || "";
    box.querySelector("#mcp-headers").value = Object.entries(it.headers || {}).map(([k, v]) => `${k}: ${v}`).join("\n");
    box.querySelector("#mcp-env").value = Object.entries(it.env || {}).map(([k, v]) => `${k}=${v}`).join("\n");
    // 值为空的就是必填：添加时校验，别让一个注定连不上的配置进 config
    const needEnv = Object.keys(it.env || {}).filter(k => !String(it.env[k]).trim());
    const needHdr = Object.keys(it.headers || {}).filter(k => !String(it.headers[k]).replace(/^Bearer\s*/i, "").trim());
    form.dataset.needEnv = needEnv.join(",");
    form.dataset.needHdr = needHdr.join(",");
    const docs = box.querySelector("#mcp-docs");
    docs.href = it.docs || "#"; docs.style.display = it.docs ? "" : "none";
    const need = needEnv.concat(needHdr);
    box.querySelector("#mcp-msg").textContent = need.length ? `还差 ${need.join("、")} 没填，填好点「添加并连接」` : "启动命令已填好，点「添加并连接」就能用";
    openForm();
    (need.length ? box.querySelector(http ? "#mcp-headers" : "#mcp-env") : box.querySelector("#mcp-add")).focus();
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
      const missing = (form.dataset.needHdr || "").split(",").filter(Boolean).filter(k => !String(headers[k] || "").replace(/^Bearer\s*/i, "").trim());
      if (missing.length) return toast(`❌ 还差 ${missing.join("、")} 没填`);
      return save(ownServers().concat([{ name, url, headers }]));
    }
    const cmd = box.querySelector("#mcp-cmd").value.trim();
    const args = box.querySelector("#mcp-args").value.trim().split(/\s+/).filter(Boolean);
    if (!cmd) return toast("❌ 本地连接器要填命令");
    // 「KEY=值」按第一个等号切，值里带等号（base64）也不会被切坏；没写值的行直接不要
    const env = {};
    for (const line of box.querySelector("#mcp-env").value.split(/\n+/).map(s => s.trim()).filter(Boolean)) {
      const at = line.indexOf("=");
      if (at <= 0) return toast("❌ 环境变量要写成 KEY=值");
      const k = line.slice(0, at).trim(), v = line.slice(at + 1).trim();
      if (v) env[k] = v;
    }
    const missing = (form.dataset.needEnv || "").split(",").filter(Boolean).filter(k => !env[k]);
    if (missing.length) return toast(`❌ 还差 ${missing.join("、")} 没填`);
    save(ownServers().concat([{ name, command: cmd, args, env }]));
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
// [id, 名字, 图标]：左栏一眼扫过去靠图标认，名字收短，别一列密密麻麻的字
const SETTING_CATS = [
  ["models", "模型", "🧠"],
  ["search", "联网搜索", "🔎"],
  ["agent", "智能体", "🤖"],
  ["security", "安全", "🛡️"],
  ["shortcuts", "快捷键", "⌨️"],
  ["persona", "个性化", "🎭"],
  ["look", "外观", "🎨"],
  ["memory", "记忆", "📝"],
  ["evolve", "自进化", "🌱"],
  ["data", "数据", "🗂️"],
  ["im", "助理设置", "📱"],
  ["about", "关于", "ℹ️"],
];
/**
 * 这四页从头到尾都是服务器级的：联网搜索的 Key、自进化规则、备份/工作目录、飞书企微钉钉接入。
 * 多人服务器上的普通成员每一颗按钮都会 403，连一行属于他自己的东西都没有——那就别画这个标签页。
 * （models / persona / security 是混的：里面有他自己的东西，标签留着，卡片各自按 platform_owner 挑。）
 */
const PLATFORM_ONLY_CATS = new Set(["search", "evolve", "data", "im"]);
async function renderSettings(active) {
  const s = await fetch("/api/settings").then(r => r.json());
  const cats = s.platform_owner ? SETTING_CATS : SETTING_CATS.filter(([k]) => !PLATFORM_ONLY_CATS.has(k));
  // 从别处跳进一个已经不画的标签页（旧的深链、上次停在「数据」页），别留一屏空白：退回模型页
  if (!cats.some(([k]) => k === active)) active = cats[0][0];
  mBody.innerHTML = `<div class="settings-layout">
    <div class="settings-nav">${cats.map(([k, label, icon]) =>
      `<div class="cat ${k === active ? "active" : ""}" data-cat="${k}"><span class="ci">${icon}</span>${label}</div>`).join("")}</div>
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
  else if (active === "look") renderLookPane(pane);
  else if (active === "memory") renderMemoryPane(pane);
  else if (active === "evolve") renderEvolvePane(pane);
  else if (active === "data") renderDataPane(pane, s);
  else if (active === "security") renderSecurityPane(pane, s);
  else if (active === "shortcuts") renderShortcutsPane(pane, s);
  else if (active === "im") renderImPane(pane, s);
  else renderAboutPane(pane);
}
/**
 * 保存失败的原因存在这儿。
 *
 * saveSettings 二十来个调用点都拿它当布尔用（`if (!ok) …`），改成返回对象会让每一处
 * `{ok:false}` 都是真值——那是比现在更糟的 bug。所以照旧返回布尔，原因另放一个格子：
 * 调用点想说清楚就读它，不想读也不会坏。
 */
let lastSaveError = "";
async function saveSettings(patch, msgEl) {
  const resp = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
  const data = await resp.json().catch(() => ({}));
  lastSaveError = resp.ok ? "" : (data.error || `保存失败（HTTP ${resp.status}）`);
  if (msgEl) msgEl.textContent = resp.ok ? "✓ 已保存并生效" : lastSaveError;
  if (resp.ok) refreshSettingsCache();
  return resp.ok;
}
/* ───────────────────────── 图 / 视频 / 配音 / 看图：多模型配置 ─────────────────────────
 * 老界面是一路一张卡、一张卡一个模型，Key 还得一路填一遍：同一把 OpenRouter Key 抄四次，
 * 换 Key 时漏一处，某一路就在半年后突然 401。
 * 现在拆成两层：上面「渠道」一把 Key 一行，下面四路各挂若干模型、只引用渠道。
 * 模型名不用手打——下拉框三段：精选目录 → 从渠道现拉的活列表 → 自己填。
 */
const MEDIA_CAPS = [
  { cap: "vision", icon: "eye", title: "看图", tool: "look_at_image",
    hint: "你粘贴（⌘V）或拖进来的截图，它带着问题去看，拿回文字。不配也能用——会直接拿上面选中的主模型看；主模型是纯文本的（如 deepseek-chat）会明确报错，那时在这儿加一个能看图的。" },
  { cap: "image", icon: "image", title: "画图", tool: "generate_image",
    hint: "对话里说「画一张…」就会用它，成图存进工作空间。支持 OpenAI 兼容 /images/generations；地址含 dashscope 时自动走通义原生协议。" },
  { cap: "video", icon: "clapperboard", title: "视频", tool: "generate_video",
    hint: "生成一段通常要 1~5 分钟。支持通义万相（地址含 dashscope）和火山方舟 Seedance（地址含 ark / volces）两种协议。" },
  { cap: "tts", icon: "mic", title: "配音", tool: "text_to_speech",
    hint: "把文字念成音频，视频配音、播客旁白用它。支持 OpenAI 兼容 /audio/speech；地址含 dashscope 时自动走通义 qwen-tts 原生协议。" },
];
let mediaCatalog = null; // 精选目录，一次会话拉一次
const liveModels = new Map(); // 渠道 id → 那边 /models 现拉回来的清单
/** 展开着的渠道 id。重画时保留——存完一个模型整张卡自己合上，比不合上更烦人 */
const openChans = new Set();
/** 展开着的那几路能力。四张卡默认全收着：大多数人只配一两路，四段说明一起摊开正是上一版「字太多」的来源 */
const openCaps = new Set();
let chanFirstPaint = true;
let modelsPaneEl = null; // 媒体那半边改完东西，渠道卡上的计数也得跟着变，所以记着 pane 在哪
let rowMenuBound = false;

async function loadMediaCatalog() {
  if (mediaCatalog) return mediaCatalog;
  mediaCatalog = await fetch("/api/model-catalog").then((r) => r.json()).catch(() => ({ kinds: [], catalog: {} }));
  return mediaCatalog;
}

/**
 * 两张表一起存：渠道改了 Key，四路都跟着变，分两次存会出现中间那一下对不上。
 * 存完把服务端规整过的结果（补了 id、重新算了默认项、压平了 config.media）拿回来盖上，
 * 免得界面上显示的还是提交前那份、跟盘里已经不一样。
 */
async function saveAllModelTables(s, msgEl, extra) {
  const patch = { providers: s.providers, models: s.models || [], media_models: s.media_models, ...(extra || {}) };
  const ok = await saveSettings(patch, msgEl);
  if (ok && settingsCache) Object.assign(s, settingsCache); // saveSettings 成功时已经刷过缓存
  return ok;
}
/** 老名字留着：媒体那半边十来处调用点没必要为了改个名字全动一遍 */
function saveMediaTables(s, msgEl) {
  return saveAllModelTables(s, msgEl);
}
/** 媒体那边改完：渠道卡上的「N 个媒体模型」也变了，所以能连带就整页重画 */
function repaintMedia(box, s) {
  if (modelsPaneEl && modelsPaneEl.isConnected && modelsPaneEl.contains(box)) paintModels(modelsPaneEl, s);
  else paintMedia(box, s);
}

function renderMediaPane(box, s) {
  if (!box) return;
  s.providers = s.providers || [];
  s.media_models = s.media_models || [];
  const po = !!s.platform_owner;
  if (!po) {
    box.innerHTML = `
      <div class="card-item">
        <div class="t">${ic("image")}看图 / 画图 / 视频 / 配音用的模型</div>
        <div class="d">这几路配在服务器上，归平台管理员。你直接在对话里用就行（粘张图问它、说「画一张…」），不用在这儿配。</div>
        <div class="d" style="margin-top:6px">${MEDIA_CAPS.map((c) => {
          const n = s.media_models.filter((m) => m.cap === c.cap).length;
          return `${esc(c.title)}：${n ? n + " 个模型可用" : "还没配"}`;
        }).join(" · ")}</div>
      </div>`;
    return;
  }
  loadMediaCatalog().then(() => paintMedia(box, s));
  paintMedia(box, s);
}

function paintMedia(box, s) {
  const provName = (id) => { const p = s.providers.find((x) => x.id === id); return p ? p.name : "（渠道已删）"; };
  box.innerHTML = `
    <div class="sec-t">${ic("image")}看图 / 画图 / 视频 / 配音</div>
    <div class="d" style="margin-bottom:2px">这四路各自挑模型，Key 就用上面渠道里那一把，不用再填一遍。</div>
    ${MEDIA_CAPS.map((c) => capCard(c, s, provName)).join("")}
    <span class="ok-msg" id="media-msg"></span>`;
  bindMedia(box, s);
}

/**
 * 一路能力一张折叠卡，跟上面的渠道卡同一套写法。
 *
 * 老版本四张卡全摊开：每张顶着两三行说明、一排两行高的模型条、一个表单和一颗按钮，
 * 光这四张就吃掉一屏半——可绝大多数人只配一路画图，另外三路一个字都不用看。
 * 现在收起来只剩一行「画图 · generate_image · 2 个 · 默认 即梦」，要动它才展开。
 */
function capCard(c, s, provName) {
  const mine = s.media_models.filter((m) => m.cap === c.cap);
  const open = openCaps.has(c.cap);
  const def = mine.find((m) => m.default) || mine[0];
  const sum = mine.length ? `${mine.length} 个 · 默认 ${esc(def.name || def.model || "")}` : "还没配";
  return `
    <div class="ch-card${open ? " open" : ""}">
      <div class="ch-head" data-cap="${c.cap}">
        ${ic(open ? "chevron-down" : "chevron-right", "ch-caret i-sm")}
        <span class="ch-title"><b>${esc(c.title)}</b><span class="ch-sub">${esc(c.tool)}</span></span>
        <span class="ch-count">${sum}</span>
      </div>
      ${!open ? "" : `<div class="ch-body">
        <div class="ch-note">${esc(c.hint)}</div>
        ${mine.length ? mine.map((m) => {
          const i = s.media_models.indexOf(m);
          const meta = [m.default ? "默认" : "", provName(m.provider), m.voice ? `音色 ${m.voice}` : ""].filter(Boolean).map(esc).join(" · ");
          return `
          <div class="mrow">
            <input type="radio" name="def-${c.cap}" ${m.default ? "checked" : ""} data-def="${i}" title="设为这一路的默认">
            <span class="mrow-name">${esc(m.name)}</span>
            <span class="mrow-id">${esc(m.model)}</span>
            <span class="mrow-meta">${meta}</span>
            ${rowMenu([["mdel", i, "删除", "danger"]])}
          </div>`;
        }).join("") : `<div class="ch-note">还没配。加一个之后 agent 才用得了 ${esc(c.tool)}。</div>`}
        <div class="mm-form" data-cap="${c.cap}" style="display:none;border-top:1px solid var(--wb-border);padding-top:8px;margin-top:6px">
          <div class="form-row">
            <select class="mm-prov"></select>
            <select class="mm-model"></select>
          </div>
          <div class="form-row">
            <input class="mm-custom" placeholder="模型名（上面选「自己填…」时用这个）" style="display:none">
            <input class="mm-name" placeholder="别名（可空，默认用模型名；agent 按这个名字点名）">
            ${c.cap === "tts" ? `<input class="mm-voice" placeholder="默认音色（如 Cherry / alloy，可空）">` : ""}
          </div>
          <div class="d mm-tip" style="font-size:12px;margin-bottom:6px"></div>
          <button class="btn-brand mm-save">添加</button>
          <button class="btn-plain mm-cancel">取消</button>
        </div>
        <button class="btn-plain mm-new" data-cap="${c.cap}" style="margin-top:6px">＋ 添加${esc(c.title)}模型</button>
      </div>`}
    </div>`;
}

function bindMedia(box, s) {
  const msg = box.querySelector("#media-msg");

  // 展开 / 收起：纯前端，不碰服务器
  box.querySelectorAll(".ch-head[data-cap]").forEach((h) => (h.onclick = () => {
    const cap = h.dataset.cap;
    if (openCaps.has(cap)) openCaps.delete(cap); else openCaps.add(cap);
    repaintMedia(box, s);
  }));
  bindRowMenus(box);

  box.querySelectorAll("input[data-def]").forEach((r) => (r.onchange = async () => {
    const t = s.media_models[+r.dataset.def];
    for (const m of s.media_models) if (m.cap === t.cap) m.default = m === t;
    if (await saveMediaTables(s, msg)) repaintMedia(box, s);
  }));
  box.querySelectorAll("a[data-mdel]").forEach((a) => (a.onclick = async (e) => {
    e.preventDefault();
    s.media_models.splice(+a.dataset.mdel, 1);
    if (await saveMediaTables(s, msg)) repaintMedia(box, s);
  }));

  box.querySelectorAll(".mm-new").forEach((b) => (b.onclick = () => {
    const f = box.querySelector(`.mm-form[data-cap="${b.dataset.cap}"]`);
    f.style.display = "";
    fillProvSelect(f, s);
  }));
  box.querySelectorAll(".mm-cancel").forEach((b) => (b.onclick = () => (b.closest(".mm-form").style.display = "none")));
  box.querySelectorAll(".mm-form").forEach((f) => {
    f.querySelector(".mm-prov").onchange = () => fillModelSelect(f, s);
    f.querySelector(".mm-model").onchange = () => {
      const custom = f.querySelector(".mm-model").value === "__custom__";
      f.querySelector(".mm-custom").style.display = custom ? "" : "none";
      if (custom) f.querySelector(".mm-custom").focus();
    };
    f.querySelector(".mm-save").onclick = async () => {
      const cap = f.dataset.cap;
      const sel = f.querySelector(".mm-model").value;
      const model = sel === "__custom__" ? f.querySelector(".mm-custom").value.trim() : sel;
      const prov = f.querySelector(".mm-prov").value;
      if (!prov) return toast("先建一个渠道，模型得挂在渠道上");
      if (!model) return toast("还没选模型");
      const name = f.querySelector(".mm-name").value.trim() || model;
      if (s.media_models.some((m) => m.cap === cap && m.name === name)) return toast(`这一路已经有叫「${name}」的了，换个别名`);
      const voice = f.querySelector(".mm-voice") ? f.querySelector(".mm-voice").value.trim() : "";
      s.media_models.push({ id: "", cap, name, provider: prov, model, voice, default: !s.media_models.some((m) => m.cap === cap) });
      if (await saveMediaTables(s, msg)) repaintMedia(box, s);
    };
  });
}

function fillProvSelect(f, s) {
  const sel = f.querySelector(".mm-prov");
  // Anthropic / DeepSeek / Kimi 只做对话，没有画图配音接口。列出来只会让人选完发现跑不通
  const chatOnly = new Set(((mediaCatalog || {}).kinds || []).filter((k) => k.chat_only).map((k) => k.kind));
  const usable = s.providers.filter((p) => !chatOnly.has(p.kind));
  sel.innerHTML = usable.length
    ? usable.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")
    : `<option value="">（先加一个渠道）</option>`;
  fillModelSelect(f, s);
}

/**
 * 模型下拉的三段：精选目录（这个渠道类型下确认能跑的）→ 从渠道现拉的活列表 → 自己填。
 * 活列表是异步的，先把目录画出来别让人等；拉回来了再把那一组插进去，当前选中的不动。
 */
function fillModelSelect(f, s) {
  const cap = f.dataset.cap;
  const sel = f.querySelector(".mm-model");
  const tip = f.querySelector(".mm-tip");
  const p = s.providers.find((x) => x.id === f.querySelector(".mm-prov").value);
  const cat = ((mediaCatalog || {}).catalog || {})[cap] || [];
  const mine = cat.filter((m) => !p || m.kind === p.kind);
  const others = cat.filter((m) => p && m.kind !== p.kind);
  const opt = (m) => `<option value="${esc(m.id)}">${esc(m.label)}（${esc(m.id)}）</option>`;
  sel.innerHTML =
    (mine.length ? `<optgroup label="这个渠道的精选">${mine.map(opt).join("")}</optgroup>` : "") +
    `<option value="__custom__">自己填…</option>` +
    (others.length ? `<optgroup label="其它渠道的（地址对得上也能用）">${others.map(opt).join("")}</optgroup>` : "");
  f.querySelector(".mm-custom").style.display = sel.value === "__custom__" ? "" : "none";
  tip.textContent = mine.length ? "" : "这个渠道没有精选条目，下面直接填模型名，或等一下从渠道拉回来的列表。";
  if (!p) return;
  const live = liveModels.get(p.id);
  if (live) return injectLive(sel, tip, live, cap);
  tip.textContent = "正在问渠道有哪些模型…";
  fetch("/api/provider-models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: p.id }) })
    .then((r) => r.json())
    .then((d) => { liveModels.set(p.id, d); if (sel.isConnected) injectLive(sel, tip, d, cap); })
    .catch(() => { tip.textContent = ""; });
}

function injectLive(sel, tip, d, cap) {
  if (!d.ok || !d.models || !d.models.length) {
    // 拉不到不是错：很多国产渠道压根没有 /models。目录和手填两条路都还在
    tip.textContent = d.why ? `这个渠道没给模型列表（${d.why}），上面的精选和「自己填…」照用。` : "";
    return;
  }
  const same = d.models.filter((m) => m.cap === cap).map((m) => m.id);
  const rest = d.models.filter((m) => m.cap !== cap).map((m) => m.id);
  const group = (label, ids) => (ids.length ? `<optgroup label="${label}">${ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join("")}</optgroup>` : "");
  const keep = sel.value;
  sel.insertAdjacentHTML("beforeend", group(`这个渠道现有的（看着像${MEDIA_CAPS.find((c) => c.cap === cap).title}的）`, same) + group("这个渠道的其它模型", rest));
  if (keep) sel.value = keep;
  tip.textContent = `从渠道拉到 ${d.models.length} 个模型${d.cached ? "（缓存）" : ""}，挑不到就选「自己填…」。`;
}

/* ───────────────────────── 模型设置：渠道卡片 → 展开看它下面的模型 ─────────────────────────
 * 老界面把每条模型摊成一行，一行里塞名字、模型 id、接口地址、「⚠ 未填 Key 去拿 Key ↗」，
 * 再加编辑 / 复制 / 删除三个链接。一把 OpenRouter 的 Key 挂十个模型，就是十行重复的地址
 * 和十遍一模一样的催填提示——信息全在，但一眼看不出哪条是哪条。
 *
 * 现在按渠道折叠：平时一个渠道一行，要动手才展开；Key 是渠道的属性，所以只在渠道那层提一次；
 * 模型行只留「名字 · 模型 id · 战绩」，改删收进行尾的 ⋯ 里。加模型也从渠道里进，天然共用那把 Key。
 */
function renderModelsPane(pane, s) {
  s.models = s.models || [];
  s.providers = s.providers || [];
  s.media_models = s.media_models || [];
  modelsPaneEl = pane;
  if (chanFirstPaint) {
    // 头一次打开只展开「当前默认模型」所在的那个渠道：人来这一页十有八九是为了换模型，
    // 全展开等于回到老界面那堵墙，全收起又得多点一下才看得见自己在用哪个
    chanFirstPaint = false;
    const cur = s.models.find((m) => m.name === s.active_model);
    if (cur && cur.channel) openChans.add(cur.channel);
  }
  loadMediaCatalog().then(() => { if (pane.isConnected) paintModels(pane, s); });
  paintModels(pane, s);
}

function paintModels(pane, s) {
  // 多人服务器上的普通成员：渠道、Key、全局默认模型改的是**整台服务器**的账单，归平台管理员。
  // 但这一页对他不是没用——他得知道有哪些模型可选、默认是哪个。所以照画，只是不摆那几颗
  // 他一点就 403 的按钮。他自己换模型走输入框右下角那个选择器，存的是他一个人的偏好。
  const po = !!s.platform_owner;
  const kinds = (mediaCatalog || {}).kinds || [];
  const kindLabel = (k) => (kinds.find((x) => x.kind === k) || {}).label || k || "自定义";
  const loose = s.models.filter((m) => !m.channel);
  pane.innerHTML = `
    <div style="color:var(--wb-text-2);margin-bottom:10px">${po
      ? "一个渠道一把 Key，底下挂多少模型都共用它——换 Key 只改这一处。点渠道名展开看它下面的模型。"
      : "这台服务器上能用的模型。渠道和 Key 归平台管理员配——那是整台机器的账单。你自己这一次想用哪个，在输入框右下角随时切，只影响你。"}</div>
    <div id="prov-list">${s.providers.map((p) => chanCard(p, s, po, kindLabel)).join("")
      || `<div class="d" style="padding:8px 0">还没有渠道。先加一个，再往里加模型。</div>`}</div>
    ${!loose.length ? "" : `
    <div class="ch-card open">
      <div class="ch-head" style="cursor:default">
        <span class="ch-title"><b>没挂渠道的</b><span class="ch-sub">地址和 Key 都还空着</span></span>
        <span class="ch-count">${loose.length} 个</span>
      </div>
      <div class="ch-body">${loose.map((m) => modelRow(m, s, po)).join("")}</div>
    </div>`}
    ${!po ? "" : `
    <div id="prov-form" style="display:none;border-top:1px solid var(--wb-border);padding-top:10px;margin-top:8px">
      <select id="pf-kind">${kinds.map((k) => `<option value="${esc(k.kind)}">${esc(k.label)}</option>`).join("")}</select>
      <input id="pf-name" placeholder="给它起个名（如：我的火山方舟）">
      <input id="pf-base" placeholder="接口地址（选了类型会自动填）">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <input id="pf-key" type="password" placeholder="API Key" style="flex:1;min-width:0;margin:0">
        <span id="pf-key-src"></span>
      </div>
      <button class="btn-brand" id="pf-save">保存渠道</button>
      <button class="btn-plain" id="pf-cancel">取消</button>
    </div>
    <button class="btn-plain" id="pf-new" style="margin-top:6px">＋ 添加渠道</button>`}
    <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size: 13px;color:var(--wb-text-2);cursor:pointer">
      <input type="checkbox" id="mf-follow-last" style="width:auto;margin:0" ${s.model_follow_last ? "checked" : ""}>
      新对话自动沿用上次手动选过的模型（不勾则新对话总是用全局默认）
    </label>
    <div id="media-pane" style="margin-top:14px;border-top:1px solid var(--wb-border);padding-top:12px"></div>
    <span class="ok-msg" id="models-msg"></span>`;
  renderMediaPane(pane.querySelector("#media-pane"), s);
  bindModels(pane, s, po);
}

/** 一个渠道一张卡：头是一行摘要，展开才是它底下的模型 */
function chanCard(p, s, po, kindLabel) {
  const i = s.providers.indexOf(p);
  const mine = s.models.filter((m) => m.channel === p.id);
  const mediaN = s.media_models.filter((m) => m.provider === p.id).length;
  const open = openChans.has(p.id);
  // has_key 是读接口给非管理员回的（真 Key 被打了掩码），管理员那边看 api_key 本身
  const noKey = p.has_key === false || !String(p.api_key || "").trim();
  return `
    <div class="ch-card${open ? " open" : ""}">
      <div class="ch-head" data-chan="${esc(p.id)}">
        ${ic(open ? "chevron-down" : "chevron-right", "ch-caret")}
        <span class="ch-title"><b>${esc(p.name)}</b><span class="ch-sub">${esc(kindLabel(p.kind))}</span></span>
        ${po && noKey ? `<span class="ch-warn">${ic("triangle-alert", "i-sm")}未填 Key ${kindKeyLink(p.kind, p.base_url)}</span>` : ""}
        <span class="ch-count">${mine.length} 个对话模型${mediaN ? ` · ${mediaN} 个媒体模型` : ""}</span>
        ${!po ? "" : rowMenu([["pedit", i, "编辑渠道", ""], ["pdel", i, "删除渠道", "danger"]])}
      </div>
      ${!open ? "" : `<div class="ch-body">
        ${mine.length ? mine.map((m) => modelRow(m, s, po)).join("")
          : `<div class="ch-note">这个渠道下面还没有对话模型。${po ? "加一个，它就会出现在输入框右下角那个选择器里。" : ""}</div>`}
        ${!po ? "" : `
        <div class="ca-form" data-chan="${esc(p.id)}" style="display:none;border-top:1px solid var(--wb-border);padding-top:8px;margin-top:6px">
          <div class="form-row">
            <select class="ca-chan"></select>
            <select class="ca-model"></select>
          </div>
          <div class="form-row">
            <input class="ca-custom" placeholder="模型名（上面选「自己填…」时用这个）" style="display:none">
            <input class="ca-name" placeholder="别名（可空，默认用模型名；对话里按这个名字认）">
          </div>
          <div class="d ca-tip" style="font-size:12px;margin-bottom:6px"></div>
          <button class="btn-brand ca-save">保存</button>
          <button class="btn-plain ca-cancel">取消</button>
        </div>
        <button class="btn-plain ca-new" data-chan="${esc(p.id)}" style="margin-top:6px">＋ 添加模型</button>`}
      </div>`}
    </div>`;
}

/** 模型行：名字 · 模型 id · 战绩，剩下的都收进 ⋯。地址和 Key 不在这儿——那是渠道的事 */
function modelRow(m, s, po) {
  const i = s.models.indexOf(m);
  const cur = m.name === s.active_model;
  const meta = [cur ? "默认" : "", healthBadge(m.name).replace(/^\s*·\s*/, "")].filter(Boolean).join(" · ");
  return `
    <div class="mrow">
      ${po ? `<input type="radio" name="active" ${cur ? "checked" : ""} data-i="${i}" title="设为全局默认模型">`
           : `<span class="mrow-dot" title="${cur ? "当前默认" : ""}">${cur ? "●" : "○"}</span>`}
      <span class="mrow-name">${esc(m.name)}</span>
      <span class="mrow-id">${esc(m.model)}</span>
      <span class="mrow-meta">${meta}</span>
      ${!po ? "" : rowMenu([["cedit", i, "编辑", ""], ["cdup", i, "复制一个", ""], ["cdel", i, "删除", "danger"]])}
    </div>`;
}

/** 行尾的 ⋯：三个链接平铺太占地方，收进来点开才有。参数是 [属性名, 下标, 文案, 样式] */
function rowMenu(items) {
  return `<span class="row-acts">
      <button class="row-more" type="button" title="更多">${ic("ellipsis", "i-sm")}</button>
      <span class="row-menu" hidden>${items.map(([attr, i, label, cls]) =>
        `<a href="#" class="${cls}" data-${attr}="${i}">${label}</a>`).join("")}</span>
    </span>`;
}

/**
 * 「去拿 Key」的链接：先按渠道类型给官方那一页；认不出来（自建网关指着某个已知厂商）
 * 再按地址回退到 KEY_SOURCES 那张表。两条路都没有就不显示——给个死链比不给更糟。
 */
function kindKeyLink(kind, baseUrl) {
  const k = ((mediaCatalog || {}).kinds || []).find((x) => x.kind === kind);
  if (k && k.key_url) return `<a class="get-key" href="${esc(k.key_url)}" target="_blank" rel="noopener">去拿 Key ↗</a>`;
  if (!String(baseUrl || "").trim()) return ""; // 自建网关连地址都没填，猜不出 Key 从哪儿领
  return keyLink(modelKeySource({ base_url: baseUrl, provider: "openai" }));
}

/** ⋯ 菜单：点开一个就关掉别的，点页面别处全关。触屏上没有悬停，所以必须是点出来的 */
function bindRowMenus(root) {
  if (!rowMenuBound) {
    rowMenuBound = true;
    document.addEventListener("click", () => document.querySelectorAll(".row-menu").forEach((m) => (m.hidden = true)));
  }
  root.querySelectorAll(".row-more").forEach((b) => (b.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation(); // 按钮坐在渠道头里，冒上去会顺手把卡片折叠了
    const menu = b.nextElementSibling;
    const show = menu.hidden;
    root.querySelectorAll(".row-menu").forEach((m) => (m.hidden = true));
    menu.hidden = !show;
  }));
  root.querySelectorAll(".row-menu").forEach((m) => (m.onclick = (e) => {
    e.stopPropagation();
    root.querySelectorAll(".row-menu").forEach((x) => (x.hidden = true));
  }));
}

function bindModels(pane, s, po) {
  const msg = pane.querySelector("#models-msg");
  pane.querySelector("#mf-follow-last").onchange = (e) => saveSettings({ model_follow_last: e.target.checked }, msg);
  // 展开 / 收起不碰服务器，纯前端的事
  pane.querySelectorAll(".ch-head[data-chan]").forEach((h) => (h.onclick = () => {
    const id = h.dataset.chan;
    if (openChans.has(id)) openChans.delete(id); else openChans.add(id);
    paintModels(pane, s);
  }));
  bindRowMenus(pane);
  if (!po) return; // 下面全是平台管理员那套按钮，没画出来就别去 querySelector（null.onclick 会把整页炸掉）

  const kinds = (mediaCatalog || {}).kinds || [];
  const form = pane.querySelector("#prov-form");
  let editP = -1;
  const showProvForm = (p) => {
    form.style.display = "";
    pane.querySelector("#pf-kind").value = (p && p.kind) || (kinds[0] || {}).kind || "custom";
    pane.querySelector("#pf-name").value = (p && p.name) || "";
    pane.querySelector("#pf-base").value = (p && p.base_url) || "";
    pane.querySelector("#pf-key").value = (p && p.api_key) || "";
    pane.querySelector("#pf-key-src").innerHTML = kindKeyLink((p && p.kind) || "", (p && p.base_url) || "");
  };
  pane.querySelector("#pf-kind").onchange = (e) => {
    const k = kinds.find((x) => x.kind === e.target.value) || {};
    pane.querySelector("#pf-base").value = k.base_url || "";
    pane.querySelector("#pf-key-src").innerHTML = kindKeyLink(k.kind || "", k.base_url || "");
    if (!pane.querySelector("#pf-name").value) pane.querySelector("#pf-name").value = String(k.label || "").replace(/（.*/, "");
  };
  pane.querySelector("#pf-new").onclick = () => { editP = -1; showProvForm(null); pane.querySelector("#pf-kind").onchange({ target: pane.querySelector("#pf-kind") }); };
  pane.querySelector("#pf-cancel").onclick = () => (form.style.display = "none");
  pane.querySelectorAll("a[data-pedit]").forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    editP = +a.dataset.pedit;
    showProvForm(s.providers[editP]);
  }));
  pane.querySelectorAll("a[data-pdel]").forEach((a) => (a.onclick = async (e) => {
    e.preventDefault();
    const idx = +a.dataset.pdel;
    const p = s.providers[idx];
    const chat = s.models.filter((m) => m.channel === p.id);
    const media = s.media_models.filter((m) => m.provider === p.id);
    const hitsDefault = chat.some((m) => m.name === s.active_model);
    // 删渠道会连坐：挂在它下面的模型一起没。把数说清楚，别删完才发现画图不能用了
    const lines = [chat.length + media.length
      ? `删掉「${p.name}」的话，挂在它下面的 ${chat.length} 个对话模型和 ${media.length} 个媒体模型也会一起删掉。`
      : `确认删除渠道「${p.name}」？`];
    if (hitsDefault) lines.push("当前默认模型就在里面，删完会自动换成列表里的第一个。");
    if (chat.length + media.length) lines.push("继续？");
    if (!confirm(lines.join("\n"))) return;
    s.providers.splice(idx, 1);
    s.models = s.models.filter((m) => m.channel !== p.id);
    s.media_models = s.media_models.filter((m) => m.provider !== p.id);
    openChans.delete(p.id);
    liveModels.delete(p.id);
    const extra = hitsDefault && s.models.length ? { active_model: s.models[0].name } : undefined;
    if (await saveAllModelTables(s, msg, extra)) paintModels(pane, s);
  }));
  pane.querySelector("#pf-save").onclick = async () => {
    const v = (id) => pane.querySelector("#" + id).value.trim();
    const kind = v("pf-kind");
    if (!v("pf-name")) return toast("给渠道起个名字，下面挑模型时要按名字认");
    // Anthropic 官方不用填地址（SDK 自带），别的都得是完整的 http(s) 地址
    if (kind !== "anthropic" && !/^https?:\/\//i.test(v("pf-base"))) return toast("接口地址要填完整的 http(s) 地址");
    const entry = { id: editP >= 0 ? s.providers[editP].id : "", name: v("pf-name"), kind, base_url: v("pf-base"), api_key: v("pf-key") };
    if (editP >= 0) s.providers[editP] = { ...s.providers[editP], ...entry }; else s.providers.push(entry);
    liveModels.clear(); // 换了地址或 Key，之前拉回来的清单就不作数了
    if (await saveAllModelTables(s, msg)) { form.style.display = "none"; paintModels(pane, s); }
  };

  pane.querySelectorAll("input[name=active]").forEach((r) => (r.onchange = async () => {
    await saveSettings({ active_model: s.models[+r.dataset.i].name }, msg);
    if (settingsCache) Object.assign(s, settingsCache);
    paintModels(pane, s);
  }));

  let editM = -1;
  const showModelForm = (chanId, m) => {
    const f = pane.querySelector(`.ca-form[data-chan="${chanId}"]`);
    if (!f) return toast("这个渠道的卡片没展开，先点开它");
    pane.querySelectorAll(".ca-form").forEach((x) => (x.style.display = "none")); // 一次只开一张表单
    f.style.display = "";
    fillChanSelect(f, s, chanId);
    f.querySelector(".ca-name").value = (m && m.name) || "";
    const sel = f.querySelector(".ca-model");
    const cust = f.querySelector(".ca-custom");
    cust.value = "";
    if (m && m.model) {
      // 目录里有就选中它，没有（多半是手填的或者活列表里的）就落到「自己填…」并把原值带上
      if (Array.from(sel.options).some((o) => o.value === m.model)) sel.value = m.model;
      else { sel.value = "__custom__"; cust.value = m.model; }
    }
    cust.style.display = sel.value === "__custom__" ? "" : "none";
  };
  pane.querySelectorAll(".ca-new").forEach((b) => (b.onclick = () => { editM = -1; showModelForm(b.dataset.chan, null); }));
  pane.querySelectorAll(".ca-cancel").forEach((b) => (b.onclick = () => (b.closest(".ca-form").style.display = "none")));
  pane.querySelectorAll("a[data-cedit]").forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    editM = +a.dataset.cedit;
    const m = s.models[editM];
    showModelForm(m.channel || "", m);
  }));
  // 复制一个：同渠道换个模型名即成新模型（OpenRouter 底下加第二个模型就是这个动作）
  pane.querySelectorAll("a[data-cdup]").forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    editM = -1;
    const m = s.models[+a.dataset.cdup];
    showModelForm(m.channel || "", { ...m, name: "" });
  }));
  pane.querySelectorAll("a[data-cdel]").forEach((a) => (a.onclick = async (e) => {
    e.preventDefault();
    const idx = +a.dataset.cdel;
    const m = s.models[idx];
    if (!confirm(`确认删除模型「${m.name}」？渠道和 Key 留着，别的模型不受影响。`)) return;
    s.models.splice(idx, 1);
    const extra = m.name === s.active_model && s.models.length ? { active_model: s.models[0].name } : undefined;
    if (await saveAllModelTables(s, msg, extra)) paintModels(pane, s);
  }));
  pane.querySelectorAll(".ca-form").forEach((f) => {
    f.querySelector(".ca-chan").onchange = () => fillChatModelSelect(f, s);
    f.querySelector(".ca-model").onchange = () => {
      const custom = f.querySelector(".ca-model").value === "__custom__";
      f.querySelector(".ca-custom").style.display = custom ? "" : "none";
      if (custom) f.querySelector(".ca-custom").focus();
    };
    f.querySelector(".ca-save").onclick = async () => {
      const sel = f.querySelector(".ca-model").value;
      const model = sel === "__custom__" ? f.querySelector(".ca-custom").value.trim() : sel;
      const chan = f.querySelector(".ca-chan").value;
      if (!chan) return toast("先建一个渠道，模型得挂在渠道上");
      if (!model) return toast("还没选模型");
      const name = f.querySelector(".ca-name").value.trim() || model;
      if (s.models.some((m, i) => m.name === name && i !== editM)) return toast(`已经有叫「${name}」的模型了，换个别名`);
      const was = editM >= 0 ? s.models[editM] : null;
      // 保留条目上别处写的字段（比如以后加的备注），只覆盖这三样；地址和 Key 由服务端按渠道压平
      const entry = { ...(was || {}), name, channel: chan, model };
      if (was) s.models[editM] = entry; else s.models.push(entry);
      openChans.add(chan);
      // 改的正好是当前默认那条，且改了名字：默认项要跟着改，不然 active_model 指向一个不存在的名字
      const extra = was && was.name === s.active_model && name !== s.active_model ? { active_model: name } : undefined;
      if (await saveAllModelTables(s, msg, extra)) paintModels(pane, s);
    };
  });
}

function fillChanSelect(f, s, cur) {
  const sel = f.querySelector(".ca-chan");
  sel.innerHTML = s.providers.length
    ? s.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")
    : `<option value="">（先加一个渠道）</option>`;
  if (cur) sel.value = cur;
  fillChatModelSelect(f, s);
}

/**
 * 对话模型下拉的三段：这个渠道的精选 → 从渠道现拉的活列表 → 自己填。
 * 跟四路媒体那边同一套路，只是目录取 catalog.chat、活列表按「不像媒体模型的」筛。
 * 没跟 fillModelSelect 合并：那边每条要带 cap 和音色，这边不带，硬合会多出一串 if。
 */
function fillChatModelSelect(f, s) {
  const sel = f.querySelector(".ca-model");
  const tip = f.querySelector(".ca-tip");
  const p = s.providers.find((x) => x.id === f.querySelector(".ca-chan").value);
  const cat = ((mediaCatalog || {}).catalog || {}).chat || [];
  const mine = cat.filter((m) => !p || m.kind === p.kind);
  const others = cat.filter((m) => p && m.kind !== p.kind);
  const opt = (m) => `<option value="${esc(m.id)}">${esc(m.label)}（${esc(m.id)}）</option>`;
  sel.innerHTML =
    (mine.length ? `<optgroup label="这个渠道的精选">${mine.map(opt).join("")}</optgroup>` : "") +
    `<option value="__custom__">自己填…</option>` +
    (others.length ? `<optgroup label="其它渠道的（地址对得上也能用）">${others.map(opt).join("")}</optgroup>` : "");
  f.querySelector(".ca-custom").style.display = sel.value === "__custom__" ? "" : "none";
  tip.textContent = mine.length ? "" : "这个渠道没有精选条目，下面直接填模型名，或者等一下从渠道拉回来的列表。";
  if (!p) return;
  const live = liveModels.get(p.id);
  if (live) return injectLiveChat(sel, tip, live);
  tip.textContent = "正在问渠道有哪些模型…";
  fetch("/api/provider-models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: p.id }) })
    .then((r) => r.json())
    .then((d) => { liveModels.set(p.id, d); if (sel.isConnected) injectLiveChat(sel, tip, d); })
    .catch(() => { tip.textContent = ""; });
}

/** 活列表里标了 cap 的（image / video / tts）显然不是对话模型，排到后面去 */
function injectLiveChat(sel, tip, d) {
  if (!d.ok || !d.models || !d.models.length) {
    // 拉不到不是错：很多国产渠道压根没有 /models。目录和手填两条路都还在
    tip.textContent = d.why ? `这个渠道没给模型列表（${d.why}），上面的精选和「自己填…」照用。` : "";
    return;
  }
  const chatty = d.models.filter((m) => !m.cap || m.cap === "vision").map((m) => m.id);
  const rest = d.models.filter((m) => m.cap && m.cap !== "vision").map((m) => m.id);
  const group = (label, ids) => (ids.length ? `<optgroup label="${label}">${ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join("")}</optgroup>` : "");
  const keep = sel.value;
  sel.insertAdjacentHTML("beforeend", group("这个渠道现有的", chatty) + group("这个渠道的其它模型（多半是画图 / 配音的）", rest));
  if (keep) sel.value = keep;
  tip.textContent = `从渠道拉到 ${d.models.length} 个模型${d.cached ? "（缓存）" : ""}，挑不到就选「自己填…」。`;
}

// 联网搜索：provider 可切（Jina / Tavily / Brave），各自独立 key；没 key 自动退免费 DuckDuckGo
function renderSearchPane(pane, s) {
  const sc = s.search || {};
  pane.innerHTML = `
    <div class="card-item">
      <div class="t">搜索服务商</div>
      <div class="d" style="margin-bottom:6px">web_search 工具用哪家搜索 API。所选服务商没填 Key 或调用失败时，自动回退到免费 DuckDuckGo。</div>
      <select id="sr-provider">
        <option value="tavily">Tavily（推荐 · 免费额度 · 不用绑卡）</option>
        <option value="jina">Jina（国内直连 · 免费额度）</option>
        <option value="brave">Brave Search（要绑卡）</option>
      </select>
      <div class="t" style="margin-top:10px">Tavily API Key ${keyLink("tavily")}</div>
      <input id="sr-tavily" type="password" placeholder="tvly-..." value="${esc(sc.tavily_key || "")}">
      <div class="t" style="margin-top:8px">Jina API Key ${keyLink("jina")}</div>
      <input id="sr-jina" type="password" placeholder="jina_..." value="${esc(sc.jina_key || "")}">
      <div class="t" style="margin-top:8px">Brave API Key ${keyLink("brave")}</div>
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
    } else msg.textContent = lastSaveError || "保存失败";
    e.target.disabled = false;
  };
}
async function renderAgentPane(pane, s) {
  pane.innerHTML = `
    <div class="card-item">
      <div class="t">底层引擎</div>
      <div class="d" style="margin-bottom:10px">谁来跑任务。电脑里已经装了 Claude Code 或 Codex 的话，点一下就能直接用你已经付过钱的那份订阅——不再消耗这里配的 API Key 额度。切完立刻生效，下一个任务就走新引擎。</div>
      <div id="ag-engines" class="eng-list"><div class="eng-msg">正在看本机装了哪些…</div></div>
    </div>
    <div class="card-item">
      <div class="t">思考模式</div>
      <div class="d" style="margin-bottom:8px">带思考/推理的模型可以在这里关掉或者调强度。关掉更快更省钱，开高更适合难题。默认「跟随模型默认」= 一个参数都不发，和以前完全一样。</div>
      <select id="ag-thinking"><option value="auto">跟随模型默认</option></select>
      <div class="d" id="ag-thinking-note" style="margin-top:6px">正在看这一档对当前模型是怎么生效的…</div>
      <div class="ok-msg" id="ag-thinking-msg"></div>
    </div>
    <div class="card-item">
      <div class="t">执行权限模式</div>
      <div class="d">输入框下方「权限」下拉可随时切换：Ask 只问答 · Plan 只出计划 · Craft 完整执行交付</div>
    </div>
    ${s.platform_owner ? `    <div class="card-item">
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
    <button class="btn-brand" id="ag-save">保存</button><span class="ok-msg" id="ag-msg"></span>` : `
    <div class="card-item">
      <div class="t">执行上限（步数 / 超时 / token 预算）</div>
      <div class="d">这几项配的是<b>整台服务器</b>——一个人调高步数和超时，所有人的任务和账单都跟着变，所以归平台管理员。上面的底层引擎、思考模式是你自己的，随时能改。</div>
    </div>`}`;
  const agSave = pane.querySelector("#ag-save");
  // 思考档特地不跟这堆一起存：它是个人偏好，那几项是服务器级的。捆在同一个「保存」上，
  // 多人服务器上的成员一点就整单 403——他只是想换个思考档，却被告知这归管理员管
  if (agSave) agSave.onclick = () =>
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
  renderEngineCard(pane.querySelector("#ag-engines"));
  renderThinkingCard(pane.querySelector("#ag-thinking"), pane.querySelector("#ag-thinking-note"), pane.querySelector("#ag-thinking-msg"));
}
/**
 * 「思考模式」下拉。
 *
 * 选项的说明文字一律由服务端算（/api/thinking）：各家的参数名不一样，而且换了模型、
 * 换了引擎，同一档的含义就变了。前端写死一张表迟早写歪成「界面说已关闭、实际什么都没发」。
 * 服务端说这一档对当前模型不生效，这里就把原因原样显示出来，不拿一句"已关闭"糊过去。
 */
async function renderThinkingCard(sel, note, msg) {
  const d = await fetch("/api/thinking").then((r) => r.json()).catch(() => null);
  if (!d || !d.levels) { note.textContent = "读不到思考模式的支持情况，先按「跟随模型默认」用。"; return; }
  const where = d.via === "engine" ? `本机 ${esc(d.target)}` : (d.target ? esc(d.target) : "当前模型");
  sel.innerHTML = d.levels.map((l) => `<option value="${esc(l.level)}"${l.level === d.current ? " selected" : ""}>${esc(l.label)}${l.supported ? "" : "（对当前模型不生效）"}</option>`).join("");
  const show = () => {
    const l = d.levels.find((x) => x.level === sel.value) || d.levels[0];
    note.textContent = (l.supported ? `对 ${where}：` : `⚠️ 对 ${where} 不生效 —— `) + (l.note || "");
    note.style.color = l.supported ? "" : "var(--warn, #c2410c)";
  };
  sel.onchange = async () => {
    show();
    if (!msg) return; // 别处复用这张卡时不带存档位的格子，只更新说明
    msg.textContent = "保存中…";
    const ok = await saveSettings({ agent: { thinking: sel.value } }, null);
    msg.textContent = ok ? "✓ 已保存并生效" : (lastSaveError || "保存失败");
  };
  show();
}
/**
 * 「底层引擎」卡片。
 *
 * 这张卡的职责不是"列个单子"，是**让用户真的用上本机那份订阅**。三件事必须做到：
 *   ① 找得到 —— 双击图标启动的 App 拿到的 PATH 是残废的（只有 /usr/bin:/bin:…），
 *      claude/codex 装在 homebrew、nvm、~/.local/bin 里的一律看不见。这一层在
 *      engines/which.js 里补齐了，卡片这边把"从哪找到的"如实标出来。
 *   ② 说实话 —— `--version` 只证明文件在，不证明能用。装了没登录、订阅过期、
 *      被限流，在旧版卡片上全都显示"已装 ✓"。所以这里有一个真跑一句话的连接测试。
 *   ③ 出事有下一步 —— 失败时不只报错，要说清楚接下来敲哪条命令。
 */
async function renderEngineCard(box, force) {
  if (!box) return;
  box.innerHTML = '<div class="eng-msg">正在找本机装了哪些…</div>';
  // 平时读服务端缓存（探测要给每个 CLI 起子进程，开个设置页不该等）；点「重新检测本机」才真去重探
  const d = await fetch("/api/engines" + (force ? "?force=1" : "")).then((r) => r.json()).catch(() => null);
  if (!d) { box.innerHTML = '<div class="eng-msg">检测失败：拿不到引擎列表</div>'; return; }
  const cur = d.current || "builtin";
  const all = [d.builtin, ...(d.engines || [])];
  box.innerHTML = all.map((e) => {
    const on = cur === e.id, builtin = e.id === "builtin", ready = builtin || e.installed;
    const badge = builtin
      ? '<span class="eng-b">走 API Key</span>'
      : e.installed
        ? `<span class="eng-b ok">已装 ${esc(e.version || "")}</span><span class="eng-b free">不花 API 额度</span>`
        : '<span class="eng-b no">本机没找到</span>';
    // 从补全的 PATH / 登录 shell 里找到的，说一声——用户要是纳闷"我明明装了它怎么现在才看见"，这就是答案
    const howNote = !builtin && e.installed && e.how && e.how !== "PATH"
      ? `<div class="eng-i">（${esc(e.how)}里找到的：<span class="eng-p">${esc(e.path || "")}</span>）</div>` : "";
    return `<div class="eng${on ? " on" : ""}${ready ? "" : " off"}" data-eng="${esc(e.id)}" data-ready="${ready ? 1 : 0}">
      <div class="eng-h"><span class="eng-dot">${on ? "●" : "○"}</span><b>${esc(e.label)}</b>${badge}</div>
      <div class="eng-n">${esc(e.note || "")}</div>
      <div class="eng-c">${esc(e.launchHeader || "")}</div>
      ${howNote}
      ${!builtin && !e.installed ? `<div class="eng-i">${esc(e.error || "没找到")}<br>装法：<code>${esc(e.install || "")}</code></div>` : ""}
      ${builtin || !on ? "" : engineExtraHtml(e)}
    </div>`;
  }).join("") + '<div class="eng-row" style="margin-top:4px"><button class="btn-plain" id="ag-eng-rescan">重新检测本机</button><span class="eng-msg" id="ag-eng-msg"></span></div>';

  const msg = box.querySelector("#ag-eng-msg");
  box.querySelector("#ag-eng-rescan").onclick = (ev) => { ev.stopPropagation(); renderEngineCard(box, true); };

  box.querySelectorAll(".eng").forEach((el) => {
    const id = el.dataset.eng;
    if (el.classList.contains("on")) bindEngineExtra(el, id, box);
    el.onclick = async (ev) => {
      if (ev.target.closest(".eng-x")) return; // 展开区里的输入框/按钮，不当成"切引擎"
      if (el.classList.contains("on")) return;
      if (el.dataset.ready !== "1") {
        // 没找到的那条：点了不切。静默切到一个跑不起来的引擎，用户会以为在用本机订阅，
        // 其实每个任务都在原地报错。顺手重扫一遍——刚装完的人点的就是这一下
        msg.textContent = "本机还没找到它，先按上面的装法装好；这就重新找一遍…";
        return renderEngineCard(box);
      }
      msg.textContent = "切换中…";
      const ok = await saveSettings({ agent: { engine: id } }, null);
      // 「切换失败」四个字是这张卡最没用的一句话。服务端每一种失败都带了原因
      // （多人服务器上归平台管理员 / 引擎名不存在 / 后端报错），原样端出来
      if (!ok) { msg.textContent = lastSaveError || "切换失败"; return; }
      await renderEngineCard(box);
      // 切完立刻真连一次：让用户当场知道"能用"，而不是等下一个任务失败才知道
      const card = box.querySelector('.eng[data-eng="' + CSS.escape(id) + '"]');
      if (card) testEngineConnect(card, id);
    };
  });
}

/** 选中的引擎才展开：可执行文件路径、模型、一键连接测试 */
// 思考/effort 档位（跟 thinking.js 的 LEVELS 同一张表；"" = 跟随全局档位）
const ENGINE_THINK_LEVELS = [
  ["", "跟随全局思考模式"], ["auto", "跟随 CLI 默认"], ["off", "关闭思考"], ["low", "低"], ["medium", "中"], ["high", "高"],
];
function engineExtraHtml(e) {
  const o = e.options || {};
  const listId = "eng-models-" + e.id;
  const models = Array.isArray(e.models) ? e.models : [];
  return `<div class="eng-x" onclick="event.stopPropagation()">
    <label>可执行文件路径<span style="color:var(--wb-text-3)">（留空 = 自动找。装在 nvm/homebrew 里也能找到；只有自动找不到时才需要填绝对路径）</span>
      <input type="text" data-k="bin" placeholder="${esc(e.path || e.id)}" value="${esc(o.bin || "")}"></label>
    <label>模型<span style="color:var(--wb-text-3)">（留空 = 用 ${esc(e.label)} 自己的默认模型。填它认的名字，跟「模型」页的 API 渠道无关；下拉里是常用值，可以直接输别的）</span>
      <input type="text" data-k="model" list="${listId}" placeholder="默认" value="${esc(o.model || "")}" autocomplete="off">
      <datalist id="${listId}">${models.map((m) => `<option value="${esc(m)}">`).join("")}</datalist></label>
    <label>${esc(e.thinkingLabel || "思考模式")}<span style="color:var(--wb-text-3)">（只对这个引擎生效；「跟随全局」= 用助理设置里的思考模式）</span>
      <select data-k="thinking">${ENGINE_THINK_LEVELS.map(([v, l]) => `<option value="${v}"${(o.thinking || "") === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
    <div class="eng-row">
      <button class="btn-brand" data-act="test">测试连接</button>
      <button class="btn-plain" data-act="save">保存路径 / 模型 / 思考档</button>
      <span class="eng-msg" data-role="xmsg"></span>
    </div>
    <div data-role="result"></div>
  </div>`;
}

function bindEngineExtra(card, id, box) {
  const x = card.querySelector(".eng-x");
  if (!x) return;
  const readOpts = () => {
    const o = {};
    x.querySelectorAll("input[data-k],select[data-k]").forEach((i) => (o[i.dataset.k] = i.value.trim()));
    return o;
  };
  x.querySelector('[data-act="test"]').onclick = () => testEngineConnect(card, id);
  x.querySelector('[data-act="save"]').onclick = async () => {
    const m = x.querySelector('[data-role="xmsg"]');
    m.textContent = "保存中…";
    const ok = await saveSettings({ agent: { engine_options: { [id]: readOpts() } } }, null);
    m.textContent = ok ? "✓ 已保存" : (lastSaveError || "保存失败");
    if (ok) setTimeout(() => renderEngineCard(box), 600);
  };
}

/**
 * 真连一次。花几十个 token 跑一句"回复 ok"，把「能用 / 没登录 / 限流 / 装坏了」分开。
 * 结果要带上耗时和实际用的模型——用户下一个任务会看到同一个模型名，对得上才叫连通。
 */
async function testEngineConnect(card, id) {
  const x = card.querySelector(".eng-x");
  if (!x) return;
  const btn = x.querySelector('[data-act="test"]');
  const out = x.querySelector('[data-role="result"]');
  const opts = {};
  x.querySelectorAll("input[data-k]").forEach((i) => (opts[i.dataset.k] = i.value.trim()));
  btn.disabled = true;
  const t0 = Date.now();
  const tick = setInterval(() => { out.className = "eng-r"; out.textContent = `正在真连一次…已等 ${Math.round((Date.now() - t0) / 1000)} 秒（第一次会慢一点）`; }, 500);
  let r;
  try { r = await fetch("/api/engines/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, options: opts }) }).then((v) => v.json()); }
  catch (e) { r = { ok: false, why: "请求失败：" + e.message }; }
  clearInterval(tick);
  btn.disabled = false;
  if (r && r.ok) {
    out.className = "eng-r ok";
    out.innerHTML = `✓ 连通了，用了 ${(r.ms / 1000).toFixed(1)} 秒。它回了「${esc(r.reply || "")}」`
      + (r.model ? `，实际跑的模型是 <code>${esc(r.model)}</code>` : "")
      + `。这一趟没花 API 额度，走的是你本机的订阅。<br><span class="eng-p">${esc(r.path || "")}${r.version ? " · " + esc(r.version) : ""}</span>`;
  } else {
    out.className = "eng-r bad";
    out.innerHTML = `✗ 连不上：${esc((r && (r.why || r.error)) || "未知原因")}`
      + (r && r.hint ? `<br>下一步：<code>${esc(r.hint)}</code>` : "");
  }
}

function renderPersonaPane(pane, s) {
  const a = { name: "OpenWorkBuddy", avatar: ASSISTANT_MARK, ...(s.assistant || {}) };
  // 助理叫什么、个性化偏好，都是**整台服务器**共用一份（改了别人也跟着变），归平台管理员。
  // 桌面宠物是跑在他自己电脑上的那只，纯个人。所以成员进来这一页只剩宠物 + 一句说明。
  const po = !!s.platform_owner;
  pane.innerHTML = `
    ${!po ? `
    <div class="card-item">
      <div class="t">助理的名字和个性化偏好</div>
      <div class="d">这台服务器上大家共用同一个助理身份和同一份偏好，改了所有人都跟着变，所以归平台管理员设。你想让它对<b>你</b>怎么干活，直接在对话里说，或者写进「记忆」页——那一份只有你自己的任务带着。</div>
    </div>` : `
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
    </div>`}
    ${petCardHtml(s.pet || {})}
    ${!po ? "" : `<button class="btn-brand" id="ps-save">保存</button><span class="ok-msg" id="ps-msg"></span>`}`;
  bindPetCard(pane, s.pet || {});
  if (!po) return; // 名字/偏好那两张卡没画，下面的 querySelector 会拿到 null
  const ed = bindAvatarEditor(pane, "as", a.avatar, () => pane.querySelector("#as-name").value.trim() || "OpenWorkBuddy", ASSISTANT_MARK);
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
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;color:var(--wb-text-2);cursor:pointer"><input type="checkbox" id="pet-notify-done" style="width:auto;margin:0"${p.notify_done !== false ? " checked" : ""}> 任务干完 / 出错时也提醒我一声</label>
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;color:var(--wb-text-2);cursor:pointer"><input type="checkbox" id="pet-wander" style="width:auto;margin:0"${p.wander ? " checked" : ""}> 闲着时让它在桌面上随便走走（默认关）</label>
      <div class="t" style="margin-top:10px">形象</div>
      <div class="d" style="margin-bottom:6px">可以换成你自己或朋友的照片——上传后自动裁成圆形，配上呼吸、摇摆、跳跃的动效"活"起来。图片只存在本机 <code>data/</code> 目录，不上传任何服务器。</div>
      ${petSpriteHint(p)}
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="pet-char" style="max-width:240px">
          <option value="cat"${p.character !== "photo" && p.character !== "sprite" ? " selected" : ""}>内置小猫</option>
          <option value="photo"${p.character === "photo" ? " selected" : ""}>我的照片${p.has_photo ? "" : "（还没上传）"}</option>
          ${petSpriteOptions(p)}
        </select>
        <button class="btn-plain" id="pet-pick">上传照片</button>
        ${p.has_photo ? '<button class="btn-plain" id="pet-drop">删除照片</button>' : ""}
        <input type="file" id="pet-file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">
      </div>
      <div class="t" style="margin-top:10px">大小 <span id="pet-scale-v" style="color:var(--wb-text-3)">${Math.round((p.scale || 2) * 100)}%</span></div>
      <input type="range" id="pet-scale" min="0.6" max="2" step="0.1" value="${p.scale || 2}">
      <div class="t" style="margin-top:6px">透明度 <span id="pet-op-v" style="color:var(--wb-text-3)">${Math.round((p.opacity || 1) * 100)}%</span></div>
      <input type="range" id="pet-op" min="0.25" max="1" step="0.05" value="${p.opacity || 1}">
      <div style="margin-top:8px"><span class="ok-msg" id="pet-msg"></span></div>
    </div>`;
}
/**
 * 精灵图宠物的说明。分两种情况：一只都没有的时候要告诉用户怎么装（不然这个能力等于不存在）；
 * 扫到了但图集不合规的，要把原因原样打出来——「这只装了但用不了」比装作没看见有用得多。
 */
function petSpriteHint(p) {
  const list = p.sprites || [];
  const bad = list.filter(x => !x.ok);
  const good = list.filter(x => x.ok);
  const install = '装法：终端里跑 <code>npx petdex install &lt;名字&gt;</code>，画廊在 <a href="https://petdex.dev" target="_blank" rel="noreferrer">petdex.dev</a>；也可以把整个宠物文件夹（含 <code>pet.json</code> + <code>spritesheet.webp</code>）丢进 <code>data/pets/</code>。';
  const badLine = bad.length ? `<br><span style="color:var(--wb-warn,#c60)">有 ${bad.length} 只装了但用不了：${bad.map(x => esc(x.name || x.id) + "（" + esc(x.why) + "）").join("、")}</span>` : "";
  if (!good.length) return `<div class="d" style="margin-bottom:6px">还能用 <b>Codex / Petdex 的像素宠物</b>——8 行动作（跑、跳、挥手、失败…）直接对上 agent 的状态。本机<b>一只都没扫到</b>。${install}${badLine}</div>`;
  return `<div class="d" style="margin-bottom:6px">本机扫到 <b>${good.length}</b> 只 Codex / Petdex 像素宠物，已列在下面。${install}${badLine}</div>`;
}
function petSpriteOptions(p) {
  const good = (p.sprites || []).filter(x => x.ok);
  if (!good.length) return "";
  const sel = p.character === "sprite" ? p.sprite : "";
  return '<optgroup label="精灵图宠物（Codex / Petdex）">' +
    good.map(x => `<option value="sprite:${esc(x.id)}"${sel === x.id ? " selected" : ""}>${esc(x.name || x.id)} · ${esc(x.source)}</option>`).join("") +
    "</optgroup>";
}
function bindPetCard(pane, p) {
  const msg = pane.querySelector("#pet-msg");
  const q = (id) => pane.querySelector(id);
  const save = (patch) => saveSettings({ pet: patch }, msg);
  q("#pet-on").onchange = (e) => save({ enabled: e.target.checked });
  q("#pet-notify").onchange = (e) => save({ notify: e.target.checked });
  q("#pet-notify-done").onchange = (e) => save({ notifyDone: e.target.checked });
  q("#pet-wander").onchange = (e) => save({ wander: e.target.checked });
  q("#pet-char").onchange = (e) => {
    const v = e.target.value;
    if (v === "photo" && !p.has_photo) { msg.textContent = "先上传一张照片"; e.target.value = "cat"; return; }
    // 精灵图那几项的 value 是 "sprite:<id>"，要拆成两个字段发给后端
    if (v.startsWith("sprite:")) return save({ character: "sprite", sprite: v.slice(7) });
    save({ character: v, sprite: "" });
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
  // 语义召回到底开没开、算出来几条：以前这里什么都不说，向量一条没算出来用户也只会觉得「记忆越来越不准」
  const vs = m.vectors || {};
  const vecLine = !vs.enabled
    ? "🔍 语义召回没开：没接嵌入模型，现在按关键词召回。设置 → 模型 里配一条支持 embeddings 的渠道就能开。"
    : !vs.total ? `🔍 语义召回已接上（${vs.model}），记了东西就会自动算向量。`
    : vs.have >= vs.total ? `🔍 语义召回开着：${vs.total} 条都算好了向量（${vs.model}）。`
    : `⚠️ 语义召回：${vs.total} 条里只有 ${vs.have} 条算出了向量——嵌入渠道大概率没通，现在按关键词召回。服务器日志里搜「[记忆向量]」能看到原因。`;
  // 会 403 的按钮不该摆在那儿：共享区那几条进的是所有人的提示词，不是平台管理员就删不动，
  // 以前照样画一颗「删」——点下去后端拒了、前端还把返回值扔了，看起来就是「点了没反应」。
  const canDel = (it) => m.can_share || it.scope !== m.shared_tag;
  const rows = items.length
    ? items.map(it => `
      <div class="mem-row">
        <span class="mem-tag">${it.scope === m.shared_tag ? "共享" : esc(it.scope)}</span>
        <span class="mem-txt">${escInline(it.text)}</span>
        <span class="mem-src">${it.source === "user" ? "手动" : "AI 记的"}</span>
        ${canDel(it) ? `<a href="#" class="link danger" data-del="${esc(it.id)}">删</a>`
          : `<span class="mem-src" title="共享的记忆进所有账号的提示词，要平台管理员来删">共用</span>`}
      </div>`).join("")
    : '<div style="color:var(--wb-text-3);font-size: 14px;padding:6px 0">还没有。你说「以后都这样」「记住…」时它会自己记一条；也可以在下面手动加。</div>';
  pane.innerHTML = `
    <div class="card-item">
      <div class="t">📌 记住的事（AI 自己记的 + 你手动加的）</div>
      <div class="d" style="margin-bottom:8px">一条一句话，跨任务保留。标「共享」的所有账号都看得到，标账号名的只跟着那个人走。每人最多 ${esc(String((m.limits || {}).max_items || 120))} 条。</div>
      <div class="d" id="mem-vec" style="margin-bottom:8px">${esc(vecLine)}</div>
      <div id="mem-items">${rows}</div>
      <div class="form-row" style="margin-top:8px">
        <input id="mem-new" placeholder="手动加一条，例如：周报只要三段——进展 / 问题 / 下周计划">
        <button class="btn-plain" id="mem-add" style="flex:0 0 auto">加进去</button>
      </div>
      ${m.can_share ? `
      <label style="display:flex;align-items:center;gap:6px;font-size: 13px;color:var(--wb-text-3);margin-top:6px;cursor:pointer">
        <input type="checkbox" id="mem-shared" style="width:auto;margin:0"> 这条给这台机器上所有账号共用
      </label>` : `
      <div class="d" style="margin-top:6px">加进去的只有你自己看得到。要让这台机器上所有账号都共用某条，得平台管理员来加。</div>`}
    </div>
    <div class="card-item">
      <div class="t">📝 背景说明（全局共享，原样进提示词）</div>
      <div class="d" style="margin-bottom:8px">适合放团队/业务背景、常用数据口径、固定模板要求这种成段的东西。所有账号共用一份。${m.can_edit_manual ? "" : "这份归平台管理员维护，你这边只读。"}</div>
      <textarea id="mem-text" rows="8" ${m.can_edit_manual ? "" : "readonly"} placeholder="例如：我们公司是做跨境电商的，主营美妆品类；周报收件人是运营部…">${esc(m.content)}</textarea>
    </div>
    ${!m.can_edit_manual ? "" : `
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
    </div>`}
    ${m.can_edit_manual ? `<button class="btn-brand" id="mem-save">保存背景说明</button><span class="ok-msg" id="mem-msg"></span>` : ""}`;
  if (m.can_edit_manual) pane.querySelector("#mem-save").onclick = async () => {
    const resp = await fetch("/api/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: pane.querySelector("#mem-text").value }) });
    pane.querySelector("#mem-msg").textContent = resp.ok ? "✓ 已保存" : ((await resp.json().catch(() => ({}))).error || "保存失败");
  };
  pane.querySelector("#mem-add").onclick = async () => {
    const text = pane.querySelector("#mem-new").value.trim();
    if (!text) return;
    const r = await fetch("/api/memory/item", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, shared: !!(pane.querySelector("#mem-shared") || {}).checked }),
    }).then(r => r.json()).catch(() => ({ note: "网络错误" }));
    toast(r.note || (r.ok ? "已记住" : "没记成"));
    if (r.ok) renderMemoryPane(pane);
  };
  // ---- 记忆搬家（整张卡只对平台管理员画，没画就别去接事件，null.onclick 会把整个面板炸掉）----
  if (m.can_edit_manual) {
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
  }
  pane.querySelectorAll("[data-del]").forEach(a => a.onclick = async (e) => {
    e.preventDefault();
    // 以前这儿把返回值整个扔了：后端答 403 也照样重画一遍，那条纹丝不动，用户只能得出「点了没反应」
    const r = await fetch("/api/memory/item/" + encodeURIComponent(a.dataset.del), { method: "DELETE" })
      .then(r => r.json()).catch(() => ({ error: "网络错误" }));
    if (r.error) return toast("删不掉：" + r.error);
    if (!r.removed) return toast("这条已经不在了");
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
  pane.querySelector("#ws-open").onclick = () => openWorkspaceOnHost();
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
/** 直达这个应用「凭证与基础信息」页，省得用户自己在开放平台里翻 */
function larkConsoleLink(appId, brand) {
  if (!/^cli_[A-Za-z0-9]+$/.test(String(appId || ""))) return "";
  const host = /lark/i.test(String(brand || "")) ? "open.larksuite.com" : "open.feishu.cn";
  return `<a class="link" target="_blank" rel="noopener" href="https://${host}/app/${appId}/baseinfo">打开凭证页</a> `;
}

/** 「飞书本人身份」卡的状态灯——这张卡的状态不在 /im/status 里，由 lark-cli 探测结果来点亮 */
function larkChip(pane, [cls, txt]) {
  const card = pane.querySelector('[data-ch="feishu_me"]');
  if (!card) return;
  const chip = card.querySelector(".im-st");
  chip.className = "im-st " + cls;
  chip.querySelector("em").textContent = txt;
  card.classList.toggle("on", cls === "ok");
}
async function renderLarkQr(pane) {
  const box = pane.querySelector("#fs-qr-body");
  if (!box) return;
  const st = await fetch("/api/feishu/lark-cli").then(r => r.json()).catch(() => ({ installed: false }));
  larkChip(pane, !st.installed ? ["off", "未装 lark-cli"] : !st.configured ? ["warn", "未绑定应用"] : st.users ? ["ok", "已授权"] : ["warn", "未授权"]);
  const btn = (id, txt, primary) => `<button class="${primary ? "btn-brand" : ""}" id="${id}" style="margin-right:6px">${txt}</button>`;
  if (!st.installed) {
    box.innerHTML = `本机没找到 lark-cli。装一下再回来：<br><code>npx @larksuite/cli@latest install</code><br>
      <div style="margin-top:8px">${btn("lk-recheck", "装好了，重新检测")}</div>`;
    box.querySelector("#lk-recheck").onclick = () => renderLarkQr(pane);
    return;
  }
  if (!st.configured) {
    box.innerHTML = `lark-cli v${esc(st.version)} 已装，但还没绑定飞书应用。
      把飞书卡里填的 App ID / App Secret 写进去就能扫码了（凭证走标准输入，不会出现在进程列表里）。
      <div style="margin-top:8px">${btn("lk-bind", "用飞书卡的凭证绑定", true)}<span class="ok-msg" id="lk-msg"></span></div>`;
    box.querySelector("#lk-bind").onclick = async (e) => {
      const msg = box.querySelector("#lk-msg");
      e.target.disabled = true; msg.textContent = "绑定中…"; msg.style.color = "";
      const d = await fetch("/api/feishu/lark-cli/bind", { method: "POST" }).then(r => r.json()).catch(() => ({ error: "请求失败" }));
      if (d.ok) renderLarkQr(pane);
      else { e.target.disabled = false; msg.style.color = "var(--wb-err)"; msg.textContent = "❌ " + d.error; }
    };
    return;
  }
  const fsAppId = (pane.querySelector("#im-feishu-app_id") || {}).value;
  box.innerHTML = `lark-cli v${esc(st.version)} · 应用 <code>${esc(st.app_id)}</code>${st.users ? ` · 已授权：${esc(st.users)}` : " · 还没有用户授权"}
    <div style="margin-top:8px">${btn("lk-login", st.users ? "重新扫码授权" : "扫码授权", true)}${
      st.has_secret && fsAppId !== st.app_id ? btn("lk-import", "把这个应用的凭证填进飞书卡") : ""}<span class="ok-msg" id="lk-msg"></span></div>
    ${st.secret_locked && fsAppId !== st.app_id ? `<div class="d" style="font-size:12px;margin-top:6px">
      这个应用的 App Secret 被 lark-cli 锁在系统钥匙串里，搬不过来（它只进不出）。想拿它当机器人的话：
      ${larkConsoleLink(st.app_id, st.brand)}复制 App Secret，粘到飞书卡的「粘一段过来自动识别」里。</div>` : ""}
    <div id="lk-qr" style="margin-top:10px"></div>`;
  const msg = box.querySelector("#lk-msg");
  const imp = box.querySelector("#lk-import");
  if (imp) imp.onclick = async (e) => {
    e.target.disabled = true; msg.textContent = "导入中…"; msg.style.color = "";
    const d = await fetch("/api/feishu/lark-cli/import", { method: "POST" }).then(r => r.json()).catch(() => ({ error: "请求失败" }));
    if (d.ok) { msg.style.color = "var(--wb-ok)"; msg.textContent = "✅ 已填入并保存，可以点飞书卡上的「连接」了"; renderSettings("im"); }
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
// ================= 助理设置：通道卡片 =================
/** 收起 / 展开一张通道卡。aria-expanded 得跟着走，不然读屏用户听到的状态是反的 */
function setPacked(card, on) {
  if (!card) return;
  card.classList.toggle("packed", on);
  const h = card.querySelector(".im-card-h");
  if (h && h.dataset.activate) h.setAttribute("aria-expanded", String(!on));
}

// 一张卡 = 一个通道：连没连上（状态灯，取自 /im/status）、怎么连（几个输入框）、右上角一颗按钮。
// 「连接」= 保存 + 真测活；「取消连接」= 清空这一组凭证再保存（微信是真断开登录态）。
// 申请步骤折进「怎么拿凭证」，默认只露名字、一句副标题和状态灯——
// 旧版是 9 大段说明文字平铺一屏，用户的原话是「太乱了，没办法自己调」。
// 从整段粘贴里把飞书那两串凭证抠出来。用户的原话是「现在还要填 appId 这些啊」——
// 机器人收消息必须有 app_id + app_secret（飞书的设计，扫码替代不了），但没必要让人手打：
// 开放平台那页整段复制、或者一段 JSON、或者同事发来的两行，都能认出来。
function parseFeishuCreds(txt) {
  const t = String(txt || "");
  const app_id = (t.match(/\bcli_[A-Za-z0-9]{8,}/) || [""])[0];
  // App Secret 是 32 位字母数字；先把已认出的 App ID 挖掉，免得把它自己当成 secret
  const rest = app_id ? t.split(app_id).join(" ") : t;
  const app_secret = ((rest.match(/\b[A-Za-z0-9]{32}\b/g) || [])[0]) || "";
  return { app_id, app_secret };
}

function wxStatus(c) {
  c = c || {};
  return !c.configured ? ["off", "未配置"] : c.callback_ready ? ["ok", "等腾讯回调"] : ["warn", "缺回调配置"];
}
function wsChip(c, offTxt) {
  c = c || {};
  if (!c.configured) return ["off", offTxt];
  if (c.state === "connected") return ["ok", "已连接"];
  return [c.state === "failed" ? "err" : "warn", WS_STATE_TXT[c.state] || c.state || "未启动"];
}
const IM_CHANNELS = [
  { key: "feishu", grp: "chat", icon: "🕊️", name: "飞书", sub: "长连接 · 无需公网", path: "feishu", src: "feishu",
    newapp: true, // 一键新建应用：连 App ID / Secret 都不用手打
    paste: { hint: "从飞书开放平台「凭证与基础信息」整页复制粘过来就行，不用一个字段一个字段抠", parse: parseFeishuCreds },
    fields: [["app_id", "App ID"], ["app_secret", "App Secret", "password"], ["verification_token", "Verification Token（可选，仅旧回调模式）", "", "opt"]],
    test: { url: "/im/feishu/test", ok: (d) => `凭证有效${d.bot_name ? `，机器人「${d.bot_name}」` : ""}，长连接：${WS_STATE_TXT[(d.ws || {}).state] || (d.ws || {}).state || "启动中"}` },
    help: ["飞书开放平台创建自建应用，添加「机器人」能力", "权限开通 im:message 与 im:message:send_as_bot", "事件订阅方式选「使用长连接接收事件」，添加 im.message.receive_v1", "发布一个版本，回来填 App ID / App Secret（或把那一页整段复制，用卡片里的「粘一段过来自动识别」）", "嫌麻烦就点上面的「扫码新建应用」——本机装了 lark-cli 的话，应用直接替你建好，App ID 自动填；App Secret 被系统钥匙串锁着的话，会给你一条直达凭证页的链接，复制回来粘一下"],
    // 缺哪一半就写哪一半：以前只写「未连接」，用户看不出是没填、填错、还是没联网
    status: (st) => { const f = st.feishu || {}; const m = f.missing || [];
      if (m.length === 1) return ["warn", "还差 " + m[0]];
      return wsChip({ configured: f.configured, state: (f.ws || {}).state }, "未连接"); } },
  { key: "qq", grp: "chat", icon: "🐧", name: "QQ", sub: "长连接 · 无需公网", path: "qq", src: "qq",
    fields: [["app_id", "AppID"], ["app_secret", "AppSecret", "password"]],
    test: { url: "/im/qq/test", ok: (d) => `凭证有效，长连接：${WS_STATE_TXT[(d.ws || {}).state] || (d.ws || {}).state || "启动中"}` },
    help: ["QQ 开放平台 q.qq.com 创建「机器人」，开发设置里拿 AppID / AppSecret", "功能配置 → 消息列表：开启私聊消息和群聊 @机器人 消息", "沙箱只对白名单群/好友生效，正式使用需提交审核发布"],
    status: (st) => wsChip(st.qq, "未连接") },
  { key: "wechat_ilink", grp: "chat", icon: "💬", name: "微信", sub: "扫码登录 · 无需公网", qr: true,
    help: ["点「连接」出二维码，用要当机器人的那个微信号扫码并在手机上确认", "之后本机主动长轮询收发消息，别人给这个微信号发消息 = 下任务", "登录态由微信控制，失效后重新扫码；发来的图片/文件/语音会自动存进工作目录，AI 直接按文件名打开"],
    status: (st) => wsChip(st.wechat_ilink, "未扫码") },
  { key: "wecom_app", grp: "chat", icon: "🏢", name: "企业微信应用", sub: "双向对话 · 需公网 HTTPS", path: "wecom_app", src: "wecom_app",
    fields: [["corp_id", "CorpID"], ["agent_id", "AgentId（纯数字）"], ["secret", "应用 Secret", "password"], ["token", "Token"], ["aes_key", "EncodingAESKey（43 位）", "password"]],
    test: { url: "/im/wechat/test", body: { which: "wecom" }, ok: () => "凭证有效。回调地址还需你暴露公网 HTTPS 并在企微后台点「保存」验证" },
    help: ["管理后台 → 应用管理 → 自建应用：拿 AgentId 与 Secret；「我的企业」拿 CorpID", "「接收消息 → 设置 API 接收」随机生成 Token 与 EncodingAESKey，回填这里", "回调 URL 填 https://你的域名/im/wecom/events（内网穿透/反代都行），保存后腾讯会来验证"],
    status: (st) => wxStatus(st.wecom_app) },
  { key: "wechat_mp", grp: "chat", icon: "🟢", name: "微信公众号", sub: "需公网 HTTPS + 认证服务号", path: "wechat_mp", src: "wechat_mp",
    fields: [["app_id", "AppID"], ["app_secret", "AppSecret", "password"], ["token", "Token"], ["aes_key", "EncodingAESKey（43 位）", "password"]],
    test: { url: "/im/wechat/test", body: { which: "mp" }, ok: () => "凭证有效。回调地址还需你暴露公网 HTTPS 并在公众平台点「提交」验证" },
    help: ["公众平台 → 开发 → 基本配置：拿 AppID / AppSecret", "服务器配置 URL 填 https://你的域名/im/mp/events，加解密选「安全模式」，Token 与 EncodingAESKey 回填这里", "结果走「客服消息」异步推送，需要已认证的服务号（未认证会返回 48001，这里如实报错）"],
    status: (st) => wxStatus(st.wechat_mp) },
  { key: "wecom_bot", grp: "push", icon: "💼", name: "企业微信群", sub: "只出不进 · 推送结果",
    fields: [["wecom_bot_webhook", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."]],
    help: ["群里添加「群机器人」，把 webhook 地址粘贴到这里", "任务与定时任务的结果自动推到群里；要双向对话用上面的「企业微信应用」"],
    status: (st) => ((st.wecom || {}).configured ? ["ok", "已配置"] : ["off", "未配置"]) },
  { key: "dingtalk", grp: "push", icon: "📌", name: "钉钉群", sub: "只出不进 · 推送结果",
    fields: [["dingtalk_webhook", "https://oapi.dingtalk.com/robot/send?access_token=..."], ["dingtalk_secret", "加签密钥 SEC...（未选加签则留空）", "password", "opt"]],
    help: ["钉钉群 → 群设置 → 机器人 → 添加「自定义机器人」", "安全设置选「加签」，把 webhook 与加签密钥填到这里"],
    status: (st) => ((st.dingtalk || {}).configured ? ["ok", "已配置"] : ["off", "未配置"]) },
  { key: "webhook", grp: "push", icon: "🔗", name: "通用 Webhook", sub: "外部工具桥接进来",
    fields: [["webhook_secret", "自定义一个密钥", "password"]],
    help: ["外部工具（微信框架 / 钉钉 outgoing / 快捷指令）POST /im/task 时带这个密钥校验", "微信客服号、小程序、企微「智能助理」等依赖腾讯定向资质，本版不做假连接，用这里桥接"],
    status: (st) => ((st.webhook || {}).secret_set ? ["ok", "已设密钥"] : ["off", "未设密钥"]) },
  { key: "feishu_me", grp: "lark", icon: "🪪", name: "飞书本人身份", sub: "AI 以你的身份读日历 / 云文档 / 邮件", lark: true, noConn: true,
    help: ["本机装 lark-cli：npx @larksuite/cli@latest install", "用上面飞书卡的 App ID / App Secret 绑定，再扫码授权你本人", "授权后 AI 能用 lark-cli 查你的日历、读写云文档、收发邮件"] },
  { key: "feishu_doc", grp: "lark", icon: "📄", name: "飞书云文档", sub: "AI 直接把结果写成云文档", path: "feishu", src: "feishu",
    fields: [["doc_app_id", "云文档 App ID（留空 = 沿用飞书机器人凭证）", "", "opt"], ["doc_app_secret", "云文档 App Secret", "password", "opt"]],
    help: ["机器人应用本身开通 docx:document 权限就够，这里可以留空", "只有云文档想走另一个应用时才单独填一组凭证"],
    status: (_st, get) => (get("feishu_doc", "doc_app_id") ? ["ok", "独立凭证"] : ["off", "沿用机器人凭证"]) },
];

function renderImPane(pane, s) {
  const im = s.im || {};
  const cfgVal = (c, f) => String(((c.path ? im[c.path] : im) || {})[f] || "");
  const inputId = (c, f) => `im-${c.key}-${f}`;
  const getField = (key, f) => { const el = pane.querySelector("#" + inputId({ key }, f)); return el ? el.value.trim() : ""; };
  const fieldsHtml = (c) => (c.fields || []).map(([f, ph, type]) =>
    `<input id="${inputId(c, f)}" type="${type === "password" ? "password" : "text"}" placeholder="${esc(ph)}" value="${esc(cfgVal(c, f))}" autocomplete="off" spellcheck="false">`).join("");
  const helpHtml = (c) => (c.help ? `<details class="im-help"><summary>怎么拿凭证</summary><ol>${c.help.map((h) => `<li>${esc(h)}</li>`).join("")}</ol></details>` : "");
  // 「一次粘贴自动填」：省掉在两个网页之间来回抄两串东西这件最容易出错的事
  const pasteHtml = (c) => (c.paste ? `<details class="im-help im-paste" data-paste="${c.key}"><summary>不想手打？粘一段过来自动识别</summary>
      <div class="d" style="font-size:12px;margin:2px 0 6px">${esc(c.paste.hint)}</div>
      <textarea id="im-${c.key}-paste" rows="3" placeholder="在这里粘贴，识别到的两串会自动填进上面的输入框" spellcheck="false" style="width:100%;box-sizing:border-box"></textarea>
      <div class="im-r ok-msg" data-paste-r="${c.key}"></div></details>` : "");
  // 「扫码新建应用」：本机 lark-cli 替你在飞书开放平台建一个应用，凭证自己填进来。
  // 用户问过两次「不能扫码连机器人吗」——单纯扫码不行（机器人=应用，平台只认 app_id/secret），
  // 但可以扫码把应用建出来，效果一样：一个字都不用手打。
  const newappHtml = (c) => (c.newapp ? `<div class="im-newapp" data-newapp="${c.key}">
      <button class="btn-plain" data-act="newapp">📱 扫码新建应用</button>
      <span class="d" style="font-size:12px;margin-left:8px">没有现成应用？让本机 lark-cli 替你建一个，建完 App ID 自动填上</span>
      <div data-newapp-qr="${c.key}" style="display:none;margin:8px 0">
        <img alt="新建飞书应用的授权二维码" style="width:176px;height:176px;border-radius:8px;background:#fff;padding:6px;border:1px solid var(--wb-border)">
        <div class="d" style="font-size:12px;margin-top:4px">用飞书扫这个码，或 <a class="link" target="_blank" rel="noopener" data-newapp-link="${c.key}">在浏览器里打开</a>，按提示建好应用即可</div>
      </div>
      <div class="im-r ok-msg" data-newapp-r="${c.key}"></div>
    </div>` : "");
  const bodyHtml = (c) => {
    if (c.qr) return `<div id="ilk-box" style="display:none;margin:4px 0 8px"><img id="ilk-img" alt="微信登录二维码" style="width:176px;height:176px;border-radius:8px;background:#fff;padding:6px;border:1px solid var(--wb-border)"></div><div class="im-r ok-msg" id="ilk-r">还没扫码。点右上角「连接」取二维码</div>${helpHtml(c)}`;
    if (c.lark) return `<div id="fs-qr-body" class="d" style="font-size:13px">检测 lark-cli…</div>${helpHtml(c)}`;
    return `${newappHtml(c)}${fieldsHtml(c)}${pasteHtml(c)}${c.src ? `<div class="im-src">${keyLink(c.src)}</div>` : ""}<div class="im-r ok-msg" data-r="${c.key}"></div>${helpHtml(c)}`;
  };
  const cardHtml = (c) => `<div class="im-card packed" data-ch="${c.key}">
      <div class="im-card-h" role="button" tabindex="0" aria-expanded="false" data-activate="1" title="点一下展开 / 收起">
        <span class="ic">${c.icon}</span>
        <div class="tt"><b>${esc(c.name)}</b><span>${esc(c.sub)}</span></div>
        <span class="im-st off"><i class="dot"></i><em>…</em></span>
        ${c.noConn ? "" : `<button class="btn-plain im-conn" data-act="connect">连接</button>`}
        <i class="im-ar" aria-hidden="true"></i>
      </div>
      <div class="im-card-b">${bodyHtml(c)}</div>
    </div>`;
  const grp = (k) => IM_CHANNELS.filter((c) => c.grp === k).map(cardHtml).join("");
  const sec = (title, desc, inner) => `<section class="im-sec"><div class="im-sec-h"><b>${title}</b><span>${desc}</span></div><div class="im-grid">${inner}</div></section>`;
  pane.innerHTML = `
    ${sec("远程指挥", "在这些 IM 里私聊或 @机器人 就能下任务，结果回到聊天里", grp("chat"))}
    ${sec("结果推送", "只出不进：任务和定时任务跑完自动推一份", grp("push"))}
    ${sec("飞书增强", "让 AI 以你本人身份操作飞书、直接生成云文档", grp("lark"))}
    ${sec("上下文管理", "IM 会话带多久的历史、什么时候另起一段", `
      <div class="im-card im-card-static packed">
        <div class="im-card-h" role="button" tabindex="0" aria-expanded="false" data-activate="1" title="点一下展开 / 收起"><span class="ic">⏱</span><div class="tt"><b>闲置自动开新会话</b><span>太久没聊，下一条不再带旧上下文</span></div><i class="im-ar" aria-hidden="true"></i></div>
        <div class="im-card-b"><div class="im-act">超过 <input id="im-idle" type="number" min="0" max="720" style="width:72px;margin:0" value="${esc(String(im.session_idle_hours ?? 0))}"> 小时没对话就另起一段（0 = 关闭）</div></div>
      </div>
      <div class="im-card im-card-static packed">
        <div class="im-card-h" role="button" tabindex="0" aria-expanded="false" data-activate="1" title="点一下展开 / 收起"><span class="ic">🧹</span><div class="tt"><b>清空 IM 会话记忆</b><span id="im-sess-n">正在数…</span></div><button class="btn-plain im-conn" id="im-sess-clear">清空全部</button><i class="im-ar" aria-hidden="true"></i></div>
        <div class="im-card-b"><div class="d" style="font-size:12px">只清 IM 通道里的对话上下文（飞书 / QQ / 微信各自一段），网页对话和长期记忆不受影响。上下文预算（多长开始截）在 <a class="link" id="im-goto-agent" href="#">智能体设置</a> 里调。</div><div class="im-r ok-msg" id="im-sess-r"></div></div>
      </div>`)}
    <div style="display:flex;align-items:center;gap:10px;margin-top:4px"><button class="btn-brand" id="im-save">保存全部</button><span class="ok-msg" id="im-msg"></span><span class="d" style="font-size:12px;margin-left:auto">其他助理通道：钉钉机器人双向 / Telegram / Slack 都走「通用 Webhook」桥接</span></div>`;

  // ---------- 读回 / 保存 ----------
  const imPayload = () => {
    const out = { feishu: {}, qq: {}, wecom_app: {}, wechat_mp: {} };
    for (const c of IM_CHANNELS) for (const [f] of c.fields || []) {
      const v = getField(c.key, f);
      if (c.path) out[c.path][f] = v; else out[f] = v;
    }
    out.session_idle_hours = +pane.querySelector("#im-idle").value || 0;
    return { im: out };
  };
  const globalMsg = pane.querySelector("#im-msg");
  const say = (c, txt, err) => {
    const r = c.qr ? pane.querySelector("#ilk-r") : pane.querySelector(`[data-r="${c.key}"]`);
    if (!r) return;
    r.style.color = err ? "var(--wb-err)" : "";
    r.textContent = txt;
  };

  // ---------- 状态灯：每张卡自己决定亮什么色、按钮写「连接」还是「取消连接」 ----------
  const applyStatus = (st, packInitial) => {
    for (const c of IM_CHANNELS) {
      const card = pane.querySelector(`[data-ch="${c.key}"]`);
      if (!card || !c.status) continue;
      const [cls, txt] = c.status(st || {}, getField);
      const chip = card.querySelector(".im-st");
      chip.className = "im-st " + cls;
      chip.querySelector("em").textContent = txt;
      card.classList.toggle("on", cls === "ok");
      const btn = card.querySelector(".im-conn");
      if (btn && !btn._arming) {
        btn.dataset.act = cls === "ok" ? "disconnect" : "connect";
        btn.textContent = cls === "ok" ? "取消连接" : "连接";
        btn.classList.remove("danger");
      }
      // 这里**不碰**展开状态。以前是「连上的收起、没连的摊开等你填」，等于一进来就有四五张卡
      // 摊在屏幕上，全是你根本没打算连的渠道的输入框。默认全收起，点了才展开——
      // 一屏能看全有哪些渠道、哪个已经连上了，比一屏摊满空表单有用得多。
      void packInitial;
    }
  };
  const refreshStatus = async (packInitial) => {
    let st = {};
    try { st = await fetch("/im/status").then(r => r.json()); } catch {}
    applyStatus(st, packInitial);
    if (typeof refreshImStatus === "function") refreshImStatus();
    return st;
  };

  // ---------- 连接 / 取消连接 ----------
  const connect = async (c, btn) => {
    const card = btn.closest(".im-card");
    setPacked(card, false);
    if (c.qr) return ilkStart();
    const miss = (c.fields || []).filter(([f, , , opt]) => opt !== "opt" && !getField(c.key, f)).map(([, label]) => label.split("（")[0]);
    if (miss.length) return say(c, `还差 ${miss.join(" / ")} 没填。填完再点「连接」`, true);
    btn.disabled = true;
    say(c, "保存中…");
    try {
      if (!(await saveSettings(imPayload(), globalMsg))) return say(c, "❌ 保存失败", true);
      if (c.test) {
        say(c, "测试中…");
        const d = await fetch(c.test.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c.test.body || {}) })
          .then(r => r.json()).catch((e) => ({ ok: false, error: e.message }));
        if (!d.ok) return say(c, "❌ " + (d.error || "测试失败"), true);
        say(c, "✅ " + c.test.ok(d));
      } else say(c, "✅ 已保存");
    } finally {
      btn.disabled = false;
      await refreshStatus(false);
      if (card.classList.contains("on")) setPacked(card, true); // 真连上了就收起，屏幕还给下一张卡
    }
  };
  const disconnect = async (c, btn) => {
    // 两步确认：第一下只变红问一句，4 秒内再点一下才真断。清凭证不可逆，误触成本太高
    if (!btn._arming) {
      btn._arming = true;
      btn.textContent = "确认断开？";
      btn.classList.add("danger");
      btn._armT = setTimeout(() => { btn._arming = false; btn.textContent = "取消连接"; btn.classList.remove("danger"); }, 4000);
      return;
    }
    clearTimeout(btn._armT);
    btn._arming = false;
    btn.disabled = true;
    const card = btn.closest(".im-card");
    try {
      if (c.qr) {
        ilkRun++; // 作废在跑的轮询，否则它扫码成功后又把登录态写回来
        const box = pane.querySelector("#ilk-box"); if (box) box.style.display = "none";
        const d = await fetch("/im/wechat/disconnect", { method: "POST" }).then(r => r.json()).catch((e) => ({ ok: false, error: e.message }));
        if (!d.ok) throw new Error(d.error || "断开失败");
        say(c, "已断开，登录态已清除");
      } else {
        for (const [f] of c.fields || []) pane.querySelector("#" + inputId(c, f)).value = "";
        // 服务端默认「空值不覆盖已存的凭证」，所以真要清必须点名——否则清了个寂寞
        const payload = imPayload();
        payload.im.clear = (c.fields || []).map(([f]) => (c.path ? `${c.path}.${f}` : f));
        if (!(await saveSettings(payload, globalMsg))) throw new Error("保存失败");
        say(c, "已断开，凭证已清空");
      }
      setPacked(card, false); // 断开之后摊开，让你能马上重填
    } catch (e) {
      say(c, "❌ " + e.message, true);
    } finally {
      btn.disabled = false;
      await refreshStatus(false);
    }
  };

  // ---------- 扫码新建应用：让本机 lark-cli 替你在飞书开放平台建一个应用 ----------
  // 单纯「扫码连机器人」在飞书是做不到的（机器人=应用，平台只认 app_id/app_secret）。
  // 但可以扫码把应用**建出来**，凭证由后端直接接管 —— 效果一样：一个字都不用手打。
  let newappPolling = false;
  const newappSay = (c, txt, err, link) => {
    const r = pane.querySelector(`[data-newapp-r="${c.key}"]`);
    if (!r) return;
    r.style.color = err ? "var(--wb-err)" : "";
    r.textContent = txt;
    if (link) {
      r.append(" ");
      const a = document.createElement("a");
      a.className = "link"; a.target = "_blank"; a.rel = "noopener";
      a.href = link; a.textContent = "打开凭证页 →";
      r.append(a);
    }
  };
  const newappCreate = async (c, btn) => {
    if (newappPolling) return;
    const box = pane.querySelector(`[data-newapp-qr="${c.key}"]`);
    btn.disabled = true;
    newappSay(c, "正在让 lark-cli 起一个新应用…（第一次要等十几秒）");
    try {
      const d = await fetch("/api/feishu/app/create", { method: "POST" }).then((r) => r.json()).catch((e) => ({ error: e.message }));
      if (!d || !d.ok) {
        if (box) box.style.display = "none";
        return newappSay(c, "❌ " + ((d && d.error) || "起不来，看看本机装没装 lark-cli"), true);
      }
      if (box) {
        const img = box.querySelector("img");
        const a = box.querySelector(`[data-newapp-link="${c.key}"]`);
        if (img) { if (d.qr) img.src = d.qr; img.style.display = d.qr ? "" : "none"; }
        if (a) a.href = d.url || "#";
        box.style.display = "";
      }
      newappSay(c, "用飞书扫码（或点上面的链接）建应用，建完这里会自动填好凭证。等你操作…");
      newappPolling = true;
      const t0 = Date.now();
      while (Date.now() - t0 < 15 * 60 * 1000) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await fetch("/api/feishu/app/create/status").then((r) => r.json()).catch(() => null);
        if (!st) continue;
        if (st.state === "ok") {
          const el = pane.querySelector("#" + inputId(c, "app_id"));
          if (el && st.app_id) el.value = st.app_id; // secret 留空：后端已经存好，空值不会覆盖
          if (box) box.style.display = "none";
          newappSay(c, "✅ 应用建好了" + (st.app_id ? "（App ID " + st.app_id + "）" : "") + "，凭证已经填进来，长连接正在起");
          await refreshStatus(false);
          return;
        }
        // 应用建出来了，但 secret 被 lark-cli 锁在系统钥匙串里读不出来 —— App ID 先替你填上，
        // 剩最后一步：去凭证页复制 App Secret 粘进来。不算失败，所以不标红。
        if (st.state === "need_secret") {
          const el = pane.querySelector("#" + inputId(c, "app_id"));
          if (el && st.app_id) el.value = st.app_id;
          if (box) box.style.display = "none";
          newappSay(c, "✅ 应用建好了（App ID 已经替你填上）。" + (st.error || ""), false, st.console_url || "");
          return;
        }
        if (st.state === "error") {
          if (box) box.style.display = "none";
          return newappSay(c, "❌ " + (st.error || "没建成"), true);
        }
      }
      newappSay(c, "等了 15 分钟没等到，重新点一次吧", true);
    } finally {
      newappPolling = false;
      btn.disabled = false;
    }
  };

  pane.addEventListener("click", (e) => {
    const btn = e.target.closest(".im-conn[data-act]");
    if (btn) {
      e.stopPropagation();
      const c = IM_CHANNELS.find((x) => x.key === (btn.closest(".im-card") || {}).dataset?.ch);
      if (!c) return;
      return btn.dataset.act === "disconnect" ? disconnect(c, btn) : connect(c, btn);
    }
    const nb = e.target.closest('[data-act="newapp"]');
    if (nb) {
      e.stopPropagation();
      const c = IM_CHANNELS.find((x) => x.key === (nb.closest("[data-newapp]") || {}).dataset?.newapp);
      if (c) newappCreate(c, nb);
      return;
    }
    const h = e.target.closest(".im-card-h");
    if (h && h.dataset.activate && !e.target.closest("button")) {
      const card = h.closest(".im-card");
      h.setAttribute("aria-expanded", String(!card.classList.toggle("packed")));
    }
  });
  // 粘进来就认，不用再点一次按钮
  for (const c of IM_CHANNELS.filter((x) => x.paste)) {
    const ta = pane.querySelector(`#im-${c.key}-paste`);
    const r = pane.querySelector(`[data-paste-r="${c.key}"]`);
    if (!ta || !r) continue;
    const take = () => {
      const got = c.paste.parse(ta.value);
      const filled = [];
      for (const [f, label] of c.fields || []) {
        if (!got[f]) continue;
        const el = pane.querySelector("#" + inputId(c, f));
        if (!el) continue;
        el.value = got[f];
        filled.push(label);
      }
      r.style.color = filled.length ? "" : "var(--wb-err)";
      r.textContent = filled.length
        ? `✅ 认出了 ${filled.join(" 和 ")}，已填进上面。核对一下就点右上角「连接」`
        : "没认出凭证。飞书的 App ID 长这样 cli_xxxxxxxx，App Secret 是 32 位字母数字";
      if (filled.length) ta.value = ""; // 认完就清掉，凭证不留在输入框里
    };
    ta.addEventListener("paste", () => setTimeout(take, 0));
    ta.addEventListener("input", () => { if (ta.value.trim().length > 20) take(); });
  }
  pane.querySelector("#im-save").onclick = async () => {
    if (await saveSettings(imPayload(), globalMsg)) refreshStatus(false);
  };
  pane.querySelector("#im-goto-agent").onclick = (e) => { e.preventDefault(); renderSettings("agent"); };

  // ---------- 上下文管理：数会话 / 一键清空（同样两步确认） ----------
  const sessN = pane.querySelector("#im-sess-n"), sessR = pane.querySelector("#im-sess-r"), sessBtn = pane.querySelector("#im-sess-clear");
  const loadSess = async () => {
    try {
      const d = await fetch("/im/sessions").then(r => r.json());
      sessN.textContent = d.count ? `${d.count} 段会话正记着上下文` : "现在没有任何 IM 会话上下文";
      sessBtn.disabled = !d.count;
    } catch { sessN.textContent = "数不出来（服务没起？）"; }
  };
  sessBtn.onclick = async () => {
    if (!sessBtn._arming) {
      sessBtn._arming = true; sessBtn.textContent = "确认清空？"; sessBtn.classList.add("danger");
      sessBtn._armT = setTimeout(() => { sessBtn._arming = false; sessBtn.textContent = "清空全部"; sessBtn.classList.remove("danger"); }, 4000);
      return;
    }
    clearTimeout(sessBtn._armT); sessBtn._arming = false; sessBtn.textContent = "清空全部"; sessBtn.classList.remove("danger"); sessBtn.disabled = true;
    try {
      const d = await fetch("/im/sessions/clear", { method: "POST" }).then(r => r.json());
      if (!d.ok) throw new Error(d.error || "清空失败");
      sessR.style.color = ""; sessR.textContent = `✅ 已清空 ${d.cleared} 段会话，下一条 IM 消息从零开始`;
    } catch (e) { sessR.style.color = "var(--wb-err)"; sessR.textContent = "❌ " + e.message; }
    loadSess();
  };

  // ---------- 微信扫码：取码 → 轮询状态（服务端一次挂最多 35 秒，回 wait 就接着问） ----------
  let ilkRun = 0; // 每次取码自增，旧轮询看见对不上就自己退出，防止两轮并行
  const ilkC = IM_CHANNELS.find((x) => x.qr);
  const ilkSay = (txt, err) => say(ilkC, txt, err);
  const ilkStart = async () => {
    const ilkBox = pane.querySelector("#ilk-box"), ilkImg = pane.querySelector("#ilk-img");
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
        await refreshStatus(false);
        const card = pane.querySelector('[data-ch="wechat_ilink"]');
        if (card && card.classList.contains("on")) setPacked(card, true);
        return;
      }
      if (d.status === "expired") {
        ilkBox.style.display = "none";
        return ilkSay("二维码已过期，请重新点「连接」", true);
      }
      if (d.status === "scaned") ilkSay("已扫码，请在手机上点确认");
    }
  };

  refreshStatus(true);
  loadSess();
  renderLarkQr(pane);
}

// ================= 安全中心面板 =================
