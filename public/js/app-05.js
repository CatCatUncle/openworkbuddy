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
    if (!resp.ok) toast((d.error || "保存失败"), "circle-x");
    // 体检结果只提醒不拦（后端也不拦）。挂在 hubState 上而不是弹 toast：
    // 这几条要对着卡片一条条看，toast 三秒就没了，等于没说。
    hubState.mcpAdvice = resp.ok ? (d.advice || null) : hubState.mcpAdvice;
    renderHubBody();
  };
  // 死因里带着进程最后几行 stderr，两三百字是常事：当标签胶囊放只会裁出中间一截。
  // 换成自己的块，先显三行（卡片在网格里，一条长错误会把整行撑高），展开看全文。
  const ERR_FALLBACK = "命令启动失败或握手超时，详见应用日志";
  const mcpErrBlock = (why) => {
    const t = String(why || ERR_FALLBACK);
    return `<div class="mcp-server-error" title="${esc(t)}"><span>${esc(t)}</span></div>` +
      `<button class="mcp-err-more" hidden>展开</button>`;
  };
  // 角标不换行，名字太长就会顶出卡片。中文字算两格，超了就截，全名留在 title 里。
  const shortName = (s, max = 22) => {
    const t = String(s || ""); let w = 0, i = 0;
    for (; i < t.length; i++) { w += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(t[i]) ? 2 : 1; if (w > max) break; }
    return i < t.length ? t.slice(0, Math.max(1, i - 1)) + "\u2026" : t;
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
      ${on ? '<span class="flag">已接入</span>' : miss ? `<span class="flag" style="color:var(--owb-err-text)">没找到 ${esc(miss)}</span>`
        : it.blocked ? '<span class="flag" style="color:var(--owb-err-text)">内网连不上</span>' : ""}
      <div class="hd"><div class="av">${ava(it.icon, "plug")}</div>
        <div class="nm"><span>${esc(it.label || it.name)}</span><span class="al">${esc(it.name)}</span></div></div>
      <div class="ds">${esc(it.desc || "")}</div>
      ${it.blocked ? `<div class="ds" style="opacity:.75">${esc(it.blockedWhy || "")}</div>` : ""}
      <div class="tg">${it.tag ? `<i>${esc(it.tag)}</i>` : it.kind === "http" ? "<i>远程</i>" : `<i>${esc(String(it.command || "").split(/[\\/]/).pop())}</i>`}${keys ? `<i>要填 ${keys} 个 Key</i>` : "<i>免 Key</i>"}${it.docs ? `<a class="mcp-docs-link" href="${esc(it.docs)}" target="_blank" rel="noopener">去哪拿${ic("arrow-right")}</a>` : ""}</div>
      ${po ? `<div class="ops"><button class="mcp-use${on ? "" : " primary"}"${on ? " disabled" : ""}>${on ? "已接入" : "接入"}</button></div>` : ""}
    </div>`;
  };
  // 内网开关摆在连接器这一页，是因为它的后果全在这页上看得见：一打开，连不上的境外连接器
  // 当场标出来、排到最后。只有平台管理员画得到（下面 `if (!po) return` 之后才绑事件），
  // 而它从不删改任何已经配好的东西——判断错了关掉就全恢复，所以不用弹二次确认。
  const intranetSec = !po ? "" : `
    <div class="hub-sec-title" style="margin-top:22px">网络环境
      <span class="sub">这台机器能不能连上境外服务。据实说就行——它只改提示，不动你已经配好的任何东西</span></div>
    <label class="hub-desc" style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;margin-top:8px">
      <input type="checkbox" id="mcp-intranet" style="margin:2px 0 0"${cat.intranet ? " checked" : ""}>
      <span>内网模式：连不上的境外连接器给标出来、排到最后（<b>不删</b>，有代理照样接得上）；从 GitHub 装技能当场说清楚，不再白等 30 秒超时</span>
    </label>`;
  const presetSec = !po || !presets.length ? "" : `
    <div class="hub-sec-title" style="margin-top:22px">推荐连接器
      <span class="sub">点「接入」我会把启动命令填好，要 Key 的填上就能连；都是官方或社区现成的 MCP 服务器</span></div>
    ${!tools.uvx && presets.some(it => it.needs === "uvx") ? '<div class="hub-desc">本机没找到 uvx：标着 uvx 的连接器要先装 uv（macOS 装法：brew install uv）</div>' : ""}
    ${!tools.npx && presets.some(it => it.needs && it.needs !== "uvx") ? '<div class="hub-desc">本机没找到 npx：先装 Node.js（自带 npx）再来接本地连接器</div>' : ""}
    ${(cat.notes || []).map(n => `<div class="hub-desc">${esc(n)}</div>`).join("")}
    ${(cat.categories || []).map(c => {
      const its = presets.filter(it => it.category === c);
      return its.length ? `<div class="hub-desc" style="margin-top:12px">${esc(c)}</div><div class="card-grid">${its.map(presetCard).join("")}</div>` : "";
    }).join("")}`;
  // 刚保存完那一趟的体检结果。只在这一页存在，切走再回来就没了——
  // 它说的是「你刚提交的那份配置」，配置都换了还挂着旧结论会误导人。
  const adv = hubState.mcpAdvice;
  hubState.mcpAdvice = null;
  const adviceBox = !adv || !po ? "" : `
    <div class="hub-desc" style="margin-top:14px;border-left:3px solid var(--owb-warn, #d97706);padding-left:10px">
      <b>存下了，另外有 ${adv.findings.length + (adv.more || 0)} 处想让你看一眼</b>（外挂的 toolward 扫出来的，只是提醒，没拦任何东西）：
      ${adv.findings.map(f => `<div style="margin-top:4px">· ${esc(f.file)}${f.line ? ":" + f.line : ""} — ${esc(f.why)}</div>`).join("")}
      ${adv.more ? `<div style="margin-top:4px">· …另外 ${adv.more} 处</div>` : ""}
      <div style="margin-top:6px;opacity:.75">你填的 Key 和令牌没有交给它：只把变量名递过去，值全换成了 ***。</div>
    </div>`;
  box.innerHTML = `${adviceBox}
    <div class="hub-sec-title" style="margin-top:14px">已接入的外部工具
      <span class="sub">通过 MCP（本地 stdio / 远程 Streamable HTTP）给智能体接外部能力，当前 ${data.servers.length} 个服务器 · <b>${data.total_tools}</b> 个工具已注入，任务里可直接调用</span></div>
    <div class="card-grid">
      ${po ? `<div class="ex-card add" id="mcp-open-add">${ic("plus")}添加连接器</div>` : ""}
      ${list.map(({ sv, i }) => `
        <div class="ex-card mcp-server-card" data-mi="${i}">
          ${sv.plugin ? `<span class="flag" title="来自插件 ${esc(sv.plugin)}">来自插件 ${esc(shortName(sv.plugin))}</span>` : ""}
          <div class="hd"><div class="av${sv.connected ? "" : " bad"}">${ic(sv.connected ? "plug" : "triangle-alert")}</div>
            <div class="nm"><span>${esc(sv.name)}</span><span class="al ${sv.connected ? "ok" : "bad"}">${sv.connected ? `已连接 · ${sv.tools.length} 个工具` : "未连接"}</span></div></div>
          <div class="ds mcp-server-command" title="${esc(isRemote(sv) ? sv.url : [sv.command, ...(sv.args || [])].join(" "))}">${isRemote(sv)
            ? `<b style="font-family:inherit;opacity:.6">远程 ·</b> ` + esc(sv.url) + ((sv.header_keys || []).length ? ` <span style="opacity:.7">（带 ${sv.header_keys.length} 个请求头：${esc(sv.header_keys.join("、"))}）</span>` : "")
            : `<b style="font-family:inherit;opacity:.6">本地 ·</b> ` + esc(sv.command) + " " + esc((sv.args || []).join(" ")) + ((sv.env_keys || []).length ? ` <span style="opacity:.7">（带 ${sv.env_keys.length} 个环境变量：${esc(sv.env_keys.join("、"))}）</span>` : "")}</div>
          ${sv.connected
            ? `<div class="tg">${(sv.tools || []).slice(0, 8).map(t => `<i title="${esc(t.description || "")}">${esc(t.name)}</i>`).join("") + ((sv.tools || []).length > 8 ? `<i>…共 ${sv.tools.length} 个</i>` : "")}</div>`
            : mcpErrBlock(sv.error)}
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
        <label style="display:flex;gap:5px;align-items:center;flex:none"><input type="radio" name="mcp-kind" value="stdio" checked>本地命令（stdio）</label>
        <label style="display:flex;gap:5px;align-items:center;flex:none"><input type="radio" name="mcp-kind" value="http">远程地址（Streamable HTTP）</label>
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
        <a id="mcp-docs" href="#" target="_blank" rel="noopener" style="display:none;font-size:13px">去哪拿 Key${ic("arrow-right")}</a>
        <span class="ab-empty" id="mcp-msg"></span></div>
    </div>`}` + intranetSec + presetSec;
  const form = box.querySelector("#mcp-add-form");
  if (!po) return; // 下面全是写的那条路：表单、接入、删除，成员一颗都没画，也就没什么可绑
  const openForm = () => { form.style.display = ""; form.scrollIntoView({ behavior: "smooth", block: "nearest" }); };
  box.querySelector("#mcp-open-add").onclick = openForm;
  const intranetBox = box.querySelector("#mcp-intranet");
  if (intranetBox) intranetBox.onchange = async () => {
    intranetBox.disabled = true;
    const want = intranetBox.checked;
    const resp = await fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intranet: want }),
    });
    if (!resp.ok) {
      // 存不上就把钩子拨回去。留在「看着已经开了、其实没存上」的状态最坑：
      // 用户以为设过了，下次进来又是关的，会以为是软件把设置吃了
      const d = await resp.json().catch(() => ({}));
      toast(d.error || "保存失败", "circle-x");
      intranetBox.checked = !want;
      intranetBox.disabled = false;
      return;
    }
    renderHubBody(); // 目录得重算：哪些标出来、怎么排，全跟着这个开关变
  };
  box.querySelector("#mcp-cancel").onclick = () => { form.style.display = "none"; };
  box.querySelectorAll(".ex-card[data-mi]").forEach(card => {
    const sv = data.servers[+card.dataset.mi];
    const errBox = card.querySelector(".mcp-server-error"), more = card.querySelector(".mcp-err-more");
    // 整块都可以点，不止那颗按钮——三行红字看着就像个能展开的东西，点哪儿都该有反应
    if (errBox && more) {
      // 多长算长不用猜：直接问浏览器裁没裁，没裁就不出那颗「展开」。
      // 整块没显示时量不出来（高度全是 0），那时候寎数字，宁可多给一颗也不能展不开。
      const inner = errBox.firstElementChild;
      more.hidden = inner && inner.clientHeight > 0
        ? inner.scrollHeight <= inner.clientHeight + 1
        : errBox.title.length <= 60;
      const toggle = () => { const open = errBox.classList.toggle("open"); more.textContent = open ? "收起" : "展开"; };
      errBox.onclick = () => { if (!more.hidden) toggle(); };
      more.onclick = toggle;
    }
    const del = card.querySelector(".mcp-del");
    if (del) del.onclick = async () => {
      if (!(await askConfirm({ title: `删掉连接器「${sv.name}」？`, hint: "模型手上就没有它带来的那些工具了。", ok: "删掉", danger: true }))) return;
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
    if (!name) return toast("名称必填", "circle-x");
    if (kindOf() === "http") {
      const url = box.querySelector("#mcp-url").value.trim();
      if (!url) return toast("远程连接器要填地址", "circle-x");
      // 「Key: Value」按第一个冒号切，令牌里本身带冒号也不会被切坏
      const headers = {};
      box.querySelector("#mcp-headers").value.split(/[\n;]+/).map(s => s.trim()).filter(Boolean).forEach(line => {
        const at = line.indexOf(":");
        if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      });
      const missing = (form.dataset.needHdr || "").split(",").filter(Boolean).filter(k => !String(headers[k] || "").replace(/^Bearer\s*/i, "").trim());
      if (missing.length) return toast(`还差 ${missing.join("、")} 没填`, "circle-x");
      return save(ownServers().concat([{ name, url, headers }]));
    }
    const cmd = box.querySelector("#mcp-cmd").value.trim();
    const args = box.querySelector("#mcp-args").value.trim().split(/\s+/).filter(Boolean);
    if (!cmd) return toast("本地连接器要填命令", "circle-x");
    // 「KEY=值」按第一个等号切，值里带等号（base64）也不会被切坏；没写值的行直接不要
    const env = {};
    for (const line of box.querySelector("#mcp-env").value.split(/\n+/).map(s => s.trim()).filter(Boolean)) {
      const at = line.indexOf("=");
      if (at <= 0) return toast("环境变量要写成 KEY=值", "circle-x");
      const k = line.slice(0, at).trim(), v = line.slice(at + 1).trim();
      if (v) env[k] = v;
    }
    const missing = (form.dataset.needEnv || "").split(",").filter(Boolean).filter(k => !env[k]);
    if (missing.length) return toast(`还差 ${missing.join("、")} 没填`, "circle-x");
    save(ownServers().concat([{ name, command: cmd, args, env }]));
  };
}

// ================= 参考模板库（照着抄的提示词，点一下填进输入框） =================
// 每条都对应本地真实具备的能力（技能包 / 工具 / 专家团），不写做不到的画饼模板。
const PROMPT_TPLS = [
  { c: "网页", icon: "monitor", t: "做一个工作台/仪表盘", d: "先定视觉方向，再按数据排版",
    p: `做一个「__主题__工作台」单页网站：\n\n【内容】顶部标题栏 + 关键指标卡（几个由数据说了算，别凑整）+ 主区域（__放什么__）+ 侧边__放什么__\n【数据】用我工作区里的 __文件名__；没有数据就先造 8 条像真的示例数据，并在页面上标注「示例数据」\n【技术】单文件 HTML，CSS/JS 全部内联，脚本样式不引外部 CDN，断网也能打开\n【风格】动笔前先说一句这页的参照物和主色（比如「像终端里的监控面板，暗底信号绿」），别默认白底蓝标题\n【体验】移动端优先；跟随系统深浅色，纯暗色风格则写死 color-scheme；交互要有 hover/点击反馈\n\n做完把文件读回来自查一遍：有没有引用外部资源、有没有空的 onclick。` },
  { c: "网页", icon: "target", t: "做一个产品落地页", d: "先给三版方向，选一版再动笔",
    p: `帮我做一个「__产品名__」的落地页（单文件 HTML）：\n\n先别动手——给我三个不同的视觉方向，每个一句话说清参照物、主色、首屏怎么组织（比如「像一份纸质说明书：暖白底、衬线标题、首屏只有一句话和一张大图」），我选一个你再写；\n首屏一句话说清「给谁解决什么问题」，别写形容词堆砌；\n往下放什么按这个产品的实际情况定（卖点、真实案例、定价、常见问题、用前用后对比都行），别套「三个卖点＋五条 FAQ」的固定模板；\n底部行动召唤按钮。\n\nCSS 内联，移动端优先。` },
  { c: "研究", icon: "search", t: "深度研究一个课题", d: "拆子问题→逐个查证→自我挑刺→带来源报告",
    p: `帮我深度研究「__课题__」：\n\n1) 先把它拆成 5 个以内的子问题，列出来给我看；\n2) 逐个联网检索并打开原文核对，不要只看搜索摘要；\n3) 写完初稿后自己找一轮反面证据，能推翻的结论就改掉；\n4) 输出研究报告：结论先行 → 论据 → 不确定的地方 → 来源清单（带链接和日期）。\n\n查不到的就写「未找到公开信息」，绝对不许编数字和来源。` },
  { c: "研究", icon: "scale", t: "竞品横向对比", d: "先定维度再逐条填表，出差异化建议",
    p: `帮我对比「__A__ / __B__ / __C__」：\n\n先定出 6-8 个对比维度（定价、目标用户、核心能力、部署方式、生态、短板…），列出来；\n逐条联网查证填表，每格标注信息来源和获取日期；查不到写「未公开」，不许推测；\n最后给：① 对比表 ② 各自最适合谁 ③ 如果我要做同类产品，切哪个缝隙。` },
  { c: "数据", icon: "chart-column", t: "数据文件变分析报告", d: "读数→算指标→画图→写结论",
    p: `读取工作区里的 __文件名__，做一份分析：\n\n1) 先告诉我这份数据有多少行、有哪些字段、有没有缺失或异常值；\n2) 算出这几个指标：__指标1__、__指标2__ 的环比/同比变化；\n3) 画 2-3 张图（趋势 + 构成），存成图片；\n4) 输出一份 Word 报告：结论写最前面，图表跟在对应结论后面。\n\n算不出来的指标直接说算不出来，别用估计值糊弄。` },
  { c: "数据", icon: "trending-up", t: "把结论做成图表", d: "指定图表类型，输出可直接用的图片",
    p: `把下面这组数据画成图：\n\n__粘贴数据__\n\n要求：__折线/柱状/饼图/散点__，中文标签不要乱码，坐标轴带单位，标题写结论不写「XX图」。\n生成图片存到工作区，并告诉我文件名。` },
  { c: "办公", icon: "presentation", t: "材料整理成 PPT", d: "16:9，每页一个主题，标题写结论",
    p: `把 __工作区里的 XX 文件 / 下面这段内容__ 整理成一份 16:9 的 PPT：\n\n页数控制在 __10__ 页以内；\n每页一个主题，标题直接写结论（比如「获客成本降了 32%」而不是「获客成本分析」）；\n有数据的页配图表，没数据的页别硬凑图；\n最后一页是行动建议，具体到谁在什么时候做什么。` },
  { c: "办公", icon: "notebook-pen", t: "会议记录变纪要", d: "决议 / 待办 / 待议 三段式",
    p: `把下面这段会议记录整理成纪要：\n\n__粘贴记录__\n\n分三段：\n【结论与决议】已经拍板的事；\n【待办】谁 · 做什么 · 什么时候前完成（没说负责人就写「待认领」）；\n【待议】有争议或没结论的。\n\n原文里没说的一律不许补充推断。` },
  { c: "办公", icon: "calendar-days", t: "写本周周报", d: "读工作区产出，自动汇总成周报",
    p: `帮我写这周的周报：\n\n先看看工作区里这周新增/修改了哪些文件，作为素材；\n补充这些我口述的进展：__…__\n\n格式：本周完成（带可验证的结果，不写「推进了」这种虚词）→ 下周计划 → 需要支持的事。\n控制在一页内。` },
  { c: "内容", icon: "pencil", t: "写一篇公众号文章", d: "先给选题角度再动笔",
    p: `写一篇关于「__主题__」的公众号文章：\n\n先给我 3 个不同的切入角度，我选一个你再动笔；\n目标读者是 __谁__，他们最关心 __什么__；\n开头 3 句话内必须让读者觉得「这说的是我」；\n中间要有具体的例子或数字，不要通篇讲道理；\n字数 __1500__ 字左右。` },
  { c: "内容", icon: "megaphone", t: "一条内容改成多平台版本", d: "同一个内核，不同平台的话术",
    p: `把下面这条内容改写成三个版本：\n\n__粘贴原文__\n\n① 公众号（正式、有结构、能读 3 分钟）\n② 小红书（口语、有情绪、带 emoji 和话题标签）\n③ 朋友圈（100 字内，一句话钩子）\n\n内核信息保持一致，别为了适配平台把事实改了。` },
  { c: "团队", icon: "users", t: "整团派活（专家团接力）", d: "一句话把复杂任务交给一支团队",
    p: `请把下面这个任务整体委派给专家团「__团队名__」（用 delegate_to_team）：\n\n__任务描述，越具体越好：要什么、给谁看、什么格式、什么时候要__\n\n拿回结果后你自己核一遍：说生成的文件真的存在吗？数据有出处吗？没问题再交给我。` },
  { c: "团队", icon: "id-card", t: "指名派给某个专家", d: "点名让某位专家单独干",
    p: `请把这件事委派给专家「__专家名__」：\n\n__任务描述__\n\n它汇报完你要替我核一遍再转给我。` },
  { c: "自动化", icon: "clock", t: "让它每天自动干一件事", d: "配合侧栏「自动化」建定时任务",
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
        <div class="hd"><span class="ic">${ic(t.icon)}</span><span class="tt">${esc(t.t)}</span><span class="ct">${esc(t.c)}</span><span class="chev">${ic("chevron-right")}</span></div>
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
        catch { toast("复制失败，手动选中上面的文字吧", "circle-x"); }
      };
    });
  };
  page.innerHTML = `
    <div class="hub-head">
      <div class="hub-sec-title" style="margin:0">照着抄就行 <span class="sub">点卡片看全文；带 __下划线__ 的地方换成你的内容；「填进输入框」直接开一条新任务</span></div>
      <div class="hub-search" style="margin-left:auto">${ic("search")}<input id="tpl-q" placeholder="搜模板…"></div>
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
/**
 * 「用这个专家 / 专家团 / 技能」：回对话页、把它挂成一枚标签，正文留空给用户自己写。
 * 跟 startTaskWith 的分工是：那个是**模板**（用户要在里面填空），这个是**身份**（谁来干这活）。
 * 身份不该以普通文本的形式赖在输入框里，见 app-01.js 的 useTag。
 */
function startTaskUsing(kind, name, seed) {
  document.getElementById("new-task").click();
  setUseTag({ kind, name });
  inputEl.value = seed || "";
  inputEl.dispatchEvent(new Event("input")); // 先让输入框按新内容撑高，否则下面的定位会被这次改高冲掉
  inputEl.focus();
  const m = seed ? /__[^_\n]*__/.exec(seed) : null;
  if (m) inputEl.setSelectionRange(m.index, m.index + m[0].length);
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
/**
 * 一条排期的「什么时候跑」。只跑一次的那种没有 cron，硬念 cron 会念出个空。
 * 后端 scheduler.describeWhen 是同一套话术，两边得说得一样——用户在审批卡片上看到
 * 「今天 14:05（只跑一次）」，回到这一页再看见另一种写法就会怀疑是不是排成了两条。
 */
/** Date → `2026-09-19T14:05`：datetime-local 只认这个格式，而且认的是**本地**时间。
 *  用 toISOString().slice(0,16) 会差出一个时区（在东八区就是早 8 小时），提醒会提前响 */
function localMin(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function whenToHuman(t) {
  if (!t || !t.at) return cronToHuman((t && t.cron) || "");
  const d = new Date(t.at);
  if (isNaN(d)) return String(t.at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return `${sameDay ? "今天" : `${d.getMonth() + 1} 月 ${d.getDate()} 日`} ${hm}（只跑一次）`;
}

// ================= 设置中心 =================
// [id, 名字, 图标]：左栏一眼扫过去靠图标认，名字收短，别一列密密麻麻的字
const SETTING_CATS = [
  ["models", "模型", "brain"],
  ["search", "联网搜索", "search"],
  ["agent", "智能体", "bot"],
  ["security", "安全", "shield"],
  ["shortcuts", "快捷键", "keyboard"],
  ["persona", "个性化", "drama"],
  ["look", "外观", "palette"],
  ["memory", "记忆", "notebook-pen"],
  ["evolve", "自进化", "sprout"],
  ["trace", "执行追踪", "activity"],
  ["ops", "运行状况", "bar-chart"],
  ["data", "数据", "database"],
  ["im", "助理设置", "smartphone"],
  ["about", "关于", "info"],
];
/**
 * 这六页从头到尾都是服务器级的：联网搜索的 Key、自进化规则、执行追踪、运行状况的日志与告警、备份/工作目录、飞书企微钉钉接入。
 * 多人服务器上的普通成员每一颗按钮都会 403，连一行属于他自己的东西都没有——那就别画这个标签页。
 * （models / persona / security 是混的：里面有他自己的东西，标签留着，卡片各自按 platform_owner 挑。）
 */
const PLATFORM_ONLY_CATS = new Set(["search", "evolve", "trace", "ops", "data", "im"]);
async function renderSettings(active) {
  const s = await fetch("/api/settings").then(r => r.json());
  const cats = s.platform_owner ? SETTING_CATS : SETTING_CATS.filter(([k]) => !PLATFORM_ONLY_CATS.has(k));
  // 从别处跳进一个已经不画的标签页（旧的深链、上次停在「数据」页），别留一屏空白：退回模型页
  if (!cats.some(([k]) => k === active)) active = cats[0][0];
  mBody.innerHTML = `<div class="settings-layout">
    <div class="settings-nav">${cats.map(([k, label, icon]) =>
      `<div class="cat ${k === active ? "active" : ""}" data-cat="${k}"><span class="ci">${ic(icon)}</span>${label}</div>`).join("")}</div>
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
  else if (active === "trace") renderTracePane(pane, s);
  else if (active === "ops") renderOpsPane(pane);
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
  if (msgEl) {
    msgEl.textContent = resp.ok ? "✓ 已保存并生效" : lastSaveError;
    // msgEl 多半是那个 class="ok-msg" 的小 span——绿色、13px、挂在一整屏表单的最底下。
    // 失败时把同一句话塞进去，用户看到的是一行绿色小字，跟「已保存」长得一模一样，
    // 而它上面还压着五张折叠卡。
    // 其实每次都报了错，只是那个错穿着成功的衣服藏在屏幕外面。
    msgEl.classList.toggle("bad", !resp.ok);
  }
  // 兜底再喊一嗓子：msgEl 可能根本不在视野里，也可能压根没传。保存失败是必须看见的事。
  if (!resp.ok && typeof toast === "function") toast(lastSaveError, "circle-x");
  // 等缓存真刷回来再放行：saveAllModelTables 存完立刻拿 settingsCache 重画，不等的话画的还是旧表——
  // 删掉的渠道会在屏幕上再站一轮，用户以为「删除不成功」
  if (resp.ok) await refreshSettingsCache();
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
    hint: "生成一段通常要 1~5 分钟。五家协议各说各的话，按渠道认：通义万相（dashscope）、火山方舟 Seedance（ark / volces）、智谱 CogVideoX（bigmodel）、MiniMax 海螺（minimax）、硅基流动（siliconflow）。走中转或自建网关时地址里看不出上游，把渠道的「渠道类型」选成实际那一家即可。" },
  { cap: "tts", icon: "mic", title: "配音", tool: "text_to_speech",
    hint: "把文字念成音频，视频配音、播客旁白用它。支持 OpenAI 兼容 /audio/speech；地址含 dashscope 时自动走通义 qwen-tts 原生协议。" },
  { cap: "asr", icon: "file-audio", title: "转写", tool: "transcribe_audio",
    hint: "把会议录音、采访、口播素材里的话转成文字，需要字幕还能出一份 .srt。走 OpenAI 兼容 /audio/transcriptions，单个文件 25MB 以内（一小时的会议先用 ffmpeg 压成 16k 单声道再传）。通义百炼的转写是异步任务接口，还没接，别配在这一路。" },
];
let mediaCatalog = null; // 精选目录，一次会话拉一次
const liveModels = new Map(); // 渠道 id → 那边 /models 现拉回来的清单
/** 展开着的渠道 id。重画时保留——存完一个模型整张卡自己合上，比不合上更烦人 */
const openChans = new Set();
/** 展开着的那几路能力。四张卡默认全收着：大多数人只配一两路，四段说明一起摊开正是上一版「字太多」的来源 */
const openCaps = new Set();
let chanFirstPaint = true;
/** 「还没配 Key 的渠道」那一栏是不是展开着。默认收起——十来家服务商摊开是一堵墙 */
let idleOpen = false;
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

/**
 * 有「添加模型」那张表单正开着吗？开着就别重画。
 *
 * 精选目录是现拉的，拉回来会把这一屏再画一遍。人点了「添加看图模型」、正在下拉里翻型号，
 * 目录恰好这时到了——整张卡重画，表单连同刚选好的那一行一起没了，按钮看着还在，
 * 点下去又是空的。
 * 重画本来就是为了「把目录补上」这点好处，不值得拿人填了一半的东西去换。
 */
function mediaFormOpen(root) {
  return !!root && [...root.querySelectorAll(".mm-form")].some((f) => f.style.display !== "none");
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
  loadMediaCatalog().then(() => { if (box.isConnected && !mediaFormOpen(box)) paintMedia(box, s); });
  paintMedia(box, s);
}

/**
 * 被熔断闸停掉的渠道，在这一页顶上摊开说。
 *
 * 熔断在后台默默生效就行，但「为什么它突然不给我看图了」必须有地方能看见，
 * 否则用户只会觉得功能坏了——真相是我们替他拦下了一条撞不通的路。
 */
function paintMediaPaused(box) {
  const bar = box.querySelector("#media-paused");
  if (!bar) return;
  fetch("/api/media-health").then((r) => r.json()).then((d) => {
    const list = (d && d.paused) || [];
    if (!list.length) { bar.innerHTML = ""; return; }
    bar.innerHTML = `<div class="warn-box">${ic("triangle-alert")}<div><b>这些渠道已暂停，不再往上撞</b>
      <div style="margin-top:4px">${list.map((p) => `${esc((MEDIA_CAPS.find((c) => c.cap === p.cap) || {}).title || p.cap)}：${esc(p.model || "")} — ${esc(p.why)}`).join("<br>")}</div>
      <div style="margin-top:6px;color:var(--owb-text-3)">改完下面的配置按保存即刻恢复；也可以现在就</div></div>
      <button class="mini" id="media-unpause">再试一次</button></div>`;
    const btn = bar.querySelector("#media-unpause");
    if (btn) btn.onclick = async () => {
      await fetch("/api/media-health/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      paintMediaPaused(box);
      toast("✓ 已恢复，下一次调用会真的发出去");
    };
  }).catch(() => {});
}

/**
 * 同名渠道编号：id → 「第 N 个」，不重名的不给号。
 *
 * 一家开两个号（两把 Key、两份额度）确实是两个渠道，可它们的名字一字不差。
 * 于是「渠道」那一页并排两张「OpenRouter」，多媒体和对话的下拉里也是两个「OpenRouter」——
 * 选完存下去，回头根本认不出用的是哪一把 Key，只能一个个点开比对。
 * 只编在显示上：配置里存的仍是用户自己起的名字，改了名编号自己就没了。
 * 全站共用这一个：两页各编各的话，这儿的「第 2 个」到那儿成了「第 1 个」，比不编还糟。
 */
function provDupeTags(providers) {
  const seen = new Map();
  (providers || []).forEach((p) => seen.set(p.name, (seen.get(p.name) || 0) + 1));
  const rank = new Map(), tags = new Map();
  (providers || []).forEach((p) => {
    if ((seen.get(p.name) || 0) < 2) return;
    const n = (rank.get(p.name) || 0) + 1;
    rank.set(p.name, n);
    tags.set(p.id, `第 ${n} 个`);
  });
  return tags;
}
/** 渠道名 + 编号（不重名就只有名字）。给一行里显示出处的地方用 */
function provLabel(p, dupe) {
  if (!p) return "";
  return p.name + (dupe && dupe.get(p.id) ? `（${dupe.get(p.id)}）` : "");
}
/** 渠道下拉的 <option>。编号要按**所有**渠道算（all），不能只按筛剩下的这几个——
 *  那样算出来的号跟渠道页对不上，反而更容易认错 */
function provOptions(usable, all) {
  const dupe = provDupeTags(all);
  return usable.length
    ? usable.map((p) => `<option value="${esc(p.id)}">${esc(provLabel(p, dupe))}</option>`).join("")
    : `<option value="">（先加一个渠道）</option>`;
}

function paintMedia(box, s) {
  // 标题归上一层（paintModels 的「按能力配置」那一条）：对话和这五路现在是并排的六张卡，
  // 中间再插一行小标题，读起来就成了「对话是一类、别的是另一类」——可它们是同一类事
  // 同名渠道要分得开，否则这一列写着「OpenRouter」，而机器上有两个 OpenRouter
  const dupe = provDupeTags(s.providers);
  const provName = (id) => {
    const p = s.providers.find((x) => x.id === id);
    return p ? provLabel(p, dupe) : "（渠道已删）";
  };
  box.innerHTML = `
    <div id="media-paused"></div>
    ${MEDIA_CAPS.map((c) => capCard(c, s, provName)).join("")}
    <span class="ok-msg" id="media-msg"></span>`;
  bindMedia(box, s);
  paintMediaPaused(box);
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
  // 一路挂几个模型、这几个又散在几个渠道上——这两个数才是「我这一路配全了没有」的答案。
  // 老的摘要只说「2 个 · 默认 X」，同一家挂两个和两家各挂一个长得一模一样，可后者才是真有备份
  const chans = new Set(mine.map((m) => m.provider));
  const sum = mine.length
    ? `${mine.length} 个模型${chans.size > 1 ? ` · 跨 ${chans.size} 个渠道` : ""} · 主用 ${esc(def.name || def.model || "")}`
    : "还没配";
  return `
    <div class="ch-card${open ? " open" : ""}">
      <div class="ch-head" data-cap="${c.cap}">
        ${ic(open ? "chevron-down" : "chevron-right", "ch-caret i-sm")}
        <span class="cap-ic">${ic(c.icon)}</span>
        <span class="ch-title"><b>${esc(c.title)}</b><span class="ch-sub">${esc(c.tool)}</span></span>
        <span class="ch-count${mine.length ? "" : " is-empty"}">${sum}</span>
      </div>
      ${!open ? "" : `<div class="ch-body">
        <div class="ch-note">${esc(c.hint)}</div>
        ${mine.length ? mine.map((m) => {
          const i = s.media_models.indexOf(m);
          const meta = [m.default ? "主用" : "备用", provName(m.provider), m.voice ? `音色 ${m.voice}` : ""].filter(Boolean).map(esc).join(" · ");
          const bad = mmMismatch((s.providers.find((x) => x.id === m.provider) || {}).kind, m.model);
          return `
          ${bad ? `<div class="ch-note mrow-bad">${ic("triangle-alert")}「${esc(m.model)}」是${esc(kindLabel(bad))}家的型号，挂在这条渠道上调不通（会报「型号不存在」）。加一条${esc(kindLabel(bad))}渠道，或者把这条删了换一个。</div>` : ""}
          <div class="mrow${m.default ? " is-on" : ""}">
            <input type="radio" name="def-${c.cap}" ${m.default ? "checked" : ""} data-def="${i}" title="设为这一路的主用模型">
            <span class="mrow-name">${esc(m.name)}</span>
            <span class="mrow-id">${esc(m.model)}</span>
            <span class="mrow-meta">${meta}</span>
            ${modelTestBtn("media", m)}
            ${rowMenu([["mdel", i, "删除", "danger"]])}
          </div>
          ${modelTestNote("media", m)}`;
        }).join("") : `<div class="ch-note">还没配。加一个之后 agent 才用得了 ${esc(c.tool)}。</div>`}
        ${mine.length > 1 ? `<div class="ch-note">挂了多个：平时走「主用」那条；要指定别的，在对话里点名它的名字（例如「用${esc((mine.find((m) => !m.default) || mine[0]).name)}画」），agent 会按名字挑。</div>` : ""}
        <div class="mm-form" data-cap="${c.cap}" style="display:none;border-top:1px solid var(--owb-border);padding-top:8px;margin-top:6px">
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
        <button class="btn-plain mm-new" data-cap="${c.cap}" style="margin-top:6px">${ic("plus")}添加${esc(c.title)}模型</button>
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
  bindModelTests(box, s, () => repaintMedia(box, s));

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
      // 手填进来的型号也过一遍门第：能挪就当场挪到对的那条渠道（比存下去再报错强），
      // 本机没有那家渠道就拦住——这时候只有用户自己知道去哪儿开号，替他瞎猜只会换一种方式失败。
      let use = prov;
      const want = mmMismatch((s.providers.find((x) => x.id === prov) || {}).kind, model);
      if (want) {
        const alt = s.providers.filter((x) => x.kind === want);
        const fix = alt.find((x) => String(x.api_key || "").trim()) || alt[0];
        if (!fix) return toast(`「${model}」是${kindLabel(want)}家的型号，这条渠道上没有它。先去上面加一条${kindLabel(want)}渠道，或者换一个这条渠道有的型号`);
        use = fix.id;
        toast(`「${model}」是${kindLabel(want)}家的型号，已经帮你挂到「${fix.name}」那条渠道上`);
      }
      s.media_models.push({ id: "", cap, name, provider: use, model, voice, default: !s.media_models.some((m) => m.cap === cap) });
      if (await saveMediaTables(s, msg)) repaintMedia(box, s);
    };
  });
}

/* ───────── 型号是哪家的：跟服务端 media-models.js 的 brandOf / mismatch 同一套规矩 ─────────
 * 为什么前端也要有一份：用户在下拉框里选的那一刻就该知道挂错了，而不是存完、跑起来、
 * 等看图那一步报一句 400 才发现。服务端那份是兜底（老配置、手改的 config.json 都走它），
 * 这份是**当场**——两边的判断必须一致，所以规则表是服务端下发的（brand_hints），不在这儿写死。
 *
 * 真实事故：下拉框把火山的 doubao-seed-1-6-250615 摆在了 OpenRouter 渠道下面，
 * 用户选了它，配置就成了「拿 OpenRouter 的地址去调豆包」，每次看图都报「不是有效的模型 ID」。
 */
function mmRelay(kind) {
  return !!((mediaCatalog || {}).kinds || []).find((k) => k.kind === kind && k.relay);
}
/** 跑在这台机器上的服务（Ollama / 自建本地网关）。它和云端渠道有两处不一样：不用 Key，
 *  以及「一个模型都没有」的含义完全不同——云端多半是没这个接口，本机是真的还没 pull 过东西 */
function mmLocalProv(p) {
  return !!p && (p.kind === "ollama" || /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(String(p.base_url || "")));
}
/** 问完渠道、一个模型都没拿到时说什么。
 *  以前这儿是一句空字符串：上一秒还写着「正在问渠道有哪些模型…」，下一秒那行字直接没了，
 *  问出什么结果一个字都不说。对本机 Ollama 尤其要命——他要做的事（ollama pull）没人告诉他 */
function mmEmptyTip(d, local) {
  if (d && d.why) return `这个渠道没给模型列表（${d.why}），上面的精选和「自己填…」照用。`;
  return local
    ? "连上了，但这台机器上一个模型都还没装。终端里跑 ollama pull qwen3:8b 拉一个（约 5GB），回来重新点开这个下拉框会再问一次。"
    : "这个渠道没回模型列表（不少国产渠道没有这个接口），上面的精选和「自己填…」照用。";
}
/** 连问都没问出去（服务端没起来 / 网断了 / 这一版的接口不在）。
 *  它跟「问到了但是空的」是两回事，但结局以前一模一样：那行字直接抹掉，什么都不说 */
const MM_FAIL_TIP = "没能问到这个渠道（请求没发出去），先用上面的精选或者「自己填…」，稍后重开这个下拉框会再问一次。";
function mmBrand(id) {
  const v = String(id || "").trim();
  if (!v || v.includes(":")) return "";
  const cat = (mediaCatalog || {}).catalog || {};
  const kinds = new Set();
  for (const cap of Object.keys(cat)) for (const m of cat[cap]) if (String(m.id).toLowerCase() === v.toLowerCase()) kinds.add(m.kind);
  if (kinds.size === 1) return [...kinds][0];
  if (kinds.size > 1 || v.includes("/")) return "";
  for (const [src, kind] of ((mediaCatalog || {}).brand_hints || [])) if (new RegExp(src, "i").test(v)) return kind;
  return "";
}
function mmMismatch(kind, id) {
  const k = String(kind || "").trim();
  if (!k || k === "ollama" || mmRelay(k)) return "";
  const b = mmBrand(id);
  return b && b !== k ? b : "";
}
function kindLabel(kind) {
  const k = ((mediaCatalog || {}).kinds || []).find((x) => x.kind === kind);
  return (k && k.label) || kind || "（未知渠道）";
}

function fillProvSelect(f, s) {
  const sel = f.querySelector(".mm-prov");
  // Anthropic / DeepSeek / Kimi 只做对话，没有画图配音接口。列出来只会让人选完发现跑不通
  // decide_only（Jev）一并挡掉：它连文字都不产，更不可能画图配音
  const chatOnly = new Set(((mediaCatalog || {}).kinds || []).filter((k) => k.chat_only || k.decide_only).map((k) => k.kind));
  const usable = s.providers.filter((p) => !chatOnly.has(p.kind));
  sel.innerHTML = provOptions(usable, s.providers);
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
  // 别家的型号只在**中转网关**下面摆（new-api / 自建兼容接口：后面接谁只有用户知道，
  // 而且它们正是按型号名往上游路由的）。直连的渠道一概不摆——以前这一组的标题写着
  // 「地址对得上也能用」，地址根本对不上：火山的 doubao-… 在 OpenRouter 上是个不存在的 id，
  // 选中即坏。
  // 真要跨家挂（自建网关做了转发），「自己填…」那条路一直都在。
  const others = p && mmRelay(p.kind) ? cat.filter((m) => m.kind !== p.kind) : [];
  const opt = (m) => `<option value="${esc(m.id)}">${esc(m.label)}（${esc(m.id)}）</option>`;
  sel.innerHTML =
    (mine.length ? `<optgroup label="这个渠道的精选">${mine.map(opt).join("")}</optgroup>` : "") +
    `<option value="__custom__">自己填…</option>` +
    (others.length ? `<optgroup label="别家的型号（这是中转网关，转发到上游就能用）">${others.map(opt).join("")}</optgroup>` : "");
  f.querySelector(".mm-custom").style.display = sel.value === "__custom__" ? "" : "none";
  tip.textContent = mine.length ? "" : "这个渠道没有精选条目，下面直接填模型名，或等一下从渠道拉回来的列表。";
  if (!p) return;
  const live = liveModels.get(p.id);
  if (live) return injectLive(sel, tip, live, cap, mmLocalProv(p));
  tip.textContent = "正在问渠道有哪些模型…";
  fetch("/api/provider-models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: p.id }) })
    .then((r) => r.json())
    // 空清单不记进缓存。跟服务端那道缓存同一个道理：他照着提示去 ollama pull 完回来，
    // 重新点开下拉框得真去问一次，否则提示教他做的事做完了，界面上什么都不变
    .then((d) => { if (d && d.ok && (d.models || []).length) liveModels.set(p.id, d); if (sel.isConnected) injectLive(sel, tip, d, cap, mmLocalProv(p)); })
    .catch(() => { tip.textContent = MM_FAIL_TIP; });
}

function injectLive(sel, tip, d, cap, local) {
  if (!d.ok || !d.models || !d.models.length) {
    // 拉不到不是错：很多国产渠道压根没有 /models。目录和手填两条路都还在
    tip.textContent = mmEmptyTip(d, local);
    return;
  }
  const title = (c) => (MEDIA_CAPS.find((x) => x.cap === c) || {}).title || "";
  const same = d.models.filter((m) => m.cap === cap);
  const rest = d.models.filter((m) => m.cap !== cap);
  // 别的那一堆里，渠道自己说死了是干什么的（sure），就把用途写在名字后面。
  // 它们一直在这个
  // 下拉里排着队，跟能用的长得一模一样，选中了才在跑的时候炸。标出来，选之前就看得见
  const why = (m) => (!m.sure ? "" : m.cap ? `（${title(m.cap)}的）` : "（只认文字，看不了图）");
  const group = (label, list) => (list.length
    ? `<optgroup label="${label}">${list.map((m) => `<option value="${esc(m.id)}">${esc(m.id + why(m))}</option>`).join("")}</optgroup>`
    : "");
  // 渠道自己标的排前面，按名字猜的排后面：一组里两种成色混着，人没法判断该信哪条
  const sure = same.filter((m) => m.sure), maybe = same.filter((m) => !m.sure);
  const keep = sel.value;
  sel.insertAdjacentHTML("beforeend",
    group(`这个渠道能${title(cap)}的（渠道自己标的）`, sure)
    + group(`看着像${title(cap)}的（按名字猜的，不一定准）`, maybe)
    + group("这个渠道的其它模型", rest));
  if (keep) sel.value = keep;
  const n = sure.length ? `，其中 ${sure.length} 个是渠道自己标明能${title(cap)}的` : "";
  tip.textContent = `从渠道拉到 ${d.models.length} 个模型${d.cached ? "（缓存）" : ""}${n}，挑不到就选「自己填…」。`;
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
    // 头一次打开只展开「对话」那张卡：人来这一页十有八九是为了换对话模型，而那张卡
    // 横着列了所有渠道下的所有对话模型——以前是展开「当前默认模型所在的那个渠道」，
    // 可默认模型的同伴们散在别的渠道里，还是得一张张点开找。
    // 别的五路和所有渠道卡都收着：全展开就是回到老界面那堵墙。
    chanFirstPaint = false;
    openCaps.add("chat");
  }
  loadMediaCatalog().then(() => { if (pane.isConnected && !mediaFormOpen(pane)) paintModels(pane, s); });
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
  // 同一家开两个号（两把 Key）确实是两个渠道，但卡片一字不差，人只会读成「怎么有两个 OpenRouter」
  const provTags = provDupeTags(s.providers);
  const dupeTag = (p) => provTags.get(p.id) || "";
  // 配了 Key 的排前面、没配的收进一栏：没设 Key 的渠道不该占着版面。
  // 所以不是删掉，是收起来，点一下还在。
  const ready = s.providers.filter((p) => !chanIdle(p));
  const idle = s.providers.filter((p) => chanIdle(p));
  const idleShown = idleOpen || !ready.length; // 一个能用的都没有时直接摊开，否则新用户会以为这儿是空的
  const active = s.models.find((model) => model.name === s.active_model);

  /* ── 顶上那六格：这台机器「现在到底在用谁」 ──────────────────────────────
   * 老版本只有五格、纯展示，而且每格只写得下一个名字——
   * 一格里只写主用那个，就永远看不出「这一路到底有没有备份」。
   * 所以每格现在是三行：主用是谁、它的模型 id、以及还压着几个备选、散在几个渠道上。
   * 而且格子是能点的——点哪一路就展开哪一路的配置卡，不用自己在下面一张张找。
   */
  const capTile = (key, icon, title, hint, main, sub, n, chans, empty) => {
    const has = !!main;
    const spare = n > 1 ? `+${n - 1} 备选${chans > 1 ? ` · ${chans} 个渠道` : ""}` : has ? "只有这一个" : "";
    return `<button type="button" class="rt${key === "chat" ? " is-primary" : ""}${has ? "" : " is-empty"}" data-goto="${key}" title="${esc(hint)}">
      <span class="rt-k">${ic(icon)}${esc(title)}</span>
      <b>${esc(has ? main : empty)}</b>
      <small>${esc(has ? sub : hint)}</small>
      <i>${esc(spare)}</i>
    </button>`;
  };
  const chatChans = new Set(s.models.filter((m) => m.channel).map((m) => m.channel));
  const tiles = [capTile("chat", "message-circle", "对话", "正文、工具调用、写文件都走它",
    active ? active.name : s.active_model || "", active ? active.model : "全局默认",
    s.models.length, chatChans.size, "未设置")]
    .concat(MEDIA_CAPS.map((c) => {
      const mine = s.media_models.filter((m) => m.cap === c.cap);
      const def = mine.find((m) => m.default) || mine[0];
      const chans = new Set(mine.map((m) => m.provider)).size;
      // 看图是唯一一路「不配也能用」的：没配就拿当前对话模型去看。这跟「没配就用不了」
      // 是两件事，格子里必须分开说，不然纯文本主模型的人会以为看图已经能用了
      return capTile(c.cap, c.icon, c.title, c.tool, def ? def.name : "", def ? def.model : "",
        mine.length, chans, c.cap === "vision" ? "跟随对话模型" : "未设置");
    }));

  // 主模型自称不会调工具 = 这台机器跑不了任务。这种配置错误以前要等第一个任务炸了才知道
  const noTools = active && Array.isArray(active.caps) && !active.caps.includes("tools");
  // 看图这一路没单配，又明说了主模型不会看图：粘张图进来必然报错，提前讲比事后报错强
  const blindVision = !s.media_models.some((m) => m.cap === "vision")
    && active && Array.isArray(active.caps) && !active.caps.includes("vision");
  const warns = [
    noTools ? `主模型「${active.name}」标了不会调用工具，任务跑起来会卡在第一步。换一个，或者去它那行的 ⋯ → 编辑 把「能调工具」勾回来。` : "",
    blindVision ? `「看图」这一路没单配模型，会拿主模型「${active.name}」去看，而它标了不会看图。往「看图」里加一个能看图的模型。` : "",
  ].filter(Boolean);

  pane.innerHTML = `
    <div class="model-route-head">
      <div><b>现在在用谁</b><span>对话、看图、画图、视频、配音、转写分开走，互不串用。点一格就跳到那一路的配置</span></div>
      <span>${ready.length} 个渠道可用</span>
    </div>
    <div class="model-route-grid">${tiles.join("")}</div>
    ${warns.map((w) => `<div class="model-route-warn">${ic("triangle-alert")}<span>${esc(w)}</span></div>`).join("")}
    <div class="model-route-note">${po
      ? "先在下面「渠道与 Key」里填好一家的 Key，再回到「按能力配置」把模型挂到用得上的那一路。一个渠道的 Key 只填一次，六路共用；画布节点仍可临时指定具体的图片或视频模型。"
      : "这是服务器当前生效的模型路由。你可在输入框临时切换对话模型，其余几路由平台管理员统一维护。"}</div>

    <div class="hub-sec-title" style="margin:20px 0 8px">${ic("sliders-horizontal")}按能力配置 <span class="sub">一路可以挂多个渠道的多个模型：平时走「主用」，在对话里点名就能临时换别的</span></div>
    <div id="chat-overview">${chatOverview(s, po, kindLabel)}</div>
    <div id="media-pane"></div>

    <div class="hub-sec-title" style="margin:22px 0 8px">${ic("plug")}渠道与 Key <span class="sub">一家服务商一条，Key 只填在这儿；上面各路的模型都只引用渠道，不抄 Key</span>
      ${po ? `<button type="button" class="btn-plain mm-sec-act" id="pf-new">${ic("plus")}添加渠道</button>` : ""}</div>
    ${!po ? "" : `
    <div id="prov-form" style="display:none">
      <select id="pf-kind">${kinds.map((k) => `<option value="${esc(k.kind)}">${esc(k.label)}</option>`).join("")}</select>
      <select id="pf-proto">
        <option value="">接口协议：按渠道类型（默认）</option>
        <option value="openai">接口协议：OpenAI 兼容（/chat/completions）</option>
        <option value="anthropic">接口协议：Anthropic（/v1/messages）</option>
      </select>
      <input id="pf-name" placeholder="给它起个名（如：我的火山方舟）">
      <input id="pf-base" placeholder="接口地址（选了类型会自动填）">
      <div class="d" id="pf-base-tip" style="font-size:12px;margin:-2px 0 8px"></div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <input id="pf-key" type="password" placeholder="API Key" autocomplete="off" style="flex:1;min-width:0;margin:0">
        <span id="pf-key-src"></span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <button type="button" class="btn-plain" id="pf-models">问一下它有哪些模型</button>
        <span class="d" id="pf-models-tip" style="font-size:12px;margin:0"></span>
      </div>
      <button class="btn-brand" id="pf-save">保存渠道</button>
      <button class="btn-plain" id="pf-cancel">取消</button>
    </div>`}
    <div id="prov-list">${ready.map((p) => chanCard(p, s, po, kindLabel, dupeTag(p))).join("")
      || `<div class="d" style="padding:8px 0">还没有能用的渠道。${po ? "在下面挑一家填上 Key，或者自己加一个。" : "等平台管理员配好 Key。"}</div>`}</div>
    ${!idle.length ? "" : `
    <div class="idle-sec${idleShown ? " open" : ""}">
      <button type="button" class="idle-head" id="idle-toggle">
        ${ic(idleShown ? "chevron-down" : "chevron-right", "ch-caret")}
        <span>还没填 Key 的渠道</span><span class="ch-count">${idle.length} 家</span>
      </button>
      ${!idleShown ? "" : `<div class="idle-body">${idle.map((p) => chanCard(p, s, po, kindLabel, dupeTag(p))).join("")}</div>`}
    </div>`}
    ${!loose.length ? "" : `
    <div class="ch-card open">
      <div class="ch-head" style="cursor:default">
        <span class="ch-title"><b>没挂渠道的</b><span class="ch-sub">地址和 Key 都还空着</span></span>
        <span class="ch-count">${loose.length} 个</span>
      </div>
      <div class="ch-body">${loose.map((m) => modelRow(m, s, po)).join("")}</div>
    </div>`}
    <label style="display:flex;align-items:center;gap:8px;margin-top:14px;font-size: 13px;color:var(--owb-text-2);cursor:pointer">
      <input type="checkbox" id="mf-follow-last" style="margin:0" ${s.model_follow_last ? "checked" : ""}>
      新对话自动沿用上次手动选过的模型（不勾则新对话总是用全局默认）
    </label>
    <span class="ok-msg" id="models-msg"></span>`;
  renderMediaPane(pane.querySelector("#media-pane"), s);
  bindModels(pane, s, po);
}

/**
 * 「对话」那张卡：跟下面五路媒体长一个样，只是数据来自 config.models。
 *
 * 为什么要单开一张：对话模型平时是散在各个渠道卡里的，想知道「我一共有几个对话模型、
 * 现在默认是哪个、备用挂的谁」，得把每张渠道卡都点开数一遍。可这正是用户最常问的一件事。
 * 这张卡把它们横着摊在一起，按渠道标出处；「主渠道挂了换谁」也挪到这儿——
 * 它本来在「智能体设置」里，跟步数上限、超时排在一起，选的却是模型，找不着是应该的。
 */
function chatOverview(s, po, kindLabel) {
  const open = openCaps.has("chat");
  const active = s.models.find((m) => m.name === s.active_model);
  const chans = new Set(s.models.filter((m) => m.channel).map((m) => m.channel));
  const sum = s.models.length
    ? `${s.models.length} 个模型${chans.size > 1 ? ` · 跨 ${chans.size} 个渠道` : ""} · 主用 ${esc(active ? active.name : s.active_model || "未设置")}`
    : "还没配";
  const fb = String((s.agent || {}).failover_model || "");
  return `
    <div class="ch-card${open ? " open" : ""}">
      <div class="ch-head" data-chatcap="1">
        ${ic(open ? "chevron-down" : "chevron-right", "ch-caret i-sm")}
        <span class="cap-ic">${ic("message-circle")}</span>
        <span class="ch-title"><b>对话</b><span class="ch-sub">正文 · 工具调用 · 写文件</span></span>
        <span class="ch-count${s.models.length ? "" : " is-empty"}">${sum}</span>
      </div>
      ${!open ? "" : `<div class="ch-body">
        <div class="ch-note">整台服务器的默认对话模型。每个人还能在输入框右下角临时换一个，那是各人自己的偏好，不影响这里。</div>
        ${s.models.length ? s.models.map((m) => modelRow(m, s, po, true)).join("")
          : `<div class="ch-note">一个都还没有。去下面的渠道卡里加一个，或者点这儿的「添加对话模型」。</div>`}
        ${!po ? "" : `
        <div class="ch-fb">
          <label for="ov-failover">主模型挂了换谁</label>
          <select id="ov-failover">
            <option value="">不换道（默认）</option>
            ${s.models.map((m) => `<option value="${esc(m.name)}"${fb === m.name ? " selected" : ""}>${esc(m.name)}（${esc(m.model)}）${modelKeyed(m, s) ? "" : "（这条还没 Key）"}</option>`).join("")}
          </select>
          <span>主模型连续卡壳或持续报错时，自动切到这条接着跑当前任务，并在任务流里醒目播报。不选就绝不悄悄换模型，宁可如实报错；每个任务最多换一次道。</span>
        </div>`}
        ${!po ? "" : `
        <div class="ca-form" data-chan="__all__" style="display:none">
          <div class="form-row">
            <select class="ca-chan"></select>
            <select class="ca-model"></select>
          </div>
          <div class="form-row">
            <input class="ca-custom" placeholder="模型名（上面选「自己填…」时用这个）" style="display:none">
            <input class="ca-name" placeholder="别名（可空，默认用模型名；对话里按这个名字认）">
          </div>
          ${capsRow()}
          <div class="d ca-tip" style="font-size:12px;margin-bottom:6px"></div>
          <button class="btn-brand ca-save">保存</button>
          <button class="btn-plain ca-cancel">取消</button>
        </div>
        <button class="btn-plain ca-new" data-chan="__all__" style="margin-top:6px">${ic("plus")}添加对话模型</button>`}
      </div>`}
    </div>`;
}

/**
 * 自定义模型那一行「它会什么」。
 *
 * 自己填模型名的人最常踩的两个坑：挑了个纯文本模型当主力，粘图进去才发现看不了；
 * 或者挑了个不支持 function calling 的模型，任务卡在第一步谁也不知道为什么。
 * 目录里的模型我们知道它会什么，手填的不知道——所以让填的人自己说一句。
 * 不勾也不猜：caps 没有这个字段就是「不知道」，界面一个字都不提示（老配置全是这种）。
 */
function capsRow(caps) {
  const has = (k) => !Array.isArray(caps) || caps.includes(k); // 新建时两项默认都勾上：绝大多数对话模型都会
  return `<div class="ca-caps">
      <span>它会什么</span>
      <label><input type="checkbox" class="ca-cap-tools" ${has("tools") ? "checked" : ""}>能调工具</label>
      <label><input type="checkbox" class="ca-cap-vision" ${has("vision") ? "checked" : ""}>能看图</label>
      <em>照着服务商文档勾。勾错了只影响这儿的提醒，不改真实请求</em>
    </div>`;
}

/**
 * 这个渠道现在能不能用。
 * Ollama 这类本机服务不要 Key，填不填都能用，不该被归进「还没填 Key」里等着人去填。
 */
function chanIdle(p) {
  if (mmLocalProv(p)) return false;
  // has_key 是读接口给非管理员回的（真 Key 被打了掩码），管理员那边看 api_key 本身
  return p.has_key === false || !String(p.api_key || "").trim();
}

/**
 * 这个模型现在有没有 Key 可用。
 *
 * 不能只看 m.api_key：改成「渠道持 Key、模型只引用渠道」之后，挂了渠道的模型自己那一栏
 * 本来就是空的（server.js 的 normalize 是在发请求前才把渠道的 base_url/api_key 摊回行上的）。
 * 光看行上那一栏，会把一屏配得好好的模型全标成「还没配 Key」。
 */
function modelKeyed(m, s) {
  if (String(m.api_key || "").trim() || m.has_key) return true;
  if (!m.channel) return /ollama|本地|本机/i.test(String(m.name || "") + String(m.base_url || ""));
  const p = (s.providers || []).find((x) => x.id === m.channel);
  return !!p && !chanIdle(p);
}

/**
 * 渠道测活结果：id → { running | ok, ms, model, error }。
 *
 * 存在模块里而不是 DOM 里：这一页任何一处改动都会整屏重画（换默认模型、加一个媒体模型都会），
 * 结果挂在 DOM 上的话，刚测出来的绿勾下一秒就被重画抹掉，人会以为没测成功。
 */
const chanTest = new Map();

/** 头上那颗状态点：卡片折起来的时候，这是唯一能看出「这家到底通不通」的地方 */
function chanTestPill(p) {
  const t = chanTest.get(p.id);
  if (!t) return "";
  if (t.running) return `<span class="ch-pill is-run">测活中…</span>`;
  return t.ok
    ? `<span class="ch-pill is-ok" title="拿模型 ${esc(t.model)} 真发了一次请求">${ic("circle-check", "i-sm")}通 · ${t.ms} 毫秒</span>`
    : `<span class="ch-pill is-bad" title="${esc(t.error)}">${ic("circle-x", "i-sm")}不通</span>`;
}

/** 展开后那一行结论。失败的原因必须整句写出来——「不通」三个字没法让人知道下一步做什么 */
function chanTestNote(p) {
  const t = chanTest.get(p.id);
  if (!t || t.running) return "";
  return t.ok
    ? `<div class="ch-res is-ok">${ic("circle-check")}<span>通了（${t.ms} 毫秒）。刚才拿 <code>${esc(t.model)}</code> 真发了一次请求，Key、地址、模型名三样都对。</span></div>`
    : `<div class="ch-res is-bad">${ic("triangle-alert")}<span>${esc(t.error)}</span></div>`;
}

/**
 * 一行一测的结果。跟 chanTest 一样存在模块里，不存 DOM——这一页任何改动都整屏重画。
 *
 * key 用名字不用下标：下标一删行就全串位，绿勾会跑到隔壁那一行头上去，
 * 而「隔壁那行也通」恰恰是最难看出错的一种错。
 */
const modelTest = new Map();
const mtKey = (scope, m) => scope + ":" + (scope === "media" ? m.id || m.name : m.name);

/**
 * 行尾那颗结论。渠道测活那句话说的是「这条线通不通」，这句说的是「**这一行**能不能用」——
 * 一条渠道下面挂五个模型，线是通的，模型名却可能错了三个，得等任务跑到一半才炸。
 */
function modelTestNote(scope, m) {
  const t = modelTest.get(mtKey(scope, m));
  if (!t) return "";
  if (t.running) return `<div class="ch-res mrow-res"><span>正在测「${esc(m.model || m.name)}」…</span></div>`;
  if (!t.ok) return `<div class="ch-res is-bad mrow-res">${ic("triangle-alert")}<span>${esc(t.error)}</span></div>`;
  // 只验到一半的时候不给绿勾：拿模型清单证不了余额够不够。
  // 一个含糊的 ✓ 比一个红叉更坑人——人会拿它当「已经能用」，然后在真任务里踩空
  const half = t.partial || /没真生成|没法核对/.test(t.note || "");
  return `<div class="ch-res ${half ? "is-half" : "is-ok"} mrow-res">${ic(half ? "circle-help" : "circle-check")}<span>${esc(t.note || "通了")}（${t.ms} 毫秒）</span></div>`;
}

/**
 * 行里那颗「测」。带字不带纯图标：这一行右边本来就有个 ⋯，再放一颗光溜溜的图标，
 * 人得挨个悬停才知道哪颗是干什么的——摆出来却认不出，等于没摆。
 */
function modelTestBtn(scope, m) {
  const t = modelTest.get(mtKey(scope, m));
  const run = !!(t && t.running);
  return `<button type="button" class="mrow-test" data-mtscope="${scope}" data-mtkey="${esc(mtKey(scope, m))}"
      title="拿这一行真验一次：Key 认不认、模型名在不在"${run ? " disabled" : ""}>${ic(run ? "loader-circle" : "flask-conical", "i-sm")}${run ? "测中" : "测"}</button>`;
}

/**
 * 把「测」这颗按钮接上。对话卡和那五张能力卡共用一份：两边行长得一样，
 * 差的只是重画哪一块，所以重画函数当参数传进来。
 */
function bindModelTests(root, s, repaint) {
  root.querySelectorAll(".mrow-test").forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation(); // 行在折叠卡里，冒上去会把卡收起来，人就看不见刚测出来的那句话了
    const scope = b.dataset.mtscope;
    const key = b.dataset.mtkey;
    const list = scope === "media" ? s.media_models : s.models;
    const index = list.findIndex((m) => mtKey(scope, m) === key);
    if (index < 0) return;
    modelTest.set(key, { running: true });
    repaint();
    let d;
    try {
      const r = await fetch("/api/model-test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, index }),
      });
      d = await r.json();
    } catch (err) {
      d = { ok: false, error: "请求没发出去：" + String((err && err.message) || err) };
    }
    modelTest.set(key, {
      ok: !!d.ok, ms: d.ms || 0, partial: !!d.partial,
      note: d.note || "", error: d.error || "没说原因",
    });
    repaint();
  }));
}

/** 一个渠道一张卡：头是一行摘要，展开才是它底下的模型 + 那把 Key */
function chanCard(p, s, po, kindLabel, dupeTag) {
  const i = s.providers.indexOf(p);
  const mine = s.models.filter((m) => m.channel === p.id);
  const mediaN = s.media_models.filter((m) => m.provider === p.id).length;
  const open = openChans.has(p.id);
  const noKey = chanIdle(p);
  // 预置渠道的名字本来就是这家的中文名，再把同一句话当副标题印一遍，读起来就是同一个词写了两遍。
  // 副标题只在名字跟类型不是一回事时才出现（自建网关、自己改过名的渠道）
  const label = kindLabel(p.kind);
  const sub = [String(p.name || "").trim() === String(label).trim() ? "" : label, dupeTag || ""].filter(Boolean).join(" · ");
  return `
    <div class="ch-card${open ? " open" : ""}">
      <div class="ch-head" data-chan="${esc(p.id)}">
        ${ic(open ? "chevron-down" : "chevron-right", "ch-caret")}
        <span class="ch-title"><b>${esc(p.name)}</b>${sub ? `<span class="ch-sub">${esc(sub)}</span>` : ""}</span>
        ${po && noKey ? `<button type="button" class="ch-warn" data-fillkey="${esc(p.id)}" title="展开这张卡，直接填 Key">${ic("triangle-alert", "i-sm")}未填 Key</button>` : ""}
        ${chanTestPill(p)}
        <span class="ch-count">${mine.length} 个对话模型${mediaN ? ` · ${mediaN} 个媒体模型` : ""}</span>
        ${!po ? "" : rowMenu([["pedit", i, "编辑渠道", ""], ...(p.has_key ? [["pclr", i, "清空 Key", ""]] : []), ["pdel", i, "删除渠道", "danger"]])}
      </div>
      ${!open ? "" : `<div class="ch-body">
        ${!po ? "" : `
        <div class="ch-key">
          <label for="ck-${esc(p.id)}">API Key</label>
          <input id="ck-${esc(p.id)}" class="ck-input" type="password" data-chan="${esc(p.id)}"
                 placeholder="${p.key_hint ? `已装 ${esc(p.key_hint)}，要换就粘一把新的` : p.kind === "ollama" ? "Ollama 本机跑，不用填" : "粘贴这家服务商的 API Key"}"
                 value="" autocomplete="off">
          <button type="button" class="btn-brand ck-save" data-chan="${esc(p.id)}">保存</button>
          <button type="button" class="btn-plain ck-test" data-chan="${esc(p.id)}">测一下</button>
          ${kindKeyLink(p.kind, p.base_url)}
        </div>
        ${chanTestNote(p)}`}
        ${mine.length ? mine.map((m) => modelRow(m, s, po)).join("")
          : `<div class="ch-note">这个渠道下面还没有对话模型。${po ? "加一个，它就会出现在输入框右下角那个选择器里。" : ""}</div>`}
        ${!po ? "" : `
        <div class="ca-form" data-chan="${esc(p.id)}" style="display:none;border-top:1px solid var(--owb-border);padding-top:8px;margin-top:6px">
          <div class="form-row">
            <select class="ca-chan"></select>
            <select class="ca-model"></select>
          </div>
          <div class="form-row">
            <input class="ca-custom" placeholder="模型名（上面选「自己填…」时用这个）" style="display:none">
            <input class="ca-name" placeholder="别名（可空，默认用模型名；对话里按这个名字认）">
          </div>
          ${capsRow()}
          <div class="d ca-tip" style="font-size:12px;margin-bottom:6px"></div>
          <button class="btn-brand ca-save">保存</button>
          <button class="btn-plain ca-cancel">取消</button>
        </div>
        <button class="btn-plain ca-new" data-chan="${esc(p.id)}" style="margin-top:6px">${ic("plus")}添加模型</button>`}
      </div>`}
    </div>`;
}

/**
 * 模型行：名字 · 模型 id · 战绩，剩下的都收进 ⋯。地址和 Key 不在这儿——那是渠道的事。
 * withChan：在「对话」总览里用。那张卡横跨所有渠道，不标出处就分不清哪个是哪家的。
 */
function modelRow(m, s, po, withChan) {
  const i = s.models.indexOf(m);
  const cur = m.name === s.active_model;
  const p = withChan && m.channel ? s.providers.find((x) => x.id === m.channel) : null;
  // caps 没这个字段 = 「不知道它会什么」（老配置、目录里挑的都算），一个字都不提示。
  // 只有人亲手说了「它不会调工具 / 它能看图」，才值得在行里标一句
  const caps = Array.isArray(m.caps) ? m.caps : null;
  const flags = !caps ? [] : [caps.includes("tools") ? "" : "不调工具", caps.includes("vision") ? "能看图" : ""].filter(Boolean);
  const meta = [cur ? "主用" : "", p ? esc(provLabel(p, provDupeTags(s.providers))) : "", ...flags.map(esc), healthBadge(m.name)].filter(Boolean).join(" · ");
  return `
    <div class="mrow${cur ? " is-on" : ""}">
      ${po ? `<input type="radio" name="active" ${cur ? "checked" : ""} data-i="${i}" title="设为全局默认模型">`
           : `<span class="mrow-dot" title="${cur ? "当前默认" : ""}">${cur ? "●" : "○"}</span>`}
      <span class="mrow-name">${esc(m.name)}</span>
      <span class="mrow-id">${esc(m.model)}</span>
      <span class="mrow-meta">${meta}</span>
      ${!po ? "" : modelTestBtn("chat", m)}
      ${!po ? "" : rowMenu([["cedit", i, "编辑", ""], ["cdup", i, "复制一个", ""], ["cdel", i, "删除", "danger"]])}
    </div>
    ${!po ? "" : modelTestNote("chat", m)}`;
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
  if (k && k.key_url) return `<a class="get-key" href="${esc(k.key_url)}" target="_blank" rel="noopener">去拿 Key${ic("arrow-up-right")}</a>`;
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
  // 「对话」那张卡跟下面五路共用一套折叠状态（openCaps），只是键是 "chat"
  const chatHead = pane.querySelector(".ch-head[data-chatcap]");
  if (chatHead) chatHead.onclick = () => {
    if (openCaps.has("chat")) openCaps.delete("chat"); else openCaps.add("chat");
    paintModels(pane, s);
  };
  // 顶上六格是可点的：点哪一路就展开哪一路的卡并滚过去。
  // 不这么做的话，那六格就只是六个只能看的标签——而人看完第一反应就是想改它
  pane.querySelectorAll("[data-goto]").forEach((b) => (b.onclick = () => {
    const cap = b.dataset.goto;
    openCaps.add(cap);
    paintModels(pane, s);
    const card = cap === "chat"
      ? pane.querySelector(".ch-head[data-chatcap]")
      : pane.querySelector(`.ch-head[data-cap="${cap}"]`);
    if (card) card.scrollIntoView({ block: "center", behavior: "smooth" });
  }));
  bindRowMenus(pane);
  bindModelTests(pane, s, () => paintModels(pane, s));
  const idleBtn = pane.querySelector("#idle-toggle");
  if (idleBtn) idleBtn.onclick = () => { idleOpen = !idleOpen; paintModels(pane, s); };
  if (!po) return; // 下面全是平台管理员那套按钮，没画出来就别去 querySelector（null.onclick 会把整页炸掉）

  // 头上那句「未填 Key」是可点的：点它就把卡展开、光标直接落在输入框里。
  // 以前它只是一行字加一个「去拿 Key ↗」外链，人拿到 Key 回来还得自己找填在哪儿——
  // 而填的地方藏在 ⋯ → 编辑渠道 里，摸不到就等于没地方填。
  pane.querySelectorAll("[data-fillkey]").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation(); // 别让它冒泡到 .ch-head 上，那个是「开/关」，会把刚展开的又关上
    const id = b.dataset.fillkey;
    openChans.add(id);
    paintModels(pane, s);
    const inp = pane.querySelector(`.ck-input[data-chan="${id}"]`);
    if (inp) { inp.focus(); inp.scrollIntoView({ block: "center", behavior: "smooth" }); }
  }));
  // 卡里那把 Key：填完回车或者点保存就存，不用再绕进「编辑渠道」那张表单
  pane.querySelectorAll(".ck-input").forEach((inp) => (inp.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); const b = pane.querySelector(`.ck-save[data-chan="${inp.dataset.chan}"]`); if (b) b.click(); }
  }));
  pane.querySelectorAll(".ck-save").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.chan;
    const inp = pane.querySelector(`.ck-input[data-chan="${id}"]`);
    const idx = s.providers.findIndex((x) => x.id === id);
    if (idx < 0 || !inp) return;
    const key = inp.value.trim();
    if (!key && s.providers[idx].kind !== "ollama") return toast("Key 是空的。没有 Key 这个渠道连不上，先去它的控制台建一把");
    // has_key 得跟着改：这一屏判「还没填 Key」先看它（非管理员那边拿到的是掩码后的 Key，
    // 只能靠这个布尔）。不同步的话，刚填完保存，这张卡还赖在「还没填 Key」那一栏里不动
    s.providers[idx] = { ...s.providers[idx], api_key: key, has_key: !!key };
    liveModels.delete(id); // 换了 Key，之前拉回来的模型清单就不作数了
    openChans.add(id);
    if (await saveAllModelTables(s, msg)) { toast("Key 已保存"); paintModels(pane, s); }
  }));
  // 「测一下」：拿这条渠道真打一次招呼。填了 Key 不等于能用——余额扣光了、Key 是别家的、
  // 模型名在这家不存在，界面上全都一个样，非要等某个任务跑到一半才炸。
  // 输入框里现打的那把也一起送过去：刚粘上还没点保存就想先验一验，是最自然的一次点击
  pane.querySelectorAll(".ck-test").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.chan;
    const inp = pane.querySelector(`.ck-input[data-chan="${id}"]`);
    const p = s.providers.find((x) => x.id === id);
    if (!p) return;
    chanTest.set(id, { running: true });
    paintModels(pane, s);
    let d;
    try {
      const r = await fetch("/api/provider-test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, kind: p.kind, base_url: p.base_url, api_key: (inp && inp.value.trim()) || "" }),
      });
      d = await r.json();
    } catch (e) {
      d = { ok: false, error: "请求没发出去：" + String((e && e.message) || e) };
    }
    chanTest.set(id, { ok: !!d.ok, ms: d.ms || 0, model: d.model || "", error: d.error || "没说原因" });
    openChans.add(id);
    paintModels(pane, s);
  }));
  // 清空 Key 走 ⋯ 菜单，不给输入框「留空即清除」那条路：那条路会让每一次
  // 「只是想改个模型名」的保存都变成一次误删（整张渠道表是一起存出去的）
  pane.querySelectorAll("a[data-pclr]").forEach((a) => (a.onclick = async (e) => {
    e.preventDefault();
    const idx = +a.dataset.pclr;
    const p = s.providers[idx];
    if (!(await askConfirm({
      title: `清空「${p.name}」的 API Key？`,
      hint: "挂在它下面的模型会立刻用不了。配置都留着，重新填一把 Key 就恢复。",
      ok: "清空", danger: true,
    }))) return;
    s.providers[idx] = { ...p, api_key: "", has_key: false, key_hint: "" };
    chanTest.delete(p.id);
    liveModels.delete(p.id);
    if (await saveAllModelTables(s, msg)) { toast("Key 已清空"); paintModels(pane, s); }
  }));
  // 「主模型挂了换谁」：以前排在 智能体设置 里，夹在步数上限和超时中间——选的明明是模型，
  // 却要去另一页找。挪到对话卡里，跟它要替的那些模型摆在一起
  const fb = pane.querySelector("#ov-failover");
  if (fb) fb.onchange = async () => {
    s.agent = { ...(s.agent || {}), failover_model: fb.value };
    await saveSettings({ agent: { failover_model: fb.value } }, msg);
    if (settingsCache) Object.assign(s, settingsCache);
  };

  const kinds = (mediaCatalog || {}).kinds || [];
  const form = pane.querySelector("#prov-form");
  // 自建网关那几家没有默认地址，地址得人自己填，所以给它一句话说清填到哪一层
  const ADDR_TIP = {
    custom: "自建网关 / 本机部署（vLLM、LM Studio、one-api 这些）：填到 /v1 那一层就行——OpenAI 兼容的接口，后面那一截程序自己接，别把 /chat/completions 也写进去。",
    newapi: "new-api / one-api：填网关自己的根地址（一般到 /v1 那一层），型号名照网关里登记的写。",
    anthropic: "Claude 官方留空即可（SDK 自带官方地址）；接中转就把中转的地址填上。",
  };
  /** 换了渠道类型就把这一栏的说明和「去拿 Key」重画一遍：上一家的说明留在下面，人照着它填就填错了 */
  const syncKindRows = () => {
    const kind = pane.querySelector("#pf-kind").value;
    const k = kinds.find((x) => x.kind === kind) || {};
    pane.querySelector("#pf-base-tip").textContent = ADDR_TIP[kind] || "";
    pane.querySelector("#pf-models-tip").textContent = "";
    pane.querySelector("#pf-key-src").innerHTML = kindKeyLink(kind, pane.querySelector("#pf-base").value.trim() || k.base_url || "");
  };
  let editP = -1;
  // 名字这一栏是「自动填」和「人手打」共用的，改渠道类型时得知道现在这行字是谁写的：
  // 上一次自动填进去的可以跟着新类型换掉，人自己打的字一个字都不能碰
  let autoName = "";
  /** 这个类型「自动该叫什么」：有官网名的用厂商短名；自建网关那两类没有，留空让人自己起 */
  const autoNameOf = (k) => (/^https?:\/\//.test((k || {}).base_url || "") ? String((k || {}).label || "").replace(/（.*/, "") : "");
  const setName = (v) => { pane.querySelector("#pf-name").value = v; autoName = v; };
  const autoFillName = (k, addr) => {
    const el = pane.querySelector("#pf-name");
    if (el.value && el.value !== autoName) return;   // 人自己打的字：别动
    const base = String(addr || "").trim();
    // 自建网关那两类没有「这家叫啥」可言（名字就是一句类型说明），拿域名当名字：
    // 「gw.mycorp.com」比「OpenAI 兼容」强——一条网关上接两台网关时，两张卡会长得一模一样
    if (!autoNameOf(k) && /^https?:\/\//i.test(base)) {
      try { setName(new URL(base).host); return; } catch {}
    }
    setName(autoNameOf(k));
  };
  const showProvForm = (p) => {
    form.style.display = "";
    pane.querySelector("#pf-kind").value = (p && p.kind) || (kinds[0] || {}).kind || "custom";
    pane.querySelector("#pf-name").value = (p && p.name) || "";
    pane.querySelector("#pf-base").value = (p && p.base_url) || "";
    // 手写协议：自建网关后面接的其实是 Claude 时选这个。老库里没这一栏，选中「按渠道类型」
    pane.querySelector("#pf-proto").value = (p && p.protocol) || "";
    // Key 框永远是空的：服务端只回末四位，原文谁也拿不到。留空 = 不动它（见 pf-save）
    const keyEl = pane.querySelector("#pf-key");
    keyEl.value = "";
    keyEl.placeholder = p && p.key_hint ? `已装 ${p.key_hint}，留空就不动它` : "API Key";
    pane.querySelector("#pf-models-tip").textContent = "";
    // 编辑已有渠道时，这个名字是库里存的（可能是自动填的那份，也可能是人改过的），
    // 只有当它正好等于这一类的自动名时才允许后面被换掉
    autoName = autoNameOf(kinds.find((x) => x.kind === pane.querySelector("#pf-kind").value) || {});
    syncKindRows();
  };
  pane.querySelector("#pf-kind").onchange = (e) => {
    const k = kinds.find((x) => x.kind === e.target.value) || {};
    const baseEl = pane.querySelector("#pf-base");
    baseEl.value = k.base_url || "";
    autoFillName(k, baseEl.value);
    syncKindRows();
  };
  pane.querySelector("#pf-base").onchange = () => {
    syncKindRows();
    const baseEl = pane.querySelector("#pf-base");
    autoFillName(kinds.find((x) => x.kind === pane.querySelector("#pf-kind").value) || {}, baseEl.value);
  };
  /**
   * 存之前先问一句「你这儿都有哪些模型」。
   *
   * 渠道卡上本来就会拉一次，但那是**存完**的事：地址写错、网关没起、Key 不对，
   * 都是先落一条坏配置、再在卡片上看到一句「没问到」——而那句话跟「网关没有 /models 接口」
   * 长得一模一样。摆在这一步，人还没提交就能分清是地址错了还是这网关本来就不报清单。
   */
  pane.querySelector("#pf-models").onclick = async () => {
    const tipEl = pane.querySelector("#pf-models-tip");
    const base = pane.querySelector("#pf-base").value.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) return toast("先填接口地址，再问它有哪些模型");
    tipEl.textContent = "正在问…";
    const d = await fetch("/api/provider-models", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_url: base, api_key: pane.querySelector("#pf-key").value.trim() }),
    }).then((r) => r.json()).catch(() => null);
    if (!tipEl.isConnected) return;
    if (!d) { tipEl.textContent = "没能问到（请求没发出去），先保存也行——渠道卡上还会再拉一次。"; return; }
    const ids = (d.models || []).map((m) => m.id).filter(Boolean);
    tipEl.textContent = !d.ok
      ? `没问到（${d.why || "未知原因"}）。有些网关没有 /models 这个接口，保存后直接填型号名也一样。`
      : (ids.length
        ? `它报了 ${ids.length} 个模型：${ids.slice(0, 6).join("、")}${ids.length > 6 ? " 等" : ""}。保存后在这条渠道卡里「添加模型」就能挑。`
        : "它回了个空清单。有的网关没有这个接口，保存后直接把型号名写进去也一样。");
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
    // 连坐的那几样各自成一条，别拼成一个长句：拼出来的句子里嵌着已经插过值的片段，
    // 词典按整句查，这种句子永远配不上——英文用户看到的就会是半句中文
    const 连坐 = [];
    if (chat.length) 连坐.push(`${chat.length} 个对话模型`);
    if (media.length) 连坐.push(`${media.length} 个媒体模型`);
    if (!(await askConfirm({
      title: `删掉渠道「${p.name}」？`,
      hint: 连坐.length ? "挂在它下面的这些会跟着一起删掉：" : "这条渠道下面还没挂模型。",
      items: 连坐,
      note: hitsDefault ? "当前默认模型就在里面，删完会自动换成列表里的第一个。" : "",
      ok: "删掉", danger: true,
    }))) return;
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
    const base = v("pf-base");
    // Anthropic 官方不用填地址（SDK 自带），别的都得是完整的 http(s) 地址
    if (kind !== "anthropic" && !/^https?:\/\//i.test(base)) return toast("接口地址要填完整的 http(s) 地址");
    // 最常见的一种填错：把接口的完整路径抄进来了。程序会再往后接一次 /chat/completions，
    // 于是请求打到 .../chat/completions/chat/completions 或 .../v1/messages/chat/completions——
    // 上游回 404，而界面上从填 Key 到保存一路都是绿的
    if (/\/(chat\/completions|completions|messages|responses)\/?$/i.test(base)) {
      return toast("地址填到 /v1 那一层就行，后面那截（/chat/completions）程序自己会接");
    }
    // 改一个已有渠道时把 Key 框留空 = 「这次不动 Key」。八颗星是后端约定的暗号（/^\*+$/ 原样保留），
    // 直接送空串会把人家的 Key 抹掉——而「只是想改个地址」正是最常见的一次编辑
    const typed = v("pf-key");
    const had = editP >= 0 && s.providers[editP].has_key;
    const key = typed || (had ? "********" : "");
    const entry = { id: editP >= 0 ? s.providers[editP].id : "", name: v("pf-name"), kind, base_url: base, protocol: v("pf-proto"), api_key: key, has_key: !!key };
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
    // "__all__" 是「对话」总览里那张表单：它横跨所有渠道，所以渠道由模型自己说了算，
    // 新建时就停在下拉的第一项上让人挑
    fillChanSelect(f, s, (m && m.channel) || (chanId === "__all__" ? "" : chanId));
    f.querySelector(".ca-name").value = (m && m.name) || "";
    const caps = m && Array.isArray(m.caps) ? m.caps : null;
    const cbT = f.querySelector(".ca-cap-tools"), cbV = f.querySelector(".ca-cap-vision");
    // 编辑一条没标过能力的老模型：两项都勾上（等于「按常见情况算」），人改了才落盘
    if (cbT) cbT.checked = !caps || caps.includes("tools");
    if (cbV) cbV.checked = !caps || caps.includes("vision");
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
    if (!(await askConfirm({ title: `删掉模型「${m.name}」？`, hint: "渠道和 Key 留着，别的模型不受影响。", ok: "删掉", danger: true }))) return;
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
      // 挂错家的型号：对话这一路只拦、不自动挪。媒体那边挪错了顶多是一张图没画出来，
      // 对话这条挪错了人连话都说不上，所以这里把决定权留给用户——写清楚是哪家的，他自己改。
      const bad = mmMismatch((s.providers.find((x) => x.id === chan) || {}).kind, model);
      if (bad) return toast(`「${model}」是${kindLabel(bad)}家的型号，挂在这条渠道上调不通。选${kindLabel(bad)}那条渠道，或者换一个这条渠道有的型号`);
      const was = editM >= 0 ? s.models[editM] : null;
      const cbT = f.querySelector(".ca-cap-tools"), cbV = f.querySelector(".ca-cap-vision");
      const caps = [cbT && cbT.checked ? "tools" : "", cbV && cbV.checked ? "vision" : ""].filter(Boolean);
      // 保留条目上别处写的字段（比如以后加的备注），只覆盖这几样；地址和 Key 由服务端按渠道压平
      const entry = { ...(was || {}), name, channel: chan, model, caps };
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
  // chat_only 的反面：海螺这类只做视频的渠道，对话接口路径根本不是 /chat/completions，
  // 列在这儿只会让人选完发现跑不通——跟那边 fillProvSelect 一个道理
  // decide_only（Jev）同样挡掉：判断模型没有 /chat/completions，挂上去每一趟都是 400
  const mediaOnly = new Set(((mediaCatalog || {}).kinds || []).filter((k) => k.media_only || k.decide_only).map((k) => k.kind));
  const usable = s.providers.filter((p) => !mediaOnly.has(p.kind));
  sel.innerHTML = provOptions(usable, s.providers);
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
  // 别家的型号只在**中转网关**下面摆（new-api / 自建兼容接口：后面接谁只有用户知道，
  // 而且它们正是按型号名往上游路由的）。直连的渠道一概不摆——以前这一组的标题写着
  // 「地址对得上也能用」，地址根本对不上：火山的 doubao-… 在 OpenRouter 上是个不存在的 id，
  // 选中即坏。
  // 真要跨家挂（自建网关做了转发），「自己填…」那条路一直都在。
  const others = p && mmRelay(p.kind) ? cat.filter((m) => m.kind !== p.kind) : [];
  const opt = (m) => `<option value="${esc(m.id)}">${esc(m.label)}（${esc(m.id)}）</option>`;
  sel.innerHTML =
    (mine.length ? `<optgroup label="这个渠道的精选">${mine.map(opt).join("")}</optgroup>` : "") +
    `<option value="__custom__">自己填…</option>` +
    (others.length ? `<optgroup label="别家的型号（这是中转网关，转发到上游就能用）">${others.map(opt).join("")}</optgroup>` : "");
  f.querySelector(".ca-custom").style.display = sel.value === "__custom__" ? "" : "none";
  tip.textContent = mine.length ? "" : "这个渠道没有精选条目，下面直接填模型名，或者等一下从渠道拉回来的列表。";
  if (!p) return;
  const live = liveModels.get(p.id);
  if (live) return injectLiveChat(sel, tip, live, mmLocalProv(p));
  tip.textContent = "正在问渠道有哪些模型…";
  fetch("/api/provider-models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: p.id }) })
    .then((r) => r.json())
    .then((d) => { if (d && d.ok && (d.models || []).length) liveModels.set(p.id, d); if (sel.isConnected) injectLiveChat(sel, tip, d, mmLocalProv(p)); })
    .catch(() => { tip.textContent = MM_FAIL_TIP; });
}

/** 活列表里标了 cap 的（image / video / tts）显然不是对话模型，排到后面去 */
function injectLiveChat(sel, tip, d, local) {
  if (!d.ok || !d.models || !d.models.length) {
    // 拉不到不是错：很多国产渠道压根没有 /models。目录和手填两条路都还在
    tip.textContent = mmEmptyTip(d, local);
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

// 联网搜索：八家服务商 + 自定义接口，各自独立 key。选中的那家没配好或调不通就往下顺延，
// 最后退到不要 Key 的免费通道。Key 一次能填好几家——接力要靠它们。
// 界面上只摊开当前这家，其余收进折叠里：八个密码框一字排开，人是找不到自己要填哪个的。
const SEARCH_VENDORS = {
  bocha:  ["博查",   "sk-...",   "国内", "专做给大模型用的搜索，中文结果好"],
  zhipu:  ["智谱",   "",         "国内", "开放平台的 Web Search，跟模型 Key 同账号"],
  qiniu:  ["七牛云", "sk-...",   "国内", "封装百度搜索"],
  tavily: ["Tavily", "tvly-...", "海外", "有免费额度，不用绑卡"],
  serper: ["Serper", "",         "海外", "拿 Google 的结果，中文收录一般"],
  jina:   ["Jina",   "jina_...", "海外", "结果带网页正文"],
  brave:  ["Brave",  "BSA...",   "海外", "独立索引，要绑卡"],
  custom: ["自定义", "可留空",   "自建", "自己填地址：POST 一个 JSON、回一个结果数组就能接"],
};
const searchKeyField = (id) => id === "custom" ? "custom_key" : id + "_key";

function renderSearchPane(pane, s) {
  const sc = { ...(s.search || {}) };
  const ids = Object.keys(SEARCH_VENDORS);
  const 一行 = (id, 展开) => {
    const [名, 占位, , 说明] = SEARCH_VENDORS[id];
    const custom = id === "custom";
    return `<div class="f">${esc(名)} ${custom ? "接口" : "API"} Key ${keyLink(id)}</div>
      <div style="display:flex;gap:8px;align-items:center">
        <input id="sr-k-${id}" type="password" placeholder="${esc(占位)}" value="${esc(sc[searchKeyField(id)] || "")}" style="flex:1;min-width:0">
        <button type="button" class="btn-plain sr-one" data-p="${id}" style="flex:none">测这家</button>
      </div>
      <div class="d sr-one-msg" id="sr-r-${id}" style="margin-top:4px"></div>
      ${展开 && custom ? `<div class="f">接口地址（POST）</div>
        <input id="sr-custom-url" type="text" placeholder="https://……/search" value="${esc(sc.custom_url || "")}">
        <div class="f">请求体里问题字段叫什么（默认 query）</div>
        <input id="sr-custom-field" type="text" placeholder="query" value="${esc(sc.custom_query_field || "")}">` : ""}
      ${展开 ? `<div class="d" style="margin-top:4px">${esc(说明)}</div>` : ""}`;
  };
  const paint = () => {
    const cur = pane.querySelector("#sr-provider").value;
    const 别家 = ids.filter((id) => id !== cur);
    pane.querySelector("#sr-keys").innerHTML =
      (cur ? 一行(cur, true) : `<div class="d">自动：从上往下挑第一个配好了的。下面填几家都行。</div>`)
      + `<details class="sr-more"${cur ? "" : " open"}><summary>别家的 Key（顺延时用得上，可以多填几家）</summary>`
      + 别家.map((id) => 一行(id, false)).join("") + `</details>`;
    // 每一行后面都有自己的「测这家」。以前只有最下面一颗按钮、测的是「当前首选那家」——
    // 填了四家 Key 的人想知道哪家能用，得把首选一家一家切过去再各测一次；
    // 而顺延链上任何一家坏了，他在界面上永远看不出来是哪一家坏了
    pane.querySelectorAll(".sr-one").forEach((b) => (b.onclick = async () => {
      const id = b.dataset.p;
      const slot = pane.querySelector("#sr-r-" + id);
      b.disabled = true;
      slot.textContent = "先存下来，再拿这家真搜一次…";
      try {
        Object.assign(sc, collect());
        if (!(await saveSettings({ search: collect() }))) { slot.textContent = "✗ " + (lastSaveError || "保存失败"); return; }
        const r = await fetch("/api/search/test?provider=" + encodeURIComponent(id))
          .then((x) => x.json()).catch((e) => ({ error: "请求没发出去：" + String((e && e.message) || e) }));
        slot.textContent = r.ok
          ? `✓ 通了，${r.ms}ms，回了 ${r.n} 条，第一条是「${r.sample}」`
          : "✗ " + (r.error || "测试失败");
      } finally { b.disabled = false; }
    }));
  };
  pane.innerHTML = `
    <div class="card-item">
      <div class="t">搜索服务商</div>
      <div class="d" style="margin-bottom:8px">web_search 用哪家。这家没配 Key 或调不通，会自动顺延到你填过的下一家，最后退到不要 Key 的免费通道。</div>
      <select id="sr-provider">
        <option value="">自动 · 按配好的顺延（国内优先）</option>
        <optgroup label="国内服务商">${ids.filter((i) => SEARCH_VENDORS[i][2] === "国内").map((i) => `<option value="${i}">${esc(SEARCH_VENDORS[i][0])}</option>`).join("")}</optgroup>
        <optgroup label="海外服务商（国内可能要梯子）">${ids.filter((i) => SEARCH_VENDORS[i][2] === "海外").map((i) => `<option value="${i}">${esc(SEARCH_VENDORS[i][0])}</option>`).join("")}</optgroup>
        <optgroup label="自己接">${ids.filter((i) => SEARCH_VENDORS[i][2] === "自建").map((i) => `<option value="${i}">${esc(SEARCH_VENDORS[i][0])}</option>`).join("")}</optgroup>
      </select>
      <div id="sr-keys"></div>
    </div>
    <button class="btn-brand" id="sr-save">保存</button>
    <button class="btn-plain" id="sr-test">测试搜索</button>
    <span class="ok-msg" id="sr-msg"></span>`;
  pane.querySelector("#sr-provider").value = sc.provider || "";
  paint();
  // 换一家之前先把已经敲进去的收走：重画会把 DOM 换掉，不收的话刚填的 Key 当场消失
  pane.querySelector("#sr-provider").onchange = () => { Object.assign(sc, collect()); paint(); };
  const msg = pane.querySelector("#sr-msg");
  function collect() {
    const v = (sel) => { const el = pane.querySelector(sel); return el ? el.value.trim() : ""; };
    const out = { provider: pane.querySelector("#sr-provider").value };
    for (const id of ids) out[searchKeyField(id)] = v("#sr-k-" + id);
    out.custom_url = v("#sr-custom-url") || sc.custom_url || "";
    out.custom_query_field = v("#sr-custom-field") || sc.custom_query_field || "";
    return out;
  }
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
/**
 * 执行追踪（Langfuse）。
 *
 * 这一页要解决的是一句很朴素的诉求：「我要能看到每次执行的具体 trace」。
 * 界面上的过程区是给人看的，一行一句；真要排查「第 7 步为什么换个参数又调一遍」
 * 「哪次调用把 token 烧掉一半」，得看结构化的记录。
 *
 * 三件事必须在这页说清楚，不然用户开着开着会踩坑：
 *   ① 打开之后**提示词原文、模型回复、工具参数**都会发到他填的那台机器上；
 *   ② 自己用 Docker 搭的就在自己机器里，填官方 cloud 就是发给别人；
 *   ③ 「开了但一条都没到」和「开了且正常」在界面上得长得不一样——所以下面那排计数是真账本。
 */
function traceFmtDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`;
}
function traceModels(trace) {
  return [...new Set((trace.observations || []).filter((item) => item.kind === "generation" || item.model).map((item) => item.model || item.metadata?.model).filter(Boolean))];
}
function traceUsage(trace) {
  return (trace.observations || []).reduce((total, item) => {
    const usage = item.usage || {};
    total.input += Number(usage.input || usage.prompt || usage.input_tokens || usage.prompt_tokens || 0);
    total.output += Number(usage.output || usage.completion || usage.output_tokens || usage.completion_tokens || 0);
    return total;
  }, { input: 0, output: 0 });
}
function traceObsDuration(item) {
  if (!item) return 0;
  if (item.startTime && item.endTime) return Math.max(0, new Date(item.endTime).getTime() - new Date(item.startTime).getTime());
  return Number(item.duration_ms || 0);
}
function traceObsStats(trace) {
  const observations = Array.isArray(trace?.observations) ? trace.observations : [];
  const tools = observations.filter((item) => item.kind !== "generation");
  const generations = observations.filter((item) => item.kind === "generation");
  const toolMs = tools.reduce((sum, item) => sum + traceObsDuration(item), 0);
  const modelMs = generations.reduce((sum, item) => sum + traceObsDuration(item), 0);
  const slowest = observations.reduce((best, item) => traceObsDuration(item) > traceObsDuration(best) ? item : best, null);
  return { observations, tools, generations, toolMs, modelMs, slowest };
}
function traceTimeRange(item) {
  if (!item?.startTime) return "时间未记录";
  const start = new Date(item.startTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const end = item.endTime ? new Date(item.endTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "进行中";
  return `${start} → ${end}`;
}
/**
 * 这一步到底动了什么——「实际具体的路径」就是从这儿来的。
 *
 * 界面上以前只有一句「工具 write_file」，跑完根本不知道它写到哪去了。工具的真实参数本来
 * 就在 trace 里躺着（input），只是没人把它捞出来。这里按常见字段挑一个最能说明问题的，
 * 挑不着就把整包参数摊平——宁可显示得糙一点，也不能留一行空白让人去猜。
 */
const TRACE_TARGET_KEYS = ["path", "file", "filename", "dir", "url", "command", "query", "spec", "prompt", "text", "question", "expert", "team", "skill", "code"];
function traceTarget(item) {
  const i = item && item.input;
  if (i && typeof i === "object" && !Array.isArray(i)) {
    for (const k of TRACE_TARGET_KEYS) {
      const v = i[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    const keys = Object.keys(i).filter((k) => k !== "_raw");
    if (keys.length) return keys.map((k) => `${k}=${typeof i[k] === "string" ? i[k] : JSON.stringify(i[k])}`).join("   ");
  }
  if (typeof i === "string" && i.trim()) return i.trim();
  return String((item && item.metadata && item.metadata.title) || "");
}
/** 长参数（shell 脚本、整段代码）只留前三行，剩下的展开「输入」里看 */
function traceTargetText(item) {
  const raw = traceTarget(item);
  if (!raw) return "";
  const lines = raw.split("\n");
  let head = lines.slice(0, 3).join("\n");
  if (head.length > 420) head = head.slice(0, 420) + "…";
  else if (lines.length > 3) head += "\n…";
  return head;
}
function traceJson(v) {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}
function traceFold(label, value, open) {
  if (value === null || value === undefined || value === "") return "";
  return `<details${open ? " open" : ""}><summary>${esc(label)}</summary><pre>${esc(traceJson(value))}</pre></details>`;
}
/** 时间线上的一步。层级靠左边距表示，耗时靠底下那根横条——一眼看得出哪步最慢 */
function traceStepHtml(item, children, depth, ctx) {
  const dur = traceObsDuration(item);
  const bad = !!(item.error || item.level === "ERROR");
  const gen = item.kind === "generation";
  const usage = traceUsage({ observations: [item] });
  const model = item.model || (item.metadata && item.metadata.model) || "";
  const bare = String(item.name || "").replace(/^工具\s*/, "");
  const name = gen ? (model || "模型调用") : ((item.metadata && item.metadata.tool) || bare || "工具");
  const kind = gen ? ["is-model", "模型"] : /^专家|^外部引擎/.test(bare) ? ["is-agent", "子任务"] : ["is-tool", "工具"];
  const target = traceTargetText(item);
  const pct = ctx.max > 0 ? Math.max(2, Math.round((dur / ctx.max) * 100)) : 0;
  const tokens = usage.input || usage.output ? ` · <b>${usage.input.toLocaleString()}</b> in / <b>${usage.output.toLocaleString()}</b> out` : "";
  const n = ++ctx.n;
  const nested = (children.get(item.id) || []).map((kid) => traceStepHtml(kid, children, depth + 1, ctx)).join("");
  return `<details class="tp-step${bad ? " is-error" : ""}" style="--trace-depth:${Math.min(depth, 6)}">
    <summary><span class="tp-no">${n}</span><span class="tp-kind ${kind[0]}">${kind[1]}</span><span class="tp-sname" title="${esc(name)}">${esc(name)}</span><span class="tp-cost"><b>${traceFmtDuration(dur)}</b>${tokens}${bad ? ' · <b>失败</b>' : item.endTime ? "" : " · 进行中"}</span></summary>
    ${target ? `<div class="tp-target">${esc(target)}</div>` : ""}
    ${pct ? `<div class="tp-bar-line"><i style="width:${pct}%"></i></div>` : ""}
    ${item.error ? `<div class="tp-err">${esc(item.error)}</div>` : ""}
    <div class="tp-fold">${traceFold("完整输入", item.input)}${traceFold("输出", item.output)}${item.metadata && Object.keys(item.metadata).length ? traceFold("元数据", item.metadata) : ""}<div style="margin-top:6px;color:var(--owb-text-3);font-size:12px">${esc(traceTimeRange(item))}</div></div>
  </details>${nested}`;
}
function renderTraceDetail(box, trace) {
  if (!box) return;
  if (!trace) { box.innerHTML = '<div class="tp-detail"><div class="tp-empty">左边点一条任务，这里显示它每一步调了什么、动了哪个文件、花了多久。</div></div>'; return; }
  const children = new Map(), roots = [];
  for (const item of trace.observations || []) {
    const parented = item.parentId && item.parentId !== trace.id && (trace.observations || []).some((x) => x.id === item.parentId);
    if (parented) { if (!children.has(item.parentId)) children.set(item.parentId, []); children.get(item.parentId).push(item); }
    else roots.push(item);
  }
  const total = trace.duration_ms || (trace.startTime && trace.endTime ? new Date(trace.endTime).getTime() - new Date(trace.startTime).getTime() : 0);
  const models = traceModels(trace), usage = traceUsage(trace), stats = traceObsStats(trace);
  const max = Math.max(0, ...(trace.observations || []).map(traceObsDuration));
  const ctx = { n: 0, max };
  const slow = stats.slowest ? `${(stats.slowest.metadata && stats.slowest.metadata.tool) || stats.slowest.name || stats.slowest.kind}` : "-";
  const [statusCls, statusText] = TRACE_STATUS[trace.status] || TRACE_STATUS.completed;
  const cell = (b, t, title) => `<div${title ? ` title="${esc(title)}"` : ""}><b>${b}</b><span>${esc(t)}</span></div>`;
  box.innerHTML = `<div class="tp-detail">
    <div class="tp-dhead"><div><b${trace.name_derived ? ' class="is-said"' : ""}>${esc(trace.name || "（没留下名字）")}</b><small>${[trace.startTime ? new Date(trace.startTime).toLocaleString() : "-", Number(trace.turn) > 1 ? `第 ${trace.turn} 轮` : "", trace.id].filter(Boolean).map((b) => `<span>${esc(b)}</span>`).join(" · ")}</small></div><span class="tp-pill ${statusCls}">${esc(statusText)}</span></div>
    <div class="tp-sum">
      ${cell(esc(traceFmtDuration(total)), "总耗时")}
      ${cell(String(stats.tools.length), "工具调用")}
      ${cell(String(stats.generations.length), "模型调用")}
      ${cell(esc(traceFmtDuration(stats.toolMs)), "花在工具上")}
      ${cell(esc(traceFmtDuration(stats.modelMs)), "花在模型上")}
      ${cell(usage.input + usage.output ? (usage.input + usage.output).toLocaleString() : "—", "Token",
        usage.input + usage.output ? `${usage.input.toLocaleString()} 进 / ${usage.output.toLocaleString()} 出` : "这趟没记到 token 账（模型渠道没回用量，或是在记账修好之前跑的）")}
      ${cell(esc(slow), "最慢的一步", stats.slowest ? traceFmtDuration(traceObsDuration(stats.slowest)) : "")}
    </div>
    ${models.length ? `<div class="tp-models">用到的模型${models.map((m) => `<i>${esc(m)}</i>`).join("")}</div>` : ""}
    <div class="tp-steps">
      <div class="tp-steps-label"><span>执行时间线 · 点开任意一步看完整参数和结果</span><span>共 ${(trace.observations || []).length} 步</span></div>
      ${roots.map((item) => traceStepHtml(item, children, 0, ctx)).join("") || '<div class="tp-empty">这趟任务没有工具或模型记录。老会话是在修复之前跑的，重跑一次就有了。</div>'}
    </div>
    <div class="tp-io">${traceFold("任务输入（完整提示词）", trace.input)}${trace.output ? `<details open class="is-final"><summary>最终回复</summary><pre>${esc(traceJson(trace.output))}</pre></details>` : ""}</div>
  </div>`;
}

// ================= 更多 → 执行追踪（整页） =================
let traceCache = [];
let traceSel = "";
let traceQuery = "";
let traceOnlyBad = false;
/** 搜索匹配到任务名、工具名，也匹配路径——「我上次写的那个报告在哪一趟任务里」靠这个找 */
function traceHit(t, q) {
  if (!q) return true;
  const hay = [t.name, t.id, ...(t.observations || []).flatMap((o) => [o.name, o.model, (o.metadata && o.metadata.tool) || "", traceTarget(o)])].join("\n").toLowerCase();
  return hay.includes(q.toLowerCase());
}
async function renderTracePage() {
  const page = document.getElementById("assist-page");
  if (!page) return;
  page.innerHTML = `<div class="tp">
    <div class="tp-bar">
      <div class="hub-search tp-grow">${ic("search")}<input id="tp-q" placeholder="搜任务名、工具名、文件路径…" value="${esc(traceQuery)}"></div>
      <label class="chip" style="gap:6px;cursor:pointer"><input type="checkbox" id="tp-bad"${traceOnlyBad ? " checked" : ""} style="margin:0"> 只看出过错的</label>
      <button class="btn-plain" id="tp-refresh">${ic("refresh-cw")} 刷新</button>
      <button class="btn-plain" id="tp-clear">${ic("eraser")} 清空</button>
    </div>
    <div id="tp-note"></div>
    <div class="tp-stats" id="tp-stats"></div>
    <div class="tp-body"><div class="tp-list" id="tp-list"></div><div id="tp-detail"></div></div>
  </div>`;
  const q = page.querySelector("#tp-q");
  q.oninput = () => { traceQuery = q.value; paintTraceList(); };
  page.querySelector("#tp-bad").onchange = (e) => { traceOnlyBad = e.target.checked; paintTraceList(); };
  page.querySelector("#tp-refresh").onclick = () => loadTracePage();
  page.querySelector("#tp-clear").onclick = async (e) => {
    if (!(await askConfirm({ title: "清空本机保存的执行记录？", hint: "工作区文件和 Langfuse 上的副本都不受影响。", ok: "清空", danger: true }))) return;
    e.currentTarget.disabled = true;
    await fetch("/api/traces", { method: "DELETE" }).catch(() => {});
    traceSel = "";
    await loadTracePage();
    e.currentTarget.disabled = false;
    toast("已清空");
  };
  await loadTracePage();
}
async function loadTracePage() {
  const [data, s] = await Promise.all([
    fetch("/api/traces?limit=200").then((r) => r.json()).catch(() => ({ traces: [] })),
    settingsCache ? Promise.resolve(settingsCache) : fetch("/api/settings").then((r) => r.json()).catch(() => null),
  ]);
  if (pageKind !== "trace") return;
  traceCache = Array.isArray(data.traces) ? data.traces : [];
  const stats = document.getElementById("tp-stats");
  const done = traceCache.filter((t) => t.status === "completed"), bad = traceCache.filter((t) => t.status === "error");
  const run = traceCache.filter((t) => t.status === "running"), stale = traceCache.filter((t) => t.status === "interrupted");
  const avg = done.length ? done.reduce((sum, t) => sum + Number(t.duration_ms || 0), 0) / done.length : 0;
  const tok = traceCache.reduce((sum, t) => { const u = traceUsage(t); return sum + u.input + u.output; }, 0);
  // 「累计 Token」以前恒等于 0：大多数记录压根没记到账，加起来当然是 0，
  // 而屏幕上一个大写的 0 会让人以为模型是白嫖的。记到几条就说几条
  const billed = traceCache.filter((t) => { const u = traceUsage(t); return u.input + u.output > 0; }).length;
  if (stats) stats.innerHTML = `
    <div class="tp-stat"><b>${traceCache.length}</b><span>最近任务</span></div>
    <div class="tp-stat"><b>${done.length}</b><span>跑完</span></div>
    <div class="tp-stat${bad.length ? " is-error" : ""}"><b>${bad.length}</b><span>出过错</span></div>
    ${run.length ? `<div class="tp-stat is-run"><b>${run.length}</b><span>还在跑</span></div>` : ""}
    ${stale.length ? `<div class="tp-stat is-stale" title="开工记了、收尾没记上——多半是当时把进程关了或者机器重启了"><b>${stale.length}</b><span>中断</span></div>` : ""}
    <div class="tp-stat" title="${billed} / ${traceCache.length} 趟任务记到了 token 账；其余的是在记账修好之前跑的">
      <b>${tok ? (tok >= 1000 ? (tok / 1000).toFixed(1) + "k" : tok) : "—"}</b><span>累计 Token</span></div>`;
  // Langfuse 那条只是一行状态，改配置还是去设置页——这一页管的是「看记录」，不是「配上报」
  const note = document.getElementById("tp-note");
  const lf = (s && s.langfuse) || {}, st = lf.stats || {};
  if (note) {
    const cls = st.bad_host || (lf.enabled && !st.ready) ? "is-warn" : lf.enabled && st.ready ? "is-on" : "";
    const txt = st.bad_host ? "Langfuse 开着，但地址不像个网址，一条都没往外发（本地这份不受影响）"
      : lf.enabled && !st.ready ? "Langfuse 开着，但钥匙没填全，一条都没往外发（本地这份不受影响）"
        : lf.enabled ? `同时上报到 Langfuse · 已发出 ${st.sent || 0} 条${st.failed ? ` · 失败 ${st.failed} 条` : ""}`
          : "只存在这台机器上（当前工作区的 .openworkbuddy/traces.jsonl），没有往任何外部服务发";
    note.innerHTML = `<div class="tp-note ${cls}">${ic(cls === "is-warn" ? "triangle-alert" : cls === "is-on" ? "cloud" : "hard-drive")}<span>${esc(txt)}</span>${amPlatformOwner() ? '<a href="#" class="link" id="tp-cfg">去设置里配 Langfuse</a>' : ""}</div>`;
    const cfg = note.querySelector("#tp-cfg");
    if (cfg) cfg.onclick = (e) => { e.preventDefault(); openModal("settings", "trace"); };
  }
  paintTraceList();
}
/** 这一趟是谁跑的、在哪个工作区跑的——两趟任务长得一样时，就靠这两样分开 */
function traceWho(t) {
  const md = t.metadata || {};
  return String(t.userId || md.user || "").slice(0, 24);
}
function traceWhere(t) {
  const ws = String((t.metadata || {}).workspace || "");
  if (!ws) return "";
  // 只要最后一段：完整路径又长又全是重复前缀，在一行里挤掉了真正有用的东西
  return ws.split(/[/\\]/).filter(Boolean).pop() || "";
}
const TRACE_STATUS = {
  error: ["is-error", "失败"],
  running: ["is-running", "还在跑"],
  // 「开着没收尾」和「真的还在跑」得分开。进程关掉、机器重启、任务被掐，都不会写收尾那条，
  // 一律画成「还在跑」的话，一个早就没在跑的人打开这页会看到几十条假的进行中
  interrupted: ["is-stale", "中断"],
  completed: ["", "完成"],
};
/**
 * 列表里的一行。
 *
 * 改之前每行是「任务 / 809ms / 3 工具 · 2 模型 / 0 Token / 09/17 03:09」——
 * 名字全一样，工具只有个数，Token 恒等于 0。二十行长得一模一样，只能一条条点开试。
 * 现在第一行放这趟到底要干什么（写的时候没名字就取用户最近说过的那句有内容的话），
 * 第二行放真正能把两趟分开的东西：第几轮、用了哪几个工具、哪个模型、谁跑的、在哪个工作区。
 */
function traceRowHtml(t) {
  const u = traceUsage(t), st = traceObsStats(t);
  const [cls, label] = TRACE_STATUS[t.status] || TRACE_STATUS.completed;
  const name = t.name || "（没留下名字）";
  // 工具列名字而不是个数：「3 工具」谁都一样，「web_search · write_file」一眼认得出是哪趟
  const toolNames = [...new Set(st.tools
    .map((o) => (o.metadata && o.metadata.tool) || String(o.name || "").replace(/^工具\s*/, ""))
    .filter((x) => x && !/^外部引擎/.test(x)))];
  const tools = toolNames.length
    ? toolNames.slice(0, 3).join(" · ") + (toolNames.length > 3 ? ` +${toolNames.length - 3}` : "")
    : "";
  const models = traceModels(t);
  const tok = u.input + u.output;
  // 「没记到账」和「一个 token 没花」不是一回事，别都写成 0
  const tokText = tok ? `${tok >= 1000 ? (tok / 1000).toFixed(1) + "k" : tok} Token` : (st.generations.length ? "Token 未记" : "");
  // 同一个会话里聊着聊着开出来的几趟，名字天然就像（都从这段历史里截的）。
  // 轮次不塞进名字——名字已经够长了——放在这条淡色的信息行里，一眼能看出哪趟在前哪趟在后。
  const turn = Number(t.turn) > 1 ? `第 ${t.turn} 轮` : "";
  const bits = [
    t.startTime ? new Date(t.startTime).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "",
    turn,
    tools,
    models.length ? models[0] + (models.length > 1 ? ` +${models.length - 1}` : "") : "",
    tokText,
    traceWho(t),
    traceWhere(t),
  ].filter(Boolean);
  return `<button type="button" class="tp-row ${cls}${t.id === traceSel ? " on" : ""}" data-trace="${esc(t.id)}">
    <i class="dot"></i>
    <span class="tp-rmain">
      <span class="tp-rtop"><b title="${esc(name)}"${t.name_derived ? ' class="is-said"' : ""}>${esc(name)}</b><em>${esc(traceFmtDuration(t.duration_ms))}</em></span>
      <span class="tp-meta">${bits.map((b) => `<span>${esc(b)}</span>`).join("")}${
        cls ? `<span class="tp-rst">${esc(label)}</span>` : ""}</span>
    </span>
  </button>`;
}
function paintTraceList() {
  const list = document.getElementById("tp-list"), detail = document.getElementById("tp-detail");
  if (!list) return;
  const rows = traceCache.filter((t) => (!traceOnlyBad || t.status === "error") && traceHit(t, traceQuery));
  list.innerHTML = rows.length ? rows.map(traceRowHtml).join("")
    : `<div class="tp-empty">${traceCache.length ? "没有匹配的任务" : "还没有记录。下一次对话或画布任务会自动记下来。"}</div>`;
  list.querySelectorAll("[data-trace]").forEach((row) => row.onclick = async () => {
    traceSel = row.dataset.trace;
    paintTraceList();
    const d = await fetch("/api/traces/" + encodeURIComponent(traceSel)).then((r) => r.json()).catch(() => null);
    if (pageKind === "trace") renderTraceDetail(document.getElementById("tp-detail"), d && d.trace);
  });
  if (!traceSel) renderTraceDetail(detail, null);
}
/**
 * 运行状况：指标折线 + 正在报的警 + 运行期日志。
 *
 * 这一页要回答的是三个具体问题，不是「好看」：
 *   · 最近这几个小时有没有变糟（失败率、P95 的折线）
 *   · 现在有没有什么正在报警，以及它报了多久了
 *   · 刚才那次出错，日志里写的是什么
 * 所以图用最朴素的画法（一个 svg polyline，不引图表库——这个项目没有构建步骤），
 * 日志给到级别和关键词两个过滤器就停手。要做更花的，等真有人抱怨这一页不够用再说。
 */
function renderOpsPane(pane) {
  pane.innerHTML = `
    <div class="card-item">
      <div class="t">最近的运行指标</div>
      <div class="d" style="margin-bottom:8px">每分钟滚一份快照，存在 <code>data/metrics/&lt;年-月&gt;.jsonl</code>，留最近 6 个月。<b>计数是「这一分钟内」的增量</b>，不是累计值——重启不会在图上留一个假的断崖。</div>
      <div id="ops-cards" style="display:flex;flex-wrap:wrap;gap:10px;margin:10px 0"></div>
      <div id="ops-chart"></div>
    </div>
    <div class="card-item">
      <div class="t">正在报的警</div>
      <div class="d" style="margin-bottom:8px">命中阈值就推到企业微信 / 钉钉（在「助理设置」里配机器人地址）。<b>同一条 30 分钟内只报一次</b>，恢复了也会说一声——只报警不报恢复的系统，两周后就没人看了。</div>
      <div id="ops-alerts"></div>
    </div>
    <div class="card-item">
      <div class="t">运行日志</div>
      <div class="d" style="margin-bottom:8px">一行一条 JSON，落 <code>logs/app-&lt;日期&gt;.jsonl</code>，留最近 14 天。出错和警告同时还会打在终端里。</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
        <select id="ops-day" style="max-width:160px"></select>
        <select id="ops-level" style="max-width:120px">
          <option value="">全部级别</option><option value="info">info 及以上</option>
          <option value="warn">warn 及以上</option><option value="error">只看 error</option>
        </select>
        <input id="ops-q" placeholder="关键词（会话 id / 登录名 / 报错原文）" style="flex:1;min-width:180px">
        <button class="btn-plain" id="ops-refresh">刷新</button>
      </div>
      <div id="ops-logs" style="max-height:420px;overflow:auto;font-family:var(--mono, ui-monospace, monospace);font-size:12px;line-height:1.7"></div>
    </div>`;

  const num = (v, unit = "") => (v == null ? "—" : v + unit);
  /** 一条极简折线。没有坐标轴、没有 tooltip——这一页是用来「一眼看出有没有变糟」的，不是给人读数的 */
  const spark = (rows, key, color, label, fmt) => {
    const vals = rows.map((r) => Number(r[key]) || 0);
    const max = Math.max(...vals, key === "task_fail_rate" ? 0.2 : 1);
    const w = 100, h = 28;
    const pts = vals.map((v, i) => `${(i / Math.max(1, vals.length - 1)) * w},${h - (v / max) * h}`).join(" ");
    const last = vals[vals.length - 1] || 0;
    return `<div style="flex:1;min-width:150px;background:var(--owb-bg-side);border-radius:10px;padding:10px 12px">
      <div style="font-size:12px;color:var(--owb-text-2)">${label}</div>
      <div style="font-size:19px;font-weight:600;margin:2px 0 4px">${fmt ? fmt(last) : last}</div>
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:28px;display:block"><polyline fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${pts}"></polyline></svg>
    </div>`;
  };

  const loadMetrics = async () => {
    let d;
    try { d = await fetch("/api/ops/metrics?limit=360").then((r) => r.json()); } catch { d = null; }
    const cards = pane.querySelector("#ops-cards"), chart = pane.querySelector("#ops-chart"), al = pane.querySelector("#ops-alerts");
    if (!d || d.error) { cards.innerHTML = `<div class="d">${esc((d && d.error) || "读不出来")}</div>`; return; }
    const rows = d.rows || [];
    if (!rows.length) {
      // 「还没攒够一分钟」和「坏了」长得不能一样，不然用户会去查一个根本不存在的故障
      cards.innerHTML = `<div class="d">还没有快照。服务起来之后每分钟滚一份，等一分钟再看这里。</div>`;
      chart.innerHTML = "";
    } else {
      cards.innerHTML = [
        spark(rows, "tasks", "#4c8dff", "任务数 / 分钟"),
        spark(rows, "task_fail_rate", "#e5534b", "失败率", (v) => (v * 100).toFixed(0) + "%"),
        spark(rows, "task_p95_ms", "#d29922", "P95 耗时", (v) => (v / 1000).toFixed(1) + "s"),
        spark(rows, "tokens", "#3fb950", "Token / 分钟"),
        spark(rows, "rss_mb", "#a371f7", "内存", (v) => v + " MB"),
        spark(rows, "disk_free_pct", "#58a6ff", "磁盘剩余", (v) => (v * 100).toFixed(0) + "%"),
      ].join("");
      const last = rows[rows.length - 1];
      const streak = Object.entries(last.channel_fail_streak || {});
      chart.innerHTML = `<div class="d">最近一份快照：${esc(String(last.ts).replace("T", " ").slice(0, 19))} · 正在跑 ${num(last.active_runs)} 趟 · 未接住的 500 共 ${num(last.http_5xx)} 次${
        streak.length ? ` · 连挂的渠道：${streak.map(([k, v]) => esc(k) + " ×" + v).join("、")}` : ""}</div>`;
    }
    const alerts = Object.entries(d.alerts || {});
    al.innerHTML = alerts.length
      ? alerts.map(([id, v]) => `<div style="padding:6px 0;border-bottom:1px solid var(--owb-line)"><b>${esc(id)}</b> <span class="d">正在报，已持续约 ${Math.max(1, Math.round((Date.now() - (v.since || Date.now())) / 60000))} 分钟</span></div>`).join("")
      : `<div class="d">现在没有正在报的警。（这不代表没配通道——想验一下的话，可以把阈值调低再跑几趟任务。）</div>`;
  };

  const loadLogs = async () => {
    const day = pane.querySelector("#ops-day").value, level = pane.querySelector("#ops-level").value, q = pane.querySelector("#ops-q").value;
    const box = pane.querySelector("#ops-logs");
    let d;
    try { d = await fetch(`/api/ops/logs?day=${encodeURIComponent(day)}&level=${encodeURIComponent(level)}&q=${encodeURIComponent(q)}&limit=300`).then((r) => r.json()); } catch { d = null; }
    if (!d || d.error) { box.innerHTML = `<div class="d">${esc((d && d.error) || "读不出来")}</div>`; return; }
    const sel = pane.querySelector("#ops-day");
    if (!sel.options.length) sel.innerHTML = (d.days || []).map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("") || `<option value="">今天</option>`;
    const color = { error: "#e5534b", warn: "#d29922", info: "var(--owb-text-2)", debug: "var(--owb-text-3)" };
    box.innerHTML = (d.rows || []).length
      ? d.rows.map((r) => {
          const extra = Object.entries(r).filter(([k]) => !["ts", "level", "mod", "msg"].includes(k)).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
          return `<div style="padding:2px 0;white-space:pre-wrap;word-break:break-all"><span style="color:var(--owb-text-3)">${esc(String(r.ts).slice(11, 19))}</span> <span style="color:${color[r.level] || "inherit"}">${esc(r.level)}</span> <b>${esc(r.mod)}</b> ${esc(r.msg)} <span style="color:var(--owb-text-3)">${esc(extra)}</span></div>`;
        }).join("")
      : `<div class="d">这一天没有符合条件的日志。</div>`;
  };

  pane.querySelector("#ops-refresh").onclick = () => { loadMetrics(); loadLogs(); };
  pane.querySelector("#ops-level").onchange = loadLogs;
  pane.querySelector("#ops-day").onchange = loadLogs;
  pane.querySelector("#ops-q").onkeydown = (e) => { if (e.key === "Enter") loadLogs(); };
  loadMetrics();
  loadLogs();
}

function renderTracePane(pane, s) {
  const lf = s.langfuse || {};
  const st = lf.stats || {};
  pane.innerHTML = `
    <div class="card-item">
      <div class="t">记录去哪看</div>
      <div class="d" style="margin-bottom:8px">每趟任务调了哪些工具、动了哪些文件、花了多久、烧了多少 Token，都默认记在当前工作区里（<code>.openworkbuddy/traces.jsonl</code>），不依赖 Langfuse、也不往外发。这一页只管「要不要同时抄一份到 Langfuse」；<b>看记录在侧栏「更多 → 执行追踪」</b>——那儿是整页的，一眼扫得完。</div>
      <button class="btn-plain" id="lf-goto-page">${ic("activity")} 打开执行追踪</button>
    </div>
    <div class="card-item">
      <div class="t">执行追踪</div>
      <div class="d" style="margin-bottom:6px">开了之后，每趟任务的每次模型调用、每个工具、每笔 token 都会发到 Langfuse，在那边一层层展开看。默认关着——<b>打开等于把提示词原文、模型回复、工具参数发到下面填的那台机器</b>。自己用 Docker 搭一个就全在自己机器里；填官方 cloud.langfuse.com 就是发给别人。</div>
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;color:var(--owb-text-2);cursor:pointer"><input type="checkbox" id="lf-on" style="margin:0"${lf.enabled ? " checked" : ""}> 打开执行追踪</label>
      <div class="f">Langfuse 地址</div>
      <input id="lf-host" placeholder="https://cloud.langfuse.com 或 http://你的内网地址:3000" value="${esc(lf.host || "")}">
      <div class="f">公钥 Public Key</div>
      <input id="lf-pk" placeholder="pk-lf-..." value="${esc(lf.public_key || "")}">
      <div class="f">私钥 Secret Key</div>
      <input id="lf-sk" type="password" placeholder="sk-lf-..." value="${esc(lf.secret_key || "")}">
      <div class="d" style="margin-top:6px">两把钥匙在 Langfuse 里进「项目设置 → API Keys」生成一对，复制过来。</div>
    </div>
    <div class="card-item">
      <div class="t">上报情况</div>
      <div class="d" id="lf-stat"></div>
    </div>
    <button class="btn-brand" id="lf-save">保存</button>
    <button class="btn-plain" id="lf-test">测一下能不能通</button>
    <span class="ok-msg" id="lf-msg"></span>`;

  // 上报账本。0 在这儿是「一条都没发过」，不是「一条都没失败」——两种意思写成两句话，
  // 不然用户看到一排 0 会以为一切正常（其实可能是地址填错了，压根没发出去过）
  const statBox = pane.querySelector("#lf-stat");
  if (!lf.enabled) statBox.textContent = "还没打开。打开并填好钥匙后，这里会显示实际发出去多少条。";
  // 地址填错和钥匙没填全得分开说。设置页保存时会拦住不像网址的地址，但手改 config.json
  // 的人（自建、Docker 部署）绕得过去，那种情况下写成「钥匙没填全」会让人去翻错的地方
  else if (st.bad_host) statBox.textContent = "开着，但 config.json 里的地址不像个网址（得是 http:// 或 https:// 开头）——现在一条都不会发，也不会替你退回官方云，免得把提示词发错地方。";
  else if (!st.ready) statBox.textContent = "开着，但钥匙没填全——现在一条都不会发。";
  else {
    const bits = [`已发出 ${st.sent || 0} 条`];
    if (st.queued) bits.push(`排队中 ${st.queued} 条`);
    if (st.failed) bits.push(`发失败 ${st.failed} 条`);
    if (st.rejected) bits.push(`被对方拒收 ${st.rejected} 条`);
    if (st.dropped) bits.push(`积压丢弃 ${st.dropped} 条`);
    statBox.textContent = (st.sent || st.failed || st.queued)
      ? bits.join(" · ") + (st.last_error ? `。最后一次出错：${st.last_error}` : "")
      : "开着，但这台服务器重启之后还没跑过任务，所以一条都还没发。跑一趟任务再回来看。";
  }

  const msg = pane.querySelector("#lf-msg");
  const collect = () => ({
    enabled: pane.querySelector("#lf-on").checked,
    host: pane.querySelector("#lf-host").value.trim(),
    public_key: pane.querySelector("#lf-pk").value.trim(),
    secret_key: pane.querySelector("#lf-sk").value.trim(),
  });
  pane.querySelector("#lf-save").onclick = async () => {
    if (await saveSettings({ langfuse: collect() }, msg)) renderSettings("trace"); // 存完立刻重画，账本那块跟着更新
  };
  // 这颗按钮是这一页的重点：这一块的失败全是静默的（地址少个字母、Key 是另一个项目的、
  // 自建实例端口没开），任务照跑，只是 trace 永远空着。所以当场发一条真的上去，成不成立刻说。
  // 不先存：用户就是想在存之前确认这几个值对不对
  pane.querySelector("#lf-test").onclick = async (e) => {
    e.target.disabled = true;
    msg.textContent = "正在发一条测试记录…";
    const c = collect();
    const r = await fetch("/api/trace/test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: c.host, public_key: c.public_key, secret_key: c.secret_key }),
    }).then((x) => x.json()).catch(() => ({ ok: false, detail: "请求没发出去" }));
    if (r.ok) {
      msg.innerHTML = `✓ 通了，测试记录已经在那边了 <a href="${esc(r.url || "")}" target="_blank" rel="noopener">点开看看</a>`;
    } else {
      msg.textContent = `✗ 没通：${r.detail || r.error || "原因不明"}`;
    }
    e.target.disabled = false;
  };
  pane.querySelector("#lf-goto-page").onclick = () => { closeModal(); openPageView("trace"); };
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
      <div class="t">执行上限</div>
      <div class="f">最大执行步数</div>
      <div class="d" style="margin-bottom:6px">单个任务 Agent 循环上限，防止失控（默认 25）</div>
      <input id="ag-steps" type="number" min="1" max="100" value="${s.agent.max_steps}">
      <div class="f">单工具超时（秒）</div>
      <input id="ag-timeout" type="number" min="5" value="${Math.round(s.agent.tool_timeout_ms / 1000)}">
      <div class="f">任务最大运行时间（分钟）</div>
      <div class="d" style="margin-bottom:6px">整个任务（含专家子代理）的墙上时间预算，超时强制收尾（默认 30）</div>
      <input id="ag-runtime" type="number" min="1" value="${Math.round((s.agent.max_runtime_ms || 1800000) / 60000)}">
      <div class="f">自动续跑轮数</div>
      <div class="d" style="margin-bottom:6px">任务撞到步数/时间上限但还没做完时，自动重置预算接着跑的最大轮数。0 = 关闭（默认）。开启后长任务会按 PROGRESS.md 的进度接着做，直到完成或轮数用完；手动停止不会续跑。注意：每一轮都是真实计费</div>
      <input id="ag-rounds" type="number" min="0" max="20" value="${s.agent.auto_continue_rounds || 0}">
      <div class="f">模型卡壳超时（秒）</div>
      <div class="d" style="margin-bottom:6px">连续这么久收不到模型的任何输出（正文/思考/写文件的参数流都算）才判定连接挂死、强制收尾；只要还在逐字输出就不会掐断（默认 300）</div>
      <input id="ag-llm-timeout" type="number" min="30" value="${Math.round((s.agent.llm_timeout_ms || 300000) / 1000)}">
      <div class="f">token 预算（万 tokens）</div>
      <div class="d" style="margin-bottom:6px">单个任务（含专家子代理和自动续跑）的 token 总量上限，超过后强制收尾且不再自动续跑，防止长任务烧钱失控。0 = 不限（默认）。用到 80% 会先提醒</div>
      <input id="ag-tokbudget" type="number" min="0" step="1" value="${Math.round((s.agent.max_tokens_budget || 0) / 10000)}">
      <div class="f">备用渠道（主模型挂起自动换道）</div>
      <div class="d" style="margin-bottom:6px">${(s.agent.failover_model || "")
        ? `现在选的是「<b>${esc(s.agent.failover_model)}</b>」。`
        : "现在是关闭的：主模型挂了就如实报错，绝不悄悄换成别的模型。"}
        这个下拉已经挪到 <b>设置 → 模型 → 对话</b>，跟它要替的那些模型摆在一起——选的是模型，却排在步数和超时中间，原来那个位置没人找得到</div>
      <div class="f">上下文预算（千字符）</div>
      <div class="d" style="margin-bottom:6px">超出后自动截短较早的工具输出（最近 3 步始终保留原文），避免长任务撞模型上下文上限整个失败。上下文大的模型可以调高（默认 120）</div>
      <input id="ag-ctx" type="number" min="20" max="2000" value="${Math.round((s.agent.max_context_chars || 120000) / 1000)}">
      <div class="f">生成类并发条数</div>
      <div class="d" style="margin-bottom:6px">出图 / 出片 / 配音这三类，一轮里最多同时跑几条（1-4，默认 2）。一集短剧十几个镜头，一条条排队最坏要等一两个小时；但这类每条都真花钱（视频按条计费），所以给得比只读工具保守。填 1 就是全部排队，回到老样子</div>
      <input id="ag-genpar" type="number" min="1" max="4" value="${s.agent.gen_parallel_max || 2}">
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
      gen_parallel_max: +pane.querySelector("#ag-genpar").value,
      max_tokens_budget: Math.round(+pane.querySelector("#ag-tokbudget").value * 10000) || 0,
      // 下拉挪走了，但这一单还是得把它原样带上：整个 agent 对象是一起存的，
      // 漏掉这个字段不会报错，只会在某次「改了下步数上限」之后悄悄把备用渠道关掉
      failover_model: (s.agent || {}).failover_model || "",
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
    setMsg(note, l.supported ? "" : "triangle-alert", (l.supported ? `对 ${where}：` : `对 ${where} 不生效 —— `) + (l.note || ""));
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
 * `2.1.278 (Claude Code)` → `2.1.278`；`codex-cli 0.154.0` → `0.154.0`。
 *
 * 各家 `--version` 输出的花样都不一样：一个把产品名括在后面，一个把包名顶在前面。
 * 原样贴到徽章上，就成了「本机 Claude Code · 已装 2.1.278 (Claude Code)」——
 * 产品名在同一行里说了两遍，两张卡还是两个形状。徽章上只留版本号；
 * 原样那一行挪进展开区（「本机这一份」），谁要对包名谁去看。
 */
function engVer(v) {
  const s = String(v || "").trim();
  const m = s.match(/\bv?(\d+\.\d+\.\d+[^\s()]*)/) || s.match(/\bv?(\d+\.\d+[^\s()]*)/);
  return m ? m[1] : s;
}

// 连接测试的结论按引擎记一份。这张卡会因为切引擎、保存设置、重新检测重画好几次，
// 不留着的话刚测出来的「真跑通了」一眨眼就没了，用户只能再花一次 token 重测。
// 只活在这一次打开设置页期间——机器状态随时会变，隔天还敢说"测过了"就是撒谎。
const engTested = new Map();

/**
 * 徽章上只说说得出口的那部分。
 *
 * 旧版这里写的是「已装 ✓」，绿的。但它的依据只有 `--version` 跑通了——
 * 那只证明**文件在**。装了没登录、订阅过期、被限流，在旧卡片上全长一个样：绿的。
 * 所以没测过之前一律用中性措辞（「本机有 2.1.278」），绿色留给真跑通过的那一种。
 */
function engBadgeHtml(e, v) {
  if (e.id === "builtin") return '<span class="eng-b">走 API Key</span>';
  if (!e.installed) return '<span class="eng-b no">本机没找到</span>';
  const ver = engVer(e.version);
  const free = '<span class="eng-b free">不花 API 额度</span>';
  if (v && v.ok) return `<span class="eng-b ok">${ic("circle-check")}真跑通了${ver ? " · " + esc(ver) : ""}</span>${free}`;
  if (v) return `<span class="eng-b bad">${ic("circle-x")}连不上</span><span class="eng-b">本机有${ver ? " " + esc(ver) : ""}</span>`;
  return `<span class="eng-b">本机有${ver ? " " + esc(ver) : ""}</span>${free}`;
}

/** 测出来的结论长什么样。重画卡片时也走这里，所以结论跟着卡片一起活 */
function engVerdictHtml(v, on) {
  if (!v) return "";
  if (v.ok) {
    return `<div class="eng-r ok">${ic("circle-check")} 真跑通了，用了 ${(v.ms / 1000).toFixed(1)} 秒。它回了「${esc(v.reply || "")}」`
      + (v.model ? `，实际跑的模型是 <code>${esc(v.model)}</code>` : "")
      + "。这一趟没花 API 额度，走的是你本机的订阅。"
      + (on ? "" : "<br>想用它的话，点这张卡就切过去了。")
      + `<br><span class="eng-p">${esc(v.path || "")}${v.version ? " · " + esc(v.version) : ""}</span></div>`;
  }
  return `<div class="eng-r bad">${ic("circle-x")} 连不上：${esc(v.why || "未知原因")}`
    + (v.hint ? `<br>下一步：<code>${esc(v.hint)}</code>` : "")
    + "</div>";
}

/**
 * 「底层引擎」卡片。
 *
 * 这张卡的职责不是"列个单子"，是**让用户真的用上本机那份订阅**。三件事必须做到：
 *   ① 找得到 —— 双击图标启动的 App 拿到的 PATH 是残废的（只有 /usr/bin:/bin:…），
 *      claude/codex 装在 homebrew、nvm、~/.local/bin 里的一律看不见。这一层在
 *      engines/which.js 里补齐了，卡片这边把"从哪找到的"如实标出来。
 *   ② 说实话 —— `--version` 只证明文件在，不证明能用。装了没登录、订阅过期、
 *      被限流，在旧版卡片上全都显示"已装 ✓"，绿的。所以没真跑过之前徽章只说
 *      「本机有 2.1.278」，绿色留给连接测试真跑通的那一种；而那个测试挂在每一张
 *      装了的卡上，不是只挂在选中的那张——不然就成了"想知道它行不行，先切过去用它"。
 *   ③ 出事有下一步 —— 失败时不只报错，要说清楚接下来敲哪条命令。
 *
 * 折叠状态下不摆命令行：`claude -p --output-format stream-json` 这种东西对着
 * 「我想用我的订阅」的人说不出任何信息，挪到展开区跟可执行文件路径摆一块儿，就近。
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
    const v = engTested.get(e.id);
    // 从补全的 PATH / 登录 shell 里找到的，说一声——用户要是纳闷"我明明装了它怎么现在才看见"，这就是答案
    const howNote = !builtin && e.installed && e.how && e.how !== "PATH"
      ? `<div class="eng-i">（${esc(e.how)}里找到的：<span class="eng-p">${esc(e.path || "")}</span>）</div>` : "";
    // 「试一下能不能用」挂在每一张装了的卡上，不管选没选中。
    // 以前它只长在展开区里，而展开区只对**已经选中的**引擎渲染——
    // 等于「想知道它能不能用，得先切过去用它」。开关摆在只有切过去才看得见的地方，等于没有。
    const tryRow = !builtin && e.installed
      ? `<div class="eng-try"><button class="btn-plain" data-act="test">试一下能不能用</button>
        <span class="eng-msg">${on ? "让它回一句话，几十个 token" : "让它回一句话，不用先切过来"}</span></div>
        <div data-role="result">${engVerdictHtml(v, on)}</div>` : "";
    return `<div class="eng${on ? " on" : ""}${ready ? "" : " off"}" data-eng="${esc(e.id)}" data-ready="${ready ? 1 : 0}" data-ver="${esc(engVer(e.version))}">
      <div class="eng-h"><span class="eng-dot">${on ? "●" : "○"}</span><b>${esc(e.label)}</b><span class="eng-bs">${engBadgeHtml(e, v)}</span></div>
      <div class="eng-n">${esc(e.note || "")}</div>
      ${howNote}
      ${!builtin && !e.installed ? `<div class="eng-i">${esc(e.error || "没找到")}<br>装法：<code>${esc(e.install || "")}</code></div>` : ""}
      ${tryRow}
      ${builtin || !on ? "" : engineExtraHtml(e)}
    </div>`;
  }).join("") + '<div class="eng-row" style="margin-top:4px"><button class="btn-plain" id="ag-eng-rescan">重新检测本机</button><span class="eng-msg" id="ag-eng-msg"></span></div>';

  const msg = box.querySelector("#ag-eng-msg");
  box.querySelector("#ag-eng-rescan").onclick = (ev) => { ev.stopPropagation(); renderEngineCard(box, true); };

  box.querySelectorAll(".eng").forEach((el) => {
    const id = el.dataset.eng;
    if (el.classList.contains("on")) bindEngineExtra(el, id, box);
    const tb = el.querySelector('[data-act="test"]');
    if (tb) tb.onclick = (ev) => { ev.stopPropagation(); testEngineConnect(el, id); };
    el.onclick = async (ev) => {
      // 展开区的输入框、试一试那一行、测出来的结论，点了都不算"切引擎"
      if (ev.target.closest(".eng-x, .eng-try, .eng-r")) return;
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

/** 选中的引擎才展开：可执行文件路径、模型、思考档 */
// 思考/effort 档位（跟 thinking.js 的 LEVELS 同一张表；"" = 跟随全局档位）
const ENGINE_THINK_LEVELS = [
  ["", "跟随全局思考模式"], ["auto", "跟随 CLI 默认"], ["off", "关闭思考"], ["low", "低"], ["medium", "中"], ["high", "高"],
];
function engineExtraHtml(e) {
  const o = e.options || {};
  const listId = "eng-models-" + e.id;
  const models = Array.isArray(e.models) ? e.models : [];
  const modelHint = e.modelSource === "codex_config"
    ? "下拉只展示当前 Codex 配置中真实出现的模型；留空会用它当前默认值，也可直接输入 Codex 支持的其他名字。"
    : e.id === "codex"
      ? "Codex CLI 没有可查询的模型目录；这里不会伪造候选。留空用 Codex 默认模型，或直接输入你已开通的模型名。"
      : "留空 = 用 CLI 自己的默认模型；也可以直接输入它支持的模型名。";
  return `<div class="eng-x" onclick="event.stopPropagation()">
    <label>可执行文件路径<span style="color:var(--owb-text-3)">（留空 = 自动找。装在 nvm/homebrew 里也能找到；只有自动找不到时才需要填绝对路径）</span>
      <input type="text" data-k="bin" placeholder="${esc(e.path || e.id)}" value="${esc(o.bin || "")}"></label>
    <label>模型<span style="color:var(--owb-text-3)">（${esc(modelHint)}）</span>
      <input type="text" data-k="model" list="${listId}" placeholder="默认" value="${esc(o.model || "")}" autocomplete="off">
      <datalist id="${listId}">${models.map((m) => `<option value="${esc(m)}">`).join("")}</datalist></label>
    <label>${esc(e.thinkingLabel || "思考模式")}<span style="color:var(--owb-text-3)">（只对这个引擎生效；「跟随全局」= 用助理设置里的思考模式）</span>
      <select data-k="thinking">${ENGINE_THINK_LEVELS.map(([v, l]) => `<option value="${v}"${(o.thinking || "") === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
    <div class="eng-row">
      <button class="btn-plain" data-act="save">保存路径 / 模型 / 思考档</button>
      <span class="eng-msg" data-role="xmsg"></span>
    </div>
    <div class="eng-c">跑起来是这条命令：${esc(e.launchHeader || "")}${e.version ? "　本机这一份：" + esc(e.version) : ""}</div>
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
 *
 * 没选中的卡也测得了：展开区不在，就用**已经存下来**的那套设置去测，
 * 而那正是切过去之后下一个任务会用的那一套。
 */
async function testEngineConnect(card, id) {
  const btn = card.querySelector('[data-act="test"]');
  const out = card.querySelector('[data-role="result"]');
  if (!btn || !out) return;
  const on = card.classList.contains("on");
  const opts = {};
  card.querySelectorAll(".eng-x input[data-k]").forEach((i) => (opts[i.dataset.k] = i.value.trim()));
  btn.disabled = true;
  const t0 = Date.now();
  const paint = () => { out.innerHTML = `<div class="eng-r">正在真连一次…已等 ${Math.round((Date.now() - t0) / 1000)} 秒（第一次会慢一点）</div>`; };
  paint();
  const tick = setInterval(paint, 500);
  let r;
  try { r = await fetch("/api/engines/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, options: opts }) }).then((v) => v.json()); }
  catch (e) { r = { ok: false, why: "请求失败：" + e.message }; }
  clearInterval(tick);
  btn.disabled = false;
  r = r || {};
  const v = {
    ok: !!r.ok, ms: r.ms || Date.now() - t0, reply: r.reply || "", model: r.model || "",
    path: r.path || "", version: r.version || "", why: r.why || r.error || "", hint: r.hint || "",
  };
  engTested.set(id, v);
  out.innerHTML = engVerdictHtml(v, on);
  // 徽章跟着改口。不在这儿改的话，卡上会同时挂着「本机有 2.1.278」和一条"连不上"的红结论
  const bs = card.querySelector(".eng-bs");
  if (bs) bs.innerHTML = engBadgeHtml({ id, installed: true, version: card.dataset.ver }, v);
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
      <div class="t">${ic("cat")} 桌面宠物</div>
      <div class="d" style="margin-bottom:10px"><b>默认没有宠物</b>——直接在对话里说「把这张图做成桌面宠物」并传一张照片，它就现场给你做一只；这里是手动开关和微调。<br>做出来之后，它会在桌面角落实时显示 agent 在干什么：干活时敲键盘、<b>要问你问题时跳起来并弹系统通知</b>（这条最有用——主窗口被盖住时，它提的问题很容易被漏掉，超时就按默认继续了）。点它开关主窗口，拖动换位置，右键有菜单（含免打扰）。空白处不吃鼠标，不会挡住底下的应用。${p.available === false ? '<br><span style="color:var(--owb-warn,#c60)">当前是纯服务端模式（npm start），宠物只在桌面版 <code>npm run app</code> 下出现。</span>' : ""}</div>
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;color:var(--owb-text-2);cursor:pointer"><input type="checkbox" id="pet-on" style="margin:0"${on ? " checked" : ""}> 显示桌面宠物</label>
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;color:var(--owb-text-2);cursor:pointer"><input type="checkbox" id="pet-notify" style="margin:0"${p.notify !== false ? " checked" : ""}> 要提问时弹系统通知 + 图标跳动</label>
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;color:var(--owb-text-2);cursor:pointer"><input type="checkbox" id="pet-notify-done" style="margin:0"${p.notify_done !== false ? " checked" : ""}> 任务干完 / 出错时也提醒我一声</label>
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;color:var(--owb-text-2);cursor:pointer"><input type="checkbox" id="pet-wander" style="margin:0"${p.wander ? " checked" : ""}> 闲着时让它在桌面上随便走走（默认关）</label>
      <div class="f">形象</div>
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
      <div class="f">大小 <span id="pet-scale-v" style="color:var(--owb-text-3)">${Math.round((p.scale || 2) * 100)}%</span></div>
      <input type="range" id="pet-scale" min="0.6" max="2" step="0.1" value="${p.scale || 2}">
      <div class="f">透明度 <span id="pet-op-v" style="color:var(--owb-text-3)">${Math.round((p.opacity || 1) * 100)}%</span></div>
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
  const badLine = bad.length ? `<br><span style="color:var(--owb-warn,#c60)">有 ${bad.length} 只装了但用不了：${bad.map(x => esc(x.name || x.id) + "（" + esc(x.why) + "）").join("、")}</span>` : "";
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
    if (!(await askConfirm({ title: "换回内置小猫？", hint: "你上传的那张照片会被删掉。", ok: "换回去", danger: true }))) return;
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
  const vecOk = !vs.enabled || !vs.total || vs.have >= vs.total;
  const vecLine = !vs.enabled
    ? "语义召回没开：没接嵌入模型，现在按关键词召回。设置 → 模型 里配一条支持 embeddings 的渠道就能开。"
    : !vs.total ? `语义召回已接上（${vs.model}），记了东西就会自动算向量。`
    : vs.have >= vs.total ? `语义召回开着：${vs.total} 条都算好了向量（${vs.model}）。`
    : `语义召回：${vs.total} 条里只有 ${vs.have} 条算出了向量——嵌入渠道大概率没通，现在按关键词召回。服务器日志里搜「[记忆向量]」能看到原因。`;
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
    : '<div style="color:var(--owb-text-3);font-size: 14px;padding:6px 0">还没有。你说「以后都这样」「记住…」时它会自己记一条；也可以在下面手动加。</div>';
  pane.innerHTML = `
    <div class="card-item">
      <div class="t">${ic("pin")} 记住的事（AI 自己记的 + 你手动加的）</div>
      <div class="d" style="margin-bottom:8px">一条一句话，跨任务保留。标「共享」的所有账号都看得到，标账号名的只跟着那个人走。每人最多 ${esc(String((m.limits || {}).max_items || 120))} 条。</div>
      <div class="d" id="mem-vec" style="margin-bottom:8px">${ic(vecOk ? "search" : "triangle-alert")} ${esc(vecLine)}</div>
      <div id="mem-items">${rows}</div>
      <div class="form-row" style="margin-top:8px">
        <input id="mem-new" placeholder="手动加一条，例如：周报只要三段——进展 / 问题 / 下周计划">
        <button class="btn-plain" id="mem-add" style="flex:0 0 auto">加进去</button>
      </div>
      ${m.can_share ? `
      <label style="display:flex;align-items:center;gap:6px;font-size: 13px;color:var(--owb-text-3);margin-top:6px;cursor:pointer">
        <input type="checkbox" id="mem-shared" style="margin:0"> 这条给这台机器上所有账号共用
      </label>` : `
      <div class="d" style="margin-top:6px">加进去的只有你自己看得到。要让这台机器上所有账号都共用某条，得平台管理员来加。</div>`}
    </div>
    <div class="card-item">
      <div class="t">${ic("file-pen-line")} 背景说明（全局共享，原样进提示词）</div>
      <div class="d" style="margin-bottom:8px">适合放团队/业务背景、常用数据口径、固定模板要求这种成段的东西。所有账号共用一份。${m.can_edit_manual ? "" : "这份归平台管理员维护，你这边只读。"}</div>
      <textarea id="mem-text" rows="8" ${m.can_edit_manual ? "" : "readonly"} placeholder="例如：我们公司是做跨境电商的，主营美妆品类；周报收件人是运营部…">${esc(m.content)}</textarea>
    </div>
    ${!m.can_edit_manual ? "" : `
    <div class="card-item">
      <div class="t">${ic("truck")} 记忆搬家（导出 / 从其它 agent 导入）</div>
      <div class="d" style="margin-bottom:8px">导出成一份 Markdown 到哪都能用。导入自动扫描本机 Claude Code / Codex / Claude Cowork 的记忆文件；记忆不落在固定文件里的工具，从它界面里把记忆复制出来粘到下面即可。「导入为条目」逐行进上面的条目区（自动去重），「并入背景说明」整段接到背景说明后面。</div>
      <div style="margin-bottom:8px"><button class="btn-plain" id="mem-export">${ic("upload")} 导出全部记忆（.md）</button></div>
      <div id="mem-scan" style="font-size: 13px;color:var(--owb-text-2)">扫描中…</div>
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
    if (r.error) { setMsg(impMsg, "circle-x", r.error, "err"); return; }
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
      <div style="display:flex;align-items:center;gap:10px;padding:4px 0;border-bottom:1px solid var(--owb-border)">
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis" title="${esc(s.path)}">${esc(s.label)}</span>
        <span style="color:var(--owb-text-3)">${fmtSize(s.size)}</span>
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
        <button class="btn-plain" id="ws-pick" style="flex:0 0 auto">${ic("folder-open")} 选择文件夹</button>
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
      <div style="margin-top:8px"><button class="btn-brand" id="cache-clear">${ic("eraser")} 清理缓存</button><span class="ok-msg" id="cache-msg"></span></div>
    </div>
    <div class="card-item">
      <div class="t">${ic("save")} 数据备份与恢复</div>
      <div class="d" style="margin-bottom:8px">一键把会话记录、记忆、账号、个人偏好、用量、定时任务、自己写的技能和全部配置（含 API Key）打包成 tar.gz 存到本机 backups/ 文件夹。换电脑就「下载」带走，在新机器上「导入备份文件」再点「恢复」，人和数据一起搬过去。<b>不含工作空间成果文件</b>（那些你自己看得见），也不含出厂自带的技能（新机器上本来就有）。恢复会先自动备份当前现状，恢复后需重启应用生效。</div>
      <div style="margin-bottom:8px">
        <button class="btn-brand" id="bk-create">立即备份</button>
        <button class="btn-plain" id="bk-import">${ic("upload")} 导入备份文件</button>
        <input type="file" id="bk-file" accept=".gz,.tgz,application/gzip" style="display:none">
        <span class="ok-msg" id="bk-msg"></span>
      </div>
      <div id="bk-list" style="font-size: 13px;color:var(--owb-text-2)">加载中…</div>
    </div>
    <div class="card-item">
      <div class="t">数据说明</div>
      <div class="d">会话记录持久化在 data/sessions/ · 定时任务在 schedules.json · 配置在 config.json（含 API Key，默认不入 git）· 记忆在 data/memory.md 与 data/memories.json · 技能在 skills/ · 成果文件在 workspace/ · 备份在 backups/</div>
      <div class="d" style="margin-top:6px">手机、网页、终端连的都是这一台，所以它们看到的是同一份数据，不用同步。只有主题、字号这类「这台屏幕看着舒服」的设置存在各自的浏览器里，换设备不跟着走。</div>
    </div>`;
  pane.querySelector("#ws-pick").onclick = async () => {
    const r = await fetch("/api/pick-folder", { method: "POST" }).then(r => r.json()).catch(() => ({}));
    if (r.path) pane.querySelector("#ws-dir").value = r.path;
    else if (r.error) toast(r.error, "circle-x");
  };
  pane.querySelector("#ws-save").onclick = () => saveSettings({ workspace_dir: pane.querySelector("#ws-dir").value.trim(), workspace_permanent: true }, pane.querySelector("#ws-msg"))
    .then(ok => { if (ok) fetch("/api/files").then(r => r.json()).then(renderFiles); });
  pane.querySelector("#ws-open").onclick = () => openWorkspaceOnHost();
  const cacheDesc = pane.querySelector("#cache-desc");
  const loadCache = () => fetch("/api/cache").then(r => r.json()).then(c => {
    const g = c.gen || {};
    // 生成结果缓存单独说一句：它不是磁盘垃圾，是「这一格已经买过了」的账。
    // 省下的次数要摆出来——看不见的省钱，用户只会当它不存在
    const saved = g.hits ? `已经替你省下 ${g.hits} 次生成调用` : "还没派上用场（同一格再跑一次就会命中）";
    cacheDesc.textContent = `界面缓存 ${fmtSize(c.ui)} · 临时脚本 ${fmtSize(c.tmp)}，共 ${fmtSize(c.total)}。只清可再生的缓存，不动会话记录、工作区文件和登录态。`
      + `\n另有生成结果缓存 ${g.entries || 0} 条（生图/生视频/配音），${saved}。这份不在清理范围里——清掉只会让下次重新花钱。`;
  }).catch(() => { cacheDesc.textContent = "统计失败"; });
  loadCache();
  pane.querySelector("#cache-clear").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "清理中…";
    try {
      const r = await fetch("/api/cache/clear", { method: "POST" }).then(r => r.json());
      pane.querySelector("#cache-msg").textContent = r.ok ? `已释放 ${fmtSize(r.freed)}` : (r.error || "清理失败");
    } catch { pane.querySelector("#cache-msg").textContent = "清理失败"; }
    btn.disabled = false; btn.innerHTML = ic("eraser") + " 清理缓存";
    loadCache();
  };
  // ---- 备份 ----
  const bkMsg = pane.querySelector("#bk-msg");
  const bkList = pane.querySelector("#bk-list");
  const loadBackups = () => fetch("/api/backup").then(r => r.json()).then(d => {
    if (d.error) { bkList.textContent = d.error; return; }
    const list = d.list || [];
    bkList.innerHTML = list.length ? list.map(b => `
      <div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--owb-border)">
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(b.name)}</span>
        <span style="color:var(--owb-text-3)">${fmtSize(b.size)}</span>
        <a href="#" class="link" data-bk-restore="${esc(b.name)}">恢复</a>
        <a href="/api/backup/download/${encodeURIComponent(b.name)}" class="link">下载</a>
        <a href="#" class="link danger" data-bk-del="${esc(b.name)}">删</a>
      </div>`).join("") : "还没有备份。";
    bkList.querySelectorAll("[data-bk-del]").forEach(a => a.onclick = async (e) => {
      e.preventDefault();
      if (!(await askConfirm({ title: `删掉备份「${a.dataset.bkDel}」？`, hint: "这一份存档从此没有了。", ok: "删掉", danger: true }))) return;
      await fetch("/api/backup/" + encodeURIComponent(a.dataset.bkDel), { method: "DELETE" });
      loadBackups();
    });
    bkList.querySelectorAll("[data-bk-restore]").forEach(a => a.onclick = async (e) => {
      e.preventDefault();
      if (!(await askConfirm({
        title: `恢复到备份「${a.dataset.bkRestore}」？`,
        hint: "现在这份数据会先自动备份一次，所以后悔了还能再翻回来。恢复完要重启应用才完全生效。",
        ok: "恢复", danger: true,
      }))) return;
      bkMsg.textContent = "恢复中…";
      const r = await fetch("/api/backup/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: a.dataset.bkRestore }) }).then(r => r.json()).catch(() => ({ error: "网络错误" }));
      if (r.error) { setMsg(bkMsg, "circle-x", r.error, "err"); return; }
      bkMsg.textContent = "";
      if (await askConfirm({
        title: "已恢复到磁盘",
        hint: "恢复前的现状已经自动备份了一份。还差最后一步：重启应用，这次恢复才完全生效。",
        ok: "现在重启", cancel: "待会儿自己重启",
      })) {
        const rr = await fetch("/api/backup/restart", { method: "POST" }).then(r => r.json()).catch(() => ({}));
        if (rr.error) toast(rr.error, "circle-x");
      } else {
        toast("记得手动重启应用，恢复才完全生效");
      }
      loadBackups();
    });
  }).catch(() => { bkList.textContent = "加载失败"; });
  loadBackups();
  // ---- 导入：把另一台机器上下载下来的包送回来 ----
  // 少了这一头，「下载备份带走」到了新机器就没有下文了——包躺在下载目录里，界面上没有任何地方能接住它。
  const bkFile = pane.querySelector("#bk-file");
  pane.querySelector("#bk-import").onclick = () => bkFile.click();
  bkFile.onchange = async () => {
    const f = bkFile.files && bkFile.files[0];
    bkFile.value = ""; // 清掉：不清的话同一个文件选第二次不触发 change，用户会以为按钮坏了
    if (!f) return;
    if (!/\.(tar\.gz|tgz)$/i.test(f.name)) return setMsg(bkMsg, "circle-x", "只认 .tar.gz 备份文件", "err");
    setMsg(bkMsg, "upload", `上传中…（${fmtSize(f.size)}）`);
    // 直接把 File 当 body 发原始字节。走 JSON 得先 base64，凭空胖三分之一，几百兆的包扛不住
    const r = await fetch("/api/backup/upload", { method: "POST", headers: { "Content-Type": "application/gzip" }, body: f })
      .then(r => r.json()).catch(() => ({ error: "上传失败（文件太大或网络中断）" }));
    if (r.error) return setMsg(bkMsg, "circle-x", r.error, "err");
    setMsg(bkMsg, "circle-check", `已导入 ${r.name}，在下面点「恢复」才会生效`, "ok");
    loadBackups();
  };
  pane.querySelector("#bk-create").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "备份中…";
    const r = await fetch("/api/backup", { method: "POST" }).then(r => r.json()).catch(() => ({ error: "网络错误" }));
    if (r.ok) setMsg(bkMsg, "circle-check", `已备份：${r.name}`, "ok"); else setMsg(bkMsg, "circle-x", r.error || "备份失败", "err");
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
      else { e.target.disabled = false; setMsg(msg, "circle-x", d.error, "err"); }
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
    if (d.ok) { setMsg(msg, "circle-check", "已填入并保存，可以点飞书卡上的「连接」了", "ok"); renderSettings("im"); }
    else { e.target.disabled = false; setMsg(msg, "circle-x", d.error, "err"); }
  };
  box.querySelector("#lk-login").onclick = async (e) => {
    const qr = box.querySelector("#lk-qr");
    e.target.disabled = true; msg.textContent = "取授权链接…"; msg.style.color = "";
    const d = await fetch("/api/feishu/qr/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(r => r.json()).catch(() => ({ error: "请求失败" }));
    e.target.disabled = false;
    if (!d.ok) { setMsg(msg, "circle-x", d.error || "启动失败", "err"); return; }
    msg.textContent = "";
    qr.innerHTML = `<div style="display:flex;gap:12px;align-items:flex-start">
      ${d.qr ? `<img src="${d.qr}" width="176" height="176" style="border:1px solid var(--owb-border);border-radius:8px;image-rendering:pixelated">` : ""}
      <div style="min-width:0">
        <div><b>用飞书 App 扫这个码</b>，或在浏览器打开下面的链接：</div>
        <div style="margin:6px 0"><a href="${esc(d.url)}" target="_blank" rel="noreferrer" style="word-break:break-all">${esc(d.url)}</a></div>
        <div id="lk-qr-st" style="color:var(--owb-text-3)">等待授权…（${d.expires_in} 秒内有效）</div>
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
        qr.innerHTML = `<div style="color:var(--owb-ok-text)">${ic("circle-check")} 授权成功${s2.user ? "：" + esc(s2.user) : ""}。现在 AI 可以用 lark-cli 以你的身份操作飞书了。</div>`;
        renderLarkQr(pane);
      } else if (s2.state === "error") {
        clearInterval(larkQrPoll); larkQrPoll = null;
        line.style.color = "var(--owb-err-text)";
        setMsg(line, "circle-x", s2.error || "授权失败", "err");
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
// 旧版是 9 大段说明文字平铺一屏，乱到没法自己调。
// 从整段粘贴里把飞书那两串凭证抠出来。
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
  { key: "feishu", grp: "chat", icon: "bird", name: "飞书", sub: "长连接 · 无需公网", path: "feishu", src: "feishu",
    newapp: true, // 一键新建应用：连 App ID / Secret 都不用手打
    paste: { hint: "从飞书开放平台「凭证与基础信息」整页复制粘过来就行，不用一个字段一个字段抠", parse: parseFeishuCreds },
    fields: [["app_id", "App ID"], ["app_secret", "App Secret", "password"], ["verification_token", "Verification Token（可选，仅旧回调模式）", "", "opt"]],
    groupPolicy: true,
    test: { url: "/im/feishu/test", ok: (d) => `凭证有效${d.bot_name ? `，机器人「${d.bot_name}」` : ""}，长连接：${WS_STATE_TXT[(d.ws || {}).state] || (d.ws || {}).state || "启动中"}` },
    help: ["飞书开放平台创建自建应用，添加「机器人」能力", "权限开通 im:message 与 im:message:send_as_bot", "事件订阅方式选「使用长连接接收事件」，添加 im.message.receive_v1；把机器人拉进群后，成员 @ 它即可下任务", "要在云文档评论里 @ 机器人：再添加 drive.notice.comment_add_v1 事件，并开 docs:document.comment:read；文档需要已授予应用可读权限。机器人只处理被 @ 的评论，并在原评论下回复", "发布一个版本，回来填 App ID / App Secret（或把那一页整段复制，用卡片里的「粘一段过来自动识别」）", "嫌麻烦就点上面的「扫码新建应用」——本机装了 lark-cli 的话，应用直接替你建好，App ID 自动填；App Secret 被系统钥匙串锁着的话，会给你一条直达凭证页的链接，复制回来粘一下"],
    // 缺哪一半就写哪一半：以前只写「未连接」，用户看不出是没填、填错、还是没联网
    status: (st) => { const f = st.feishu || {}; const m = f.missing || [];
      if (m.length === 1) return ["warn", "还差 " + m[0]];
      return wsChip({ configured: f.configured, state: (f.ws || {}).state }, "未连接"); } },
  { key: "qq", grp: "chat", icon: "message-circle", name: "QQ", sub: "长连接 · 无需公网", path: "qq", src: "qq",
    fields: [["app_id", "AppID"], ["app_secret", "AppSecret", "password"]],
    test: { url: "/im/qq/test", ok: (d) => `凭证有效，长连接：${WS_STATE_TXT[(d.ws || {}).state] || (d.ws || {}).state || "启动中"}` },
    help: ["QQ 开放平台 q.qq.com 创建「机器人」，开发设置里拿 AppID / AppSecret", "功能配置 → 消息列表：开启私聊消息和群聊 @机器人 消息", "沙箱只对白名单群/好友生效，正式使用需提交审核发布"],
    status: (st) => wsChip(st.qq, "未连接") },
  { key: "wechat_ilink", grp: "chat", icon: "message-square", name: "微信", sub: "扫码登录 · 无需公网", qr: true,
    help: ["点「连接」出二维码，用要当机器人的那个微信号扫码并在手机上确认", "之后本机主动长轮询收发消息，别人给这个微信号发消息 = 下任务", "登录态由微信控制，失效后重新扫码；发来的图片/文件/语音会自动存进工作目录，AI 直接按文件名打开"],
    status: (st) => wsChip(st.wechat_ilink, "未扫码") },
  { key: "wecom_app", grp: "chat", icon: "building-2", name: "企业微信应用", sub: "双向对话 · 需公网 HTTPS", path: "wecom_app", src: "wecom_app",
    fields: [["corp_id", "CorpID"], ["agent_id", "AgentId（纯数字）"], ["secret", "应用 Secret", "password"], ["token", "Token"], ["aes_key", "EncodingAESKey（43 位）", "password"]],
    test: { url: "/im/wechat/test", body: { which: "wecom" }, ok: () => "凭证有效。回调地址还需你暴露公网 HTTPS 并在企微后台点「保存」验证" },
    help: ["管理后台 → 应用管理 → 自建应用：拿 AgentId 与 Secret；「我的企业」拿 CorpID", "「接收消息 → 设置 API 接收」随机生成 Token 与 EncodingAESKey，回填这里", "回调 URL 填 https://你的域名/im/wecom/events（内网穿透/反代都行），保存后腾讯会来验证"],
    status: (st) => wxStatus(st.wecom_app) },
  { key: "wechat_mp", grp: "chat", icon: "megaphone", name: "微信公众号", sub: "需公网 HTTPS + 认证服务号", path: "wechat_mp", src: "wechat_mp",
    fields: [["app_id", "AppID"], ["app_secret", "AppSecret", "password"], ["token", "Token"], ["aes_key", "EncodingAESKey（43 位）", "password"]],
    test: { url: "/im/wechat/test", body: { which: "mp" }, ok: () => "凭证有效。回调地址还需你暴露公网 HTTPS 并在公众平台点「提交」验证" },
    help: ["公众平台 → 开发 → 基本配置：拿 AppID / AppSecret", "服务器配置 URL 填 https://你的域名/im/mp/events，加解密选「安全模式」，Token 与 EncodingAESKey 回填这里", "结果走「客服消息」异步推送，需要已认证的服务号（未认证会返回 48001，这里如实报错）"],
    status: (st) => wxStatus(st.wechat_mp) },
  { key: "wecom_bot", grp: "push", icon: "briefcase", name: "企业微信群", sub: "只出不进 · 推送结果",
    fields: [["wecom_bot_webhook", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."]],
    help: ["群里添加「群机器人」，把 webhook 地址粘贴到这里", "任务与定时任务的结果自动推到群里；要双向对话用上面的「企业微信应用」"],
    status: (st) => ((st.wecom || {}).configured ? ["ok", "已配置"] : ["off", "未配置"]) },
  { key: "dingtalk", grp: "push", icon: "pin", name: "钉钉群", sub: "只出不进 · 推送结果",
    fields: [["dingtalk_webhook", "https://oapi.dingtalk.com/robot/send?access_token=..."], ["dingtalk_secret", "加签密钥 SEC...（未选加签则留空）", "password", "opt"]],
    help: ["钉钉群 → 群设置 → 机器人 → 添加「自定义机器人」", "安全设置选「加签」，把 webhook 与加签密钥填到这里"],
    status: (st) => ((st.dingtalk || {}).configured ? ["ok", "已配置"] : ["off", "未配置"]) },
  { key: "webhook", grp: "push", icon: "link", name: "通用 Webhook", sub: "外部工具桥接进来",
    fields: [["webhook_secret", "自定义一个密钥", "password"]],
    help: ["外部工具（微信框架 / 钉钉 outgoing / 快捷指令）POST /im/task 时带这个密钥校验", "微信客服号、小程序、企微「智能助理」等依赖腾讯定向资质，本版不做假连接，用这里桥接"],
    status: (st) => ((st.webhook || {}).secret_set ? ["ok", "已设密钥"] : ["off", "未设密钥"]) },
  { key: "smtp", grp: "mail", icon: "mail", name: "邮件（SMTP）", sub: "AI 把做好的东西发出去 · 每封都要你点头", path: "smtp",
    fields: [["host", "SMTP 服务器，如 smtp.qq.com"], ["port", "端口（留空 = 465）", "", "opt"], ["user", "登录账号（完整邮箱地址）"],
      ["pass", "密码 / 授权码", "password"], ["from", "发件人地址（留空 = 用登录账号）", "", "opt"],
      ["allow_to", "收件人白名单：a@b.com, @公司域名（留空 = 不限）", "", "opt"]],
    test: { url: "/im/smtp/test", ok: (d) => `连上了，以后用 ${d.from} 发信（${d.host}:${d.port}）` },
    help: ["QQ / 163 / Gmail 这类邮箱要先在网页版开「SMTP 服务」，拿到的是一串授权码，不是你登录用的密码",
      "端口留空就是 465（一上来就加密）；服务商只给 587 的话填 587，会自动走 STARTTLS",
      "白名单建议填上：AI 会上网、会读网页，万一被网页里的内容带偏，白名单是最后一道硬闸——不在名单里的地址一个字都发不出去",
      "白名单写法：a@b.com 只放行这一个人；@公司域名.com 或 公司域名.com 放行整个域（含子域）",
      "不管填没填白名单，每封信发出去之前都会把收件人、主题、正文原样弹给你确认，你不点头就不发"],
    status: (st, get) => {
      if (!(st.smtp || {}).configured) return ["off", "未配置"];
      const n = (get("smtp", "allow_to") || "").split(/[,;\s\n]+/).filter(Boolean).length;
      return ["ok", n ? `已配置 · 白名单 ${n} 条` : "已配置 · 不限收件人"];
    } },
  { key: "feishu_me", grp: "lark", icon: "id-card", name: "飞书本人身份", sub: "AI 以你的身份读日历 / 云文档 / 邮件", lark: true, noConn: true,
    help: ["本机装 lark-cli：npx @larksuite/cli@latest install", "用上面飞书卡的 App ID / App Secret 绑定，再扫码授权你本人", "授权后 AI 能用 lark-cli 查你的日历、读写云文档、收发邮件"] },
  { key: "feishu_doc", grp: "lark", icon: "file-text", name: "飞书云文档", sub: "AI 直接把结果写成云文档", path: "feishu", src: "feishu",
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
      <button class="btn-plain" data-act="newapp">${ic("smartphone")} 扫码新建应用</button>
      <span class="d" style="font-size:12px;margin-left:8px">没有现成应用？让本机 lark-cli 替你建一个，建完 App ID 自动填上</span>
      <div data-newapp-qr="${c.key}" style="display:none;margin:8px 0">
        <img alt="新建飞书应用的授权二维码" style="width:176px;height:176px;border-radius:8px;background:#fff;padding:6px;border:1px solid var(--owb-border)">
        <div class="d" style="font-size:12px;margin-top:4px">用飞书扫这个码，或 <a class="link" target="_blank" rel="noopener" data-newapp-link="${c.key}">在浏览器里打开</a>，按提示建好应用即可</div>
      </div>
      <div class="im-r ok-msg" data-newapp-r="${c.key}"></div>
    </div>` : "");
  const bodyHtml = (c) => {
    if (c.qr) return `<div id="ilk-box" style="display:none;margin:4px 0 8px"><img id="ilk-img" alt="微信登录二维码" style="width:176px;height:176px;border-radius:8px;background:#fff;padding:6px;border:1px solid var(--owb-border)"></div><div class="im-r ok-msg" id="ilk-r">还没扫码。点右上角「连接」取二维码</div>${helpHtml(c)}`;
    if (c.lark) return `<div id="fs-qr-body" class="d" style="font-size:13px">检测 lark-cli…</div>${helpHtml(c)}`;
    const groupPolicy = c.groupPolicy ? `<label class="im-group-policy">群聊响应方式
      <select id="im-feishu-group_reply_mode" aria-label="飞书群聊响应方式">
        <option value="mention" ${cfgVal(c, "group_reply_mode") !== "all" ? "selected" : ""}>仅 @ 机器人（推荐）</option>
        <option value="all" ${cfgVal(c, "group_reply_mode") === "all" ? "selected" : ""}>群内所有消息</option>
      </select>
      <small>把机器人拉进群后即可使用。默认只在成员 @ 它时执行，避免把群聊闲话当任务。</small>
    </label>` : "";
    return `${newappHtml(c)}${fieldsHtml(c)}${groupPolicy}${pasteHtml(c)}${c.src ? `<div class="im-src">${keyLink(c.src)}</div>` : ""}<div class="im-r ok-msg" data-r="${c.key}"></div>${helpHtml(c)}`;
  };
  const cardHtml = (c) => `<div class="im-card packed" data-ch="${c.key}">
      <div class="im-card-h" role="button" tabindex="0" aria-expanded="false" data-activate="1" title="点一下展开 / 收起">
        <span class="ic">${ic(c.icon)}</span>
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
    ${sec("发邮件", "AI 把写好的报告、做好的文件直接发到对方邮箱——出门之前一律弹给你过目", grp("mail"))}
    ${sec("飞书增强", "让 AI 以你本人身份操作飞书、直接生成云文档", grp("lark"))}
    ${sec("上下文管理", "IM 会话带多久的历史、什么时候另起一段", `
      <div class="im-card im-card-static packed">
        <div class="im-card-h" role="button" tabindex="0" aria-expanded="false" data-activate="1" title="点一下展开 / 收起"><span class="ic">${ic("timer")}</span><div class="tt"><b>闲置自动开新会话</b><span>太久没聊，下一条不再带旧上下文</span></div><i class="im-ar" aria-hidden="true"></i></div>
        <div class="im-card-b"><div class="im-act">超过 <input id="im-idle" type="number" min="0" max="720" style="width:72px;margin:0" value="${esc(String(im.session_idle_hours ?? 0))}"> 小时没对话就另起一段（0 = 关闭）</div></div>
      </div>
      <div class="im-card im-card-static packed">
        <div class="im-card-h" role="button" tabindex="0" aria-expanded="false" data-activate="1" title="点一下展开 / 收起"><span class="ic">${ic("eraser")} </span><div class="tt"><b>清空 IM 会话记忆</b><span id="im-sess-n">正在数…</span></div><button class="btn-plain im-conn" id="im-sess-clear">清空全部</button><i class="im-ar" aria-hidden="true"></i></div>
        <div class="im-card-b"><div class="d" style="font-size:12px">只清 IM 通道里的对话上下文（飞书 / QQ / 微信各自一段），网页对话和长期记忆不受影响。上下文预算（多长开始截）在 <a class="link" id="im-goto-agent" href="#">智能体设置</a> 里调。</div><div class="im-r ok-msg" id="im-sess-r"></div></div>
      </div>`)}
    <div style="display:flex;align-items:center;gap:10px;margin-top:4px"><button class="btn-brand" id="im-save">保存全部</button><span class="ok-msg" id="im-msg"></span><span class="d" style="font-size:12px;margin-left:auto">其他助理通道：钉钉机器人双向 / Telegram / Slack 都走「通用 Webhook」桥接</span></div>`;

  // ---------- 读回 / 保存 ----------
  const imPayload = () => {
    const out = { feishu: {}, qq: {}, wecom_app: {}, wechat_mp: {}, smtp: {} };
    for (const c of IM_CHANNELS) for (const [f] of c.fields || []) {
      const v = getField(c.key, f);
      if (c.path) out[c.path][f] = v; else out[f] = v;
    }
    const groupMode = pane.querySelector("#im-feishu-group_reply_mode");
    if (groupMode) out.feishu.group_reply_mode = groupMode.value === "all" ? "all" : "mention";
    out.session_idle_hours = +pane.querySelector("#im-idle").value || 0;
    return { im: out };
  };
  const globalMsg = pane.querySelector("#im-msg");
  // kind: true / "err" 红叉，"ok" 绿勾，省略则不带图标（「正在…」这类中间态）
  const say = (c, txt, kind) => {
    const r = c.qr ? pane.querySelector("#ilk-r") : pane.querySelector(`[data-r="${c.key}"]`);
    if (!r) return;
    const err = kind === true || kind === "err";
    setMsg(r, err ? "circle-x" : kind === "ok" ? "circle-check" : "", txt, err ? "err" : kind === "ok" ? "ok" : "");
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
      if (!(await saveSettings(imPayload(), globalMsg))) return say(c, "保存失败", true);
      if (c.test) {
        say(c, "测试中…");
        const d = await fetch(c.test.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c.test.body || {}) })
          .then(r => r.json()).catch((e) => ({ ok: false, error: e.message }));
        if (!d.ok) return say(c, d.error || "测试失败", true);
        say(c, c.test.ok(d), "ok");
      } else say(c, "已保存", "ok");
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
      say(c, e.message, true);
    } finally {
      btn.disabled = false;
      await refreshStatus(false);
    }
  };

  // ---------- 扫码新建应用：让本机 lark-cli 替你在飞书开放平台建一个应用 ----------
  // 单纯「扫码连机器人」在飞书是做不到的（机器人=应用，平台只认 app_id/app_secret）。
  // 但可以扫码把应用**建出来**，凭证由后端直接接管 —— 效果一样：一个字都不用手打。
  let newappPolling = false;
  const newappSay = (c, txt, kind, link) => {
    const r = pane.querySelector(`[data-newapp-r="${c.key}"]`);
    if (!r) return;
    const err = kind === true || kind === "err";
    setMsg(r, err ? "circle-x" : kind === "ok" ? "circle-check" : "", txt, err ? "err" : kind === "ok" ? "ok" : "");
    if (link) {
      r.append(" ");
      const a = document.createElement("a");
      a.className = "link"; a.target = "_blank"; a.rel = "noopener";
      a.href = link; a.innerHTML = "打开凭证页" + ic("arrow-right");
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
        return newappSay(c, (d && d.error) || "起不来，看看本机装没装 lark-cli", true);
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
          newappSay(c, "应用建好了" + (st.app_id ? "（App ID " + st.app_id + "）" : "") + "，凭证已经填进来，长连接正在起", "ok");
          await refreshStatus(false);
          return;
        }
        // 应用建出来了，但 secret 被 lark-cli 锁在系统钥匙串里读不出来 —— App ID 先替你填上，
        // 剩最后一步：去凭证页复制 App Secret 粘进来。不算失败，所以不标红。
        if (st.state === "need_secret") {
          const el = pane.querySelector("#" + inputId(c, "app_id"));
          if (el && st.app_id) el.value = st.app_id;
          if (box) box.style.display = "none";
          newappSay(c, "应用建好了（App ID 已经替你填上）。" + (st.error || ""), "ok", st.console_url || "");
          return;
        }
        if (st.state === "error") {
          if (box) box.style.display = "none";
          return newappSay(c, st.error || "没建成", true);
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
      if (filled.length) setMsg(r, "circle-check", `认出了 ${filled.join(" 和 ")}，已填进上面。核对一下就点右上角「连接」`, "ok");
      else setMsg(r, "circle-x", "没认出凭证。飞书的 App ID 长这样 cli_xxxxxxxx，App Secret 是 32 位字母数字", "err");
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
      setMsg(sessR, "circle-check", `已清空 ${d.cleared} 段会话，下一条 IM 消息从零开始`, "ok");
    } catch (e) { setMsg(sessR, "circle-x", e.message, "err"); }
    loadSess();
  };

  // ---------- 微信扫码：取码 → 轮询状态（服务端一次挂最多 35 秒，回 wait 就接着问） ----------
  let ilkRun = 0; // 每次取码自增，旧轮询看见对不上就自己退出，防止两轮并行
  const ilkC = IM_CHANNELS.find((x) => x.qr);
  const ilkSay = (txt, kind) => say(ilkC, txt, kind);
  const ilkStart = async () => {
    const ilkBox = pane.querySelector("#ilk-box"), ilkImg = pane.querySelector("#ilk-img");
    const run = ++ilkRun;
    ilkBox.style.display = "none";
    ilkSay("正在取二维码…");
    let qrcode;
    try {
      const d = await fetch("/im/wechat/qrcode", { method: "POST" }).then(r => r.json());
      if (!d.ok) return ilkSay(d.error || "取二维码失败", true);
      if (!d.image) return ilkSay("二维码渲染失败（服务端缺 qrcode 依赖）", true);
      qrcode = d.qrcode;
      ilkImg.src = d.image;
      ilkBox.style.display = "";
      ilkSay("请用要当机器人的微信扫码，并在手机上点确认");
    } catch (e) { return ilkSay(e.message, true); }
    for (;;) {
      if (run !== ilkRun) return; // 已经重新取码了，这轮作废
      let d;
      try {
        d = await fetch(`/im/wechat/qrcode-status?qrcode=${encodeURIComponent(qrcode)}`).then(r => r.json());
      } catch (e) { await new Promise(z => setTimeout(z, 2000)); continue; } // 网络抖动不算失败，接着问
      if (run !== ilkRun) return;
      if (!d.ok) return ilkSay(d.error || "轮询失败", true);
      if (d.status === "confirmed") {
        ilkBox.style.display = "none";
        ilkSay(`已连接微信${d.ilink && d.ilink.bot_id ? `（${d.ilink.bot_id}）` : ""}，现在给这个微信号发消息即可下任务`, "ok");
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
