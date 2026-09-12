/**
 * 缓存命中率。agent 每走一步都要把整段上下文重发一遍，真实账本里 prompt 和 completion
 * 是 64:1 —— 这一大坨到底是全价重买还是走了缓存，光看 tokens 总数完全看不出来，
 * 而它才是账单的大头。命中率低说明系统提示词或历史在被反复改动（换模型、改设置、
 * 时间戳精度太细都会打断前缀），值得去看一眼。
 * cachedOf 是「记过这个字段的那些条的 prompt 总量」：老流水没这个字段，不参与计算，
 * 所以这里返回空串而不是「0%」—— 没统计过不等于没命中。
 */
function cacheTxt(x) {
  if (!x || !x.cachedOf) return "";
  return ` · 缓存命中 ${Math.min(100, Math.round((x.cached || 0) / x.cachedOf * 100))}%`;
}

async function renderAccount() {
  mBody.innerHTML = '<div class="ab-empty">加载中…</div>';
  const [d, authState] = await Promise.all([
    fetch("/api/usage").then(r => r.json()).catch(() => null),
    fetch("/api/auth/state").then(r => r.json()).catch(() => ({})),
  ]);
  if (!d) { mBody.innerHTML = '<div class="ab-empty">加载失败（未登录？）</div>'; return; }
  creditsOn = !!authState.credits_enabled;
  currentUser = d.user; renderUserChip();
  const maxT = Math.max(1, ...d.last7.map(x => x.tokens));
  const isAdmin = d.user.role === "admin";
  mBody.innerHTML = `
    <div class="card-item">
      <div class="t">${(() => { const a = avatarBits(d.user.avatar, d.user.username); return `<span class="ava${a.cls ? " " + a.cls : ""}" style="width:22px;height:22px;border-radius:50%;background:var(--wb-brand-grad);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size: 13px;overflow:hidden;vertical-align:-6px">${a.html}</span>`; })()}
        ${esc(displayName(d.user))}（${d.user.role === "admin" ? "管理员" : "成员"}${d.user.nickname ? " · 登录名 " + esc(d.user.username) : ""}）
        <button id="acc-logout" style="float:right;padding:2px 10px;font-size: 13px">退出登录</button>
        <button id="acc-pass" style="float:right;padding:2px 10px;font-size: 13px;margin-right:6px">改密码</button>
        <button id="acc-profile" style="float:right;padding:2px 10px;font-size: 13px;margin-right:6px">改名字 / 头像</button>
      </div>
      <div class="d">${creditsOn
        ? `积分余额 <b style="color: var(--wb-brand-text);font-size:16px">${ic("sparkles")} ${(+d.user.credits).toLocaleString()}</b> · 计费规则：每 1000 tokens 扣 1 积分，命中缓存的部分按 1/10 折算（上游就是这么收的），每次任务至少 1 积分（网页/CLI/IM/定时任务同一本账）`
        : `<b style="color: var(--wb-brand-text)">不限额</b> · 任务想跑多少跑多少，下面的用量只是给你看花了多少 tokens，不会拦人`}</div>
      ${isAdmin ? `${creditsOn ? `<div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <input id="topup-user" placeholder="给谁充（留空=自己）" style="max-width:150px">
        <input id="topup-amt" type="number" placeholder="积分数" style="max-width:110px">
        <button class="btn-brand" id="topup-go" style="padding:6px 14px">充值</button><span class="ok-msg" id="topup-msg"></span>
      </div>` : ""}
      <div class="d" style="margin-top:8px">
        <label style="cursor:pointer"><input type="checkbox" id="credits-on" ${creditsOn ? "checked" : ""} style="vertical-align:-2px"> 开启积分限额</label>
        · 自己一个人用就别开，它拦不住任何真实开销（key 是你的，账单在服务商那边），只会在你干到一半时把任务掐了。
        多人共用一个 key、要给成员定额度时才有用
        <span class="ok-msg" id="credits-on-msg"></span>
      </div>
      <div class="d" style="margin-top:8px">
        <label style="cursor:pointer"><input type="checkbox" id="open-reg" ${authState.open_register ? "checked" : ""} style="vertical-align:-2px"> 允许别人自己注册账号</label>
        · 关着的时候登录页不给注册入口。挂到公网上又开着的话，谁进来都能拿你的 key 跑任务
        <span class="ok-msg" id="open-reg-msg"></span>
      </div>` : ""}
    </div>
    <div class="usage-grid">
      <div class="usage-cell"><div class="n">${d.today.runs}</div><div class="l">今日任务 · ${d.today.tokens.toLocaleString()} tokens${cacheTxt(d.today)}${creditsOn ? ` · ${d.today.credits} 积分` : ""}</div></div>
      <div class="usage-cell"><div class="n">${d.month.runs}</div><div class="l">本月任务 · ${d.month.tokens.toLocaleString()} tokens${cacheTxt(d.month)}${creditsOn ? ` · ${d.month.credits} 积分` : ""}</div></div>
    </div>
    <div class="card-item">
      <div class="t">近 7 天消耗（tokens）</div>
      <div class="usage-bars">${d.last7.map(x => `<div class="b" style="height:${Math.round(x.tokens / maxT * 100)}%" title="${x.day}：${x.tokens.toLocaleString()} tokens · ${x.runs} 次${cacheTxt(x)}${creditsOn ? ` · ${x.credits} 积分` : ""}"><i>${x.day.slice(5)}</i></div>`).join("")}</div>
      <div style="height:16px"></div>
    </div>
    <div class="card-item">
      <div class="t">最近流水${isAdmin ? "（全员）" : ""}</div>
      <div style="overflow-x:auto"><table class="usage-table">
        <tr><th>时间</th><th>类型</th>${isAdmin ? "<th>用户</th>" : ""}<th>来源</th><th>tokens</th>${creditsOn ? "<th>积分</th>" : ""}<th>模型</th></tr>
        ${d.recent.map(e => `<tr>
          <td>${esc((e.ts || "").slice(5, 16).replace("T", " "))}</td>
          <td>${e.kind === "topup" ? ic("wallet") + " 充值" : "任务"}</td>
          ${isAdmin ? `<td>${esc(e.user)}</td>` : ""}
          <td>${e.kind === "topup" ? `by ${esc(e.by || "")}` : esc(SRC_TXT[e.source] || e.source || "")}</td>
          <td${e.kind === "topup" ? "" : ` title="输入 ${(e.prompt || 0).toLocaleString()}（其中缓存命中 ${e.cached != null ? e.cached.toLocaleString() : "未统计"}）· 输出 ${(e.completion || 0).toLocaleString()}"`}>${e.kind === "topup" ? "—" : ((e.prompt || 0) + (e.completion || 0)).toLocaleString()}</td>
          ${creditsOn ? `<td>${e.kind === "topup" ? "+" : "-"}${e.credits}</td>` : ""}
          <td>${esc(e.model || "—")}</td>
        </tr>`).join("") || `<tr><td colspan="7" style="color:var(--wb-text-3)">还没有用量记录</td></tr>`}
      </table></div>
    </div>`;
  document.getElementById("acc-logout").onclick = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    location.reload();
  };
  document.getElementById("acc-profile").onclick = () => renderProfile();
  document.getElementById("acc-pass").onclick = async () => {
    mBody.innerHTML = `<div class="card-item"><div class="t">修改密码</div>
      <input id="pw-old" type="password" placeholder="原密码">
      <input id="pw-new" type="password" placeholder="新密码（至少 6 位）">
      <div style="margin-top:8px"><button class="btn-brand" id="pw-go">确认修改</button> <button id="pw-back" style="padding:6px 14px">返回</button> <span class="ok-msg" id="pw-msg"></span></div></div>`;
    document.getElementById("pw-back").onclick = () => renderAccount();
    document.getElementById("pw-go").onclick = async () => {
      const resp = await fetch("/api/auth/password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old_password: document.getElementById("pw-old").value, new_password: document.getElementById("pw-new").value }),
      });
      const r = await resp.json().catch(() => ({}));
      const msg = document.getElementById("pw-msg");
      if (resp.ok) { setMsg(msg, "circle-check", "已修改", "ok"); setTimeout(() => renderAccount(), 800); }
      else { setMsg(msg, "circle-x", r.error || "修改失败", "err"); }
    };
  };
  const credOn = document.getElementById("credits-on");
  if (credOn) credOn.onchange = async () => {
    const msg = document.getElementById("credits-on-msg");
    const resp = await fetch("/api/auth/credits-enabled", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credits_enabled: credOn.checked }),
    }).catch(() => null);
    const r = resp ? await resp.json().catch(() => ({})) : {};
    if (resp && resp.ok) {
      creditsOn = !!r.credits_enabled;
      setMsg(msg, "circle-check", creditsOn ? "已开启限额" : "已改成不限额", "ok");
      renderUserChip();
      setTimeout(() => renderAccount(), 700); // 整块重画，把余额/充值那些跟着显示或收起来
    } else { credOn.checked = !credOn.checked; setMsg(msg, "circle-x", r.error || "改不动", "err"); }
  };
  const openReg = document.getElementById("open-reg");
  if (openReg) openReg.onchange = async () => {
    const msg = document.getElementById("open-reg-msg");
    const resp = await fetch("/api/auth/open-register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ open_register: openReg.checked }),
    }).catch(() => null);
    const r = resp ? await resp.json().catch(() => ({})) : {};
    if (resp && resp.ok) { setMsg(msg, "circle-check", openReg.checked ? "已开放注册" : "已关闭注册", "ok"); }
    else { openReg.checked = !openReg.checked; setMsg(msg, "circle-x", r.error || "改不动", "err"); }
  };
  const topupGo = document.getElementById("topup-go");
  if (topupGo) topupGo.onclick = async () => {
    const resp = await fetch("/api/credits/topup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: document.getElementById("topup-user").value.trim() || undefined, amount: +document.getElementById("topup-amt").value }),
    });
    const r = await resp.json().catch(() => ({}));
    const msg = document.getElementById("topup-msg");
    if (resp.ok) { setMsg(msg, "circle-check", `${r.username} 余额 ${(+r.balance).toLocaleString()}`, "ok"); setTimeout(() => renderAccount(), 900); }
    else { setMsg(msg, "circle-x", r.error || "充值失败", "err"); }
  };
}

// ================= 登录 / 注册 =================
let authMode = "login"; // login | register
let canRegister = false; // 管理员开了才给注册入口，省得点进去再被拒
function showAuth(setup) {
  authMode = setup ? "register" : "login";
  applyAuthMode(setup);
  document.getElementById("auth-mask").classList.add("show");
  setTimeout(() => document.getElementById("auth-user").focus(), 50);
}
function applyAuthMode(setup) {
  const reg = authMode === "register";
  document.getElementById("auth-title").textContent = setup ? "创建管理员账号" : reg ? "注册" : "登录";
  document.getElementById("auth-sub").textContent = setup
    ? "首次使用：第一个注册的账号就是管理员（能开号、能改全局设置）"
    : reg ? (creditsOn ? "新账号默认为成员（1000 积分）" : "新账号默认为成员") : "登录后使用你自己的任务历史";
  document.getElementById("auth-go").textContent = reg ? "注册并登录" : "登录";
  document.getElementById("auth-alt").style.display = setup || !canRegister ? "none" : "";
  document.getElementById("auth-alt").innerHTML = reg
    ? '已有账号？<a id="auth-switch">去登录</a>'
    : '还没有账号？<a id="auth-switch">注册一个</a>';
  document.getElementById("auth-switch")?.addEventListener("click", () => { authMode = reg ? "login" : "register"; applyAuthMode(false); });
  document.getElementById("auth-err").textContent = "";
}
async function submitAuth() {
  const username = document.getElementById("auth-user").value.trim();
  const password = document.getElementById("auth-pass").value;
  const errEl = document.getElementById("auth-err");
  if (!username || !password) { errEl.textContent = "用户名和密码都要填"; return; }
  const resp = await fetch(authMode === "register" ? "/api/auth/register" : "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }).catch(() => null);
  const d = resp ? await resp.json().catch(() => ({})) : {};
  if (resp && resp.ok) location.reload(); // 带上 cookie 重新初始化整个界面（最省事也最不易漏）
  else errEl.textContent = d.error || "失败了，稍后再试";
}
document.getElementById("auth-go").onclick = submitAuth;
document.getElementById("auth-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAuth(); });
document.getElementById("auth-user").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("auth-pass").focus(); });

async function initAuth() {
  const st = await fetch("/api/auth/state").then(r => r.json()).catch(() => null);
  if (!st) return; // 服务器没起来时不挡界面
  canRegister = !!st.open_register;
  creditsOn = !!st.credits_enabled;
  if (!st.authed) { showAuth(st.users === 0); return; }
  currentUser = st.user;
  renderUserChip();
  // 助理身份要在第一条消息渲染之前就位，否则头像会先闪一下默认值
  assistant = { ...assistant, ...(await fetch("/api/assistant").then(r => r.json()).catch(() => null) || {}) };
  applyAssistantIdentity();
  // 每人一份任务历史：切到带用户名的 key；首个用户继承旧的公共列表
  SESS_KEY = "wb_sessions:" + st.user.username;
  if (!localStorage.getItem(SESS_KEY) && localStorage.getItem("wb_sessions")) {
    localStorage.setItem(SESS_KEY, localStorage.getItem("wb_sessions"));
    localStorage.removeItem("wb_sessions");
  }
  sessions = JSON.parse(localStorage.getItem(SESS_KEY) || "[]");
  renderHistory();
  refreshLanes(); // 登录后服务端才知道你是不是这台机器的主人——终端那条线只对主人可见
  await mergeServerSessions();
  maybeOnboard();
}

/**
 * 把服务端那份任务历史并回侧栏。
 *
 * 侧栏列表一直只存在 localStorage 里，对话本体却在服务端 data/sessions/。于是「清了浏览器缓存 /
 * 换台机器打开 / 换个账号先登进来把公共列表继承走 / 改了用户名」任意一件事，侧栏就空了，
 * 用户看到的是「我以前的任务全没了」——其实一条都没丢。以服务端为准补齐，本地只当缓存。
 *
 * 只补不删：本地有、服务端没有的（刚建还没落盘的新任务）原样留着。
 */
async function mergeServerSessions() {
  let rows;
  try {
    const d = await fetch("/api/sessions").then(r => r.json());
    rows = Array.isArray(d && d.sessions) ? d.sessions : null;
  } catch { return; }
  if (!rows) return; // 老版本服务端没这个接口：维持原来的纯本地行为，不清空任何东西
  const byId = new Map(sessions.map(s => [s.id, s]));
  let added = 0;
  for (const r of rows) {
    const local = byId.get(r.id);
    if (local) { // 标题在服务端会被模型润色过，本地那条是发第一句时截的 24 字
      if (r.title && r.title !== "未命名任务") local.title = r.title;
      if (!local.at && r.at) local.at = r.at;
      if (!local.project && r.project) local.project = r.project;
      if (r.lane) local.lane = r.lane; // 服务端存的那份为准：终端里起的活儿只有它知道
      continue;
    }
    sessions.push({ id: r.id, title: r.title, at: r.at, project: r.project || undefined, lane: r.lane || undefined });
    added++;
  }
  sessions.sort((a, b) => (b.at || 0) - (a.at || 0));
  saveSessions();
  renderHistory();
  if (added) console.log(`[历史] 从服务端补回 ${added} 条本机没有的任务`);
}
initAuth();

// ================= 首次开箱：引导填模型 Key =================
// 没 key 的话，用户发第一条消息才会看到一句上游报错，然后完全不知道该去哪儿修。
// 所以登录之后先拦一道；只看服务端回的布尔值，界面上永远不显示已存的 key 原文。
// 「去哪拿 Key」总表：向导和设置页共用（app-05.js 的模型/搜索/IM 面板也从这儿取）。
// 键 = 接口地址（模型）/ 服务商 id（搜索）/ 通道 key（IM）；值 = 直达「创建 API Key」那一页的地址，别指到首页让人自己找。
// 全走 https + 新窗口（桌面版由 setWindowOpenHandler 交给系统浏览器）。加新渠道时这里必须同步补一条，e2e 有闸门盯着。
const KEY_SOURCES = {
  // 大模型：按 base_url
  "https://api.openai.com/v1": { url: "https://platform.openai.com/api-keys", name: "OpenAI" },
  "anthropic": { url: "https://console.anthropic.com/settings/keys", name: "Anthropic" },
  "https://openrouter.ai/api/v1": { url: "https://openrouter.ai/settings/keys", name: "OpenRouter" },
  "https://ark.cn-beijing.volces.com/api/v3": { url: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey", name: "火山方舟" },
  "https://dashscope.aliyuncs.com/compatible-mode/v1": { url: "https://bailian.console.aliyun.com/?apiKey=1#/api-key", name: "阿里云百炼" },
  "https://dashscope.aliyuncs.com/api/v1": { url: "https://bailian.console.aliyun.com/?apiKey=1#/api-key", name: "阿里云百炼" },
  "https://api.deepseek.com/v1": { url: "https://platform.deepseek.com/api_keys", name: "DeepSeek" },
  "https://open.bigmodel.cn/api/paas/v4": { url: "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys", name: "智谱" },
  "https://api.moonshot.cn/v1": { url: "https://platform.moonshot.cn/console/api-keys", name: "Kimi" },
  "http://localhost:11434/v1": { url: "https://ollama.com/download", name: "Ollama", label: "装 Ollama" },
  // 联网搜索：按服务商 id
  "tavily": { url: "https://app.tavily.com/home", name: "Tavily" },
  "jina": { url: "https://jina.ai/api-dashboard/", name: "Jina" },
  "brave": { url: "https://api-dashboard.search.brave.com/app/keys", name: "Brave" },
  // IM：按通道 key
  "feishu": { url: "https://open.feishu.cn/app", name: "飞书开放平台", label: "去开放平台建应用" },
  "qq": { url: "https://q.qq.com/#/app/bot", name: "QQ 开放平台", label: "去开放平台建机器人" },
  "wecom_app": { url: "https://work.weixin.qq.com/wework_admin/frame#apps", name: "企业微信后台", label: "去管理后台建应用" },
  "wechat_mp": { url: "https://mp.weixin.qq.com/", name: "微信公众平台", label: "去公众平台拿凭证" },
};
/** 一个「去拿 Key ↗」小链接；查不到来源时返回空串，调用方原样拼进去就行 */
function keyLink(id, label) {
  const src = KEY_SOURCES[id];
  if (!src) return "";
  return `<a class="get-key" href="${esc(src.url)}" target="_blank" rel="noopener" title="${esc(src.name)}：新窗口打开">${esc(label || src.label || "去拿 Key")}${ic("arrow-up-right")}</a>`;
}
/** 模型渠道的来源 id：Anthropic 官方没有 base_url，按 provider 认 */
function modelKeySource(m) {
  if (!m) return "";
  if (m.base_url && KEY_SOURCES[m.base_url]) return m.base_url;
  return m.provider === "anthropic" || !m.base_url ? "anthropic" : "";
}
const ONB_TIPS = {
  "https://openrouter.ai/api/v1": "一个 Key 通吃几十家模型，国内可直连，新号有免费额度。",
  "https://api.deepseek.com/v1": "国产、便宜、中文强，适合当日常主力。",
  "https://dashscope.aliyuncs.com/compatible-mode/v1": "阿里云通义千问，控制台开通百炼后即可建 Key。",
  "https://open.bigmodel.cn/api/paas/v4": "智谱 GLM，国内直连。",
  "https://api.moonshot.cn/v1": "月之暗面 Kimi，长文档强。",
  "https://api.openai.com/v1": "OpenAI 官方，国内需要网络代理。",
  "https://ark.cn-beijing.volces.com/api/v3": "火山方舟，豆包 / DeepSeek 都在里面。",
  "anthropic": "Anthropic 官方 Claude，国内需要网络代理。",
};
// 搜索服务商：[Key 占位符, 一句话推荐语]。顺序 = 推荐顺序，Tavily 不用绑卡、免费额度最实在
const ONB_SEARCH = {
  tavily: ["tvly-...", "推荐。专给 AI 用的搜索，注册就送每月免费额度，不用绑卡。"],
  jina: ["jina_...", "国内可直连，注册送免费额度，结果带网页正文。"],
  brave: ["BSA...", "独立索引、隐私友好；有免费档但要绑卡。"],
};
// 多媒体四项的一键预设：[名字, 接口地址, 模型名, 默认音色]，点一下就填好，只剩粘 Key
const ONB_MEDIA_PRESETS = {
  image: [["阿里云百炼 · qwen-image", "https://dashscope.aliyuncs.com/api/v1", "qwen-image"], ["OpenAI · gpt-image-1", "https://api.openai.com/v1", "gpt-image-1"]],
  video: [["阿里云百炼 · 万相", "https://dashscope.aliyuncs.com/api/v1", "wan2.2-t2v-plus"], ["火山方舟 · Seedance", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seedance-1-0-pro-250528"]],
  tts: [["阿里云百炼 · qwen-tts", "https://dashscope.aliyuncs.com/api/v1", "qwen-tts", "Cherry"], ["OpenAI · gpt-4o-mini-tts", "https://api.openai.com/v1", "gpt-4o-mini-tts", "alloy"]],
  vision: [["阿里云百炼 · qwen-vl-max", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-vl-max"], ["OpenAI · gpt-5-mini", "https://api.openai.com/v1", "gpt-5-mini"]],
};
// 四类多媒体能力：填的都是「OpenAI 兼容接口地址 + Key + 模型名」，说明只写一句它能干什么
const ONB_MEDIA = [
  ["image", "image", "生图", "配图、海报、封面", "mi"],
  ["video", "clapperboard", "生视频", "短视频、动态封面", "mv"],
  ["tts", "mic", "语音", "配音、播客旁白", "mt"],
  ["vision", "eye", "看图", "读截图、识别图片里的字", "mvi"],
];
/**
 * 首次开箱向导：五步走完，大脑必配，其余按需。
 *
 * 为什么是向导而不是一张长表单：新用户不知道「要设置哪些 API」，一口气看到十几个输入框只会关掉。
 * 每一步只问一件事、说清楚它是干什么的、能不能跳过；走完给一张能力清单，没配的随时在设置里补。
 * 走完（或大脑已接上时跳过）会记到服务端，下次打开不再弹；「设置 → 关于」里能再打开。
 */
const ONB_STEPS = [
  ["brain", "brain", "大模型"],
  ["search", "search", "联网搜索"],
  ["media", "palette", "图/视频/语音"],
  ["im", "smartphone", "远程指挥"],
  ["done", "sparkles", "完成"],
];
let onbState = null;
// 「本次窗口先跳过」只记在会话存储里：关窗即忘，下次打开还会提醒。存储被禁（file:// / 隐私模式）时退到内存里，别让向导崩掉
let onbSkipMem = false;
function onbSkipFlag(set) {
  try {
    if (set) sessionStorage.setItem("wb_onb_skipped", "1");
    else return onbSkipMem || sessionStorage.getItem("wb_onb_skipped") === "1";
  } catch { /* 存储不可用 */ }
  if (set) onbSkipMem = true;
  return onbSkipMem;
}

async function maybeOnboard() {
  const st = await fetch("/api/onboarding").then(r => r.json()).catch(() => null);
  if (!st || st.error || !st.models) return;
  if (!st.needs_setup && st.seen) return; // 大脑接上了、向导也走完了：不打扰
  if (!st.can_finish) return; // 这是台服务器级的向导，成员走到最后一步也存不下来，别弹
  if (onbSkipFlag()) return; // 本次窗口内跳过一次就别再烦人
  openOnboarding(st);
}

// 设置 → 关于 里「重新打开新手引导」也走这里；传 st 则直接用已拉好的体检表
async function openOnboarding(st) {
  if (!st || !st.models) st = await fetch("/api/onboarding").then(r => r.json()).catch(() => null);
  if (!st || st.error || !st.models) { toast("拿不到配置体检表，服务没起来？"); return; }
  onbState = { st, step: 0, skipped: new Set(), dir: "" };
  renderOnb();
  document.getElementById("onb-mask").classList.add("show");
}
function closeOnboarding() {
  document.getElementById("onb-mask").classList.remove("show");
}
async function onbReload() {
  const st = await fetch("/api/onboarding").then(r => r.json()).catch(() => null);
  if (st && st.models) onbState.st = st;
  return onbState.st;
}
function onbGo(step) {
  onbState.step = Math.max(0, Math.min(ONB_STEPS.length - 1, step));
  renderOnb();
}
function onbHead(title, sub, tag) {
  const cls = tag === "必需" ? "must" : tag === "推荐" ? "rec" : "opt";
  return `<div class="onb-h"><h2>${title}</h2><span class="onb-tag ${cls}">${tag}</span></div><div class="sub">${sub}</div>`;
}
function onbFoot(primary, skipTxt) {
  return `<div class="onb-foot">${skipTxt ? `<a id="onb-skip-step">${skipTxt}</a>` : "<span></span>"}<button class="go" id="onb-go">${primary}</button></div>`;
}
function renderOnb() {
  const { st, step } = onbState;
  const stepsEl = document.getElementById("onb-steps");
  // 第一次打开就能换语言：装完才发现全是中文的话，引导等于白走一遍
  const i18n = typeof I18N !== "undefined" ? I18N : null;
  const langBar = i18n ? `<div class="onb-lang" data-i18n-skip>${Object.entries(i18n.LANGS).map(([v, l]) =>
    `<button type="button" data-lang="${v}" class="${i18n.getLang() === v ? "on" : ""}" aria-pressed="${i18n.getLang() === v}">${l}</button>`).join("")}</div>` : "";
  stepsEl.innerHTML = langBar + ONB_STEPS.map(([k, icon, lb], i) =>
    `<div class="onb-step ${i === step ? "cur" : i < step ? "done" : ""}" data-i="${i}"><i>${ic(i < step ? "check" : icon)}</i><span>${lb}</span></div>`).join("");
  stepsEl.style.flexWrap = "wrap";
  stepsEl.querySelectorAll(".onb-lang button").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); i18n.setLang(b.dataset.lang); renderOnb(); }; });
  // 大脑没接上之前不许在步骤条上乱跳：跳过去也是一步都干不了
  stepsEl.onclick = (e) => {
    const el = e.target.closest(".onb-step");
    if (!el || !st.brain.ok) return;
    onbGo(+el.dataset.i);
  };
  const body = document.getElementById("onb-body");
  const k = ONB_STEPS[step][0];
  if (k === "brain") renderOnbBrain(body);
  else if (k === "search") renderOnbSearch(body);
  else if (k === "media") renderOnbMedia(body);
  else if (k === "im") renderOnbIm(body);
  else renderOnbDone(body);
}

// ---------- 第一步：大模型（必需） ----------
function renderOnbBrain(body) {
  const { st } = onbState;
  const engs = st.engines || [];
  const installed = engs.filter(e => e.installed);
  body.innerHTML = `
    ${onbHead("先接上一个大模型", "OpenWorkBuddy 自己不含模型。填一家服务商的 API Key，或者直接用你电脑上已登录的 Claude Code / Codex。", "必需")}
    ${st.brain.ok ? `<div class="onb-ok" id="onb-brain-ok">${ic("circle-check")} 已接上 <b>${esc(st.brain.name)}</b>${st.brain.model ? ` · ${esc(st.brain.model)}` : ""}<a id="onb-brain-change">换一个</a></div>` : ""}
    <div id="onb-brain-form" ${st.brain.ok ? "hidden" : ""}>
      <div class="onb-seg" id="onb-seg">
        <button type="button" class="on" data-v="cloud">${ic("cloud")} 云端 API</button>
        <button type="button" data-v="local">${ic("laptop")} 本机 Claude Code / Codex${installed.length ? "" : "（未装）"}</button>
      </div>
      <div id="onb-cloud">
        <label class="onb-lb">服务商</label>
        <select id="onb-model">${st.models.map(m =>
          `<option value="${esc(m.name)}" data-url="${esc(m.base_url)}" data-local="${m.local ? 1 : 0}">${esc(m.name)} · ${esc(m.model)}${m.has_key ? "（已配）" : ""}</option>`).join("")}</select>
        <div class="onb-tip" id="onb-tip"></div>
        <label class="onb-lb">API Key</label>
        <input id="onb-key" type="password" placeholder="粘贴 API Key" autocomplete="off" spellcheck="false">
      </div>
      <div id="onb-local" hidden>
        ${installed.length
          ? installed.map((e, i) => `<label class="onb-radio"><input type="radio" name="onb-eng" value="${esc(e.id)}" ${i === 0 ? "checked" : ""}><b>${esc(e.label)}</b><span>${esc(e.version || "已安装")}</span></label>`).join("")
          : `<div class="onb-tip">${engs.length ? engs.map(e => `${esc(e.label)}：未安装${e.install ? `，${esc(e.install)}` : ""}`).join("<br>") : "没检测到本机 CLI"}</div>`}
        <div class="onb-tip">走本机 CLI 不需要 API Key，用的是它自己的登录；我会真发一句话过去确认它能答。</div>
      </div>
      <div class="err" id="onb-err"></div>
    </div>
    ${onbFoot(st.brain.ok ? "下一步" : "验活并继续", st.brain.ok ? "" : "先跳过，我一会儿去设置里填")}`;

  const form = body.querySelector("#onb-brain-form");
  const seg = body.querySelector("#onb-seg");
  const sel = body.querySelector("#onb-model");
  const keyEl = body.querySelector("#onb-key");
  const tipEl = body.querySelector("#onb-tip");
  const err = body.querySelector("#onb-err");
  const go = body.querySelector("#onb-go");
  let mode = "cloud";
  seg.onclick = (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    mode = b.dataset.v;
    seg.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    body.querySelector("#onb-cloud").hidden = mode !== "cloud";
    body.querySelector("#onb-local").hidden = mode !== "local";
    err.textContent = "";
  };
  // 默认选中第一个还没配 key 的云端模型，用户十有八九就是要配它
  const first = st.models.find(m => !m.has_key && !m.local) || st.models[0];
  if (first) sel.value = first.name;
  const syncTip = () => {
    const opt = sel.selectedOptions[0];
    const local = !!opt && opt.dataset.local === "1";
    const url = opt ? opt.dataset.url : "";
    const srcId = KEY_SOURCES[url] ? url : (url ? "" : "anthropic");
    tipEl.innerHTML = local
      ? `本地模型不需要 Key，确认 Ollama 已经在跑就行。${keyLink(url)}`
      : `${ONB_TIPS[srcId] || ONB_TIPS[url] || "去这家服务商的控制台拿 API Key。"} ${keyLink(srcId)}`;
    keyEl.disabled = local;
    keyEl.placeholder = local ? "本地模型不用填" : "粘贴 API Key";
  };
  sel.onchange = syncTip;
  syncTip();
  const chg = body.querySelector("#onb-brain-change");
  if (chg) chg.onclick = () => { form.hidden = false; go.textContent = "验活并继续"; chg.closest(".onb-ok").hidden = true; setTimeout(() => keyEl.focus(), 30); };

  go.onclick = async () => {
    if (form.hidden) return onbGo(1);
    err.textContent = "";
    go.disabled = true;
    try {
      if (mode === "cloud") {
        go.textContent = "正在验活…（发一条真实请求，可能要十几秒）";
        const r = await fetch("/api/onboarding", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: sel.value, api_key: keyEl.value.trim() }),
        }).then(r => r.json()).catch(() => ({ ok: false, error: "请求失败，服务没起来？" }));
        if (!r.ok) { err.textContent = r.error || "验活没通过"; return; }
        toast(`已接上 ${r.active_model}`, "circle-check");
      } else {
        const picked = body.querySelector("input[name=onb-eng]:checked");
        if (!picked) { err.textContent = "本机没装 Claude Code / Codex，先装好并登录，或者改用云端 API"; return; }
        go.textContent = "正在连本机 CLI…（真跑一句话，可能要几十秒）";
        const t = await fetch("/api/engines/test", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: picked.value }),
        }).then(r => r.json()).catch(() => ({ ok: false, why: "请求失败" }));
        if (!t.ok) { err.textContent = (t.why || t.error || "连不上") + (t.hint ? `。${t.hint}` : ""); return; }
        const s = await fetch("/api/settings", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent: { engine: picked.value } }),
        }).then(r => r.json()).catch(() => ({ error: "保存失败" }));
        if (s && s.error) { err.textContent = s.error; return; }
        toast(`已切到本机 ${picked.value}`, "circle-check");
      }
      refreshSettingsCache(); // 输入卡片右下角的模型名跟着刷新
      await onbReload();
      onbGo(1);
    } finally {
      go.disabled = false;
      if (!go.isConnected) return;
      go.textContent = form.hidden ? "下一步" : "验活并继续";
    }
  };
  const skip = body.querySelector("#onb-skip-step");
  if (skip) skip.onclick = () => {
    onbSkipFlag(true);
    closeOnboarding();
    toast("跳过了。随时可以在 设置 → 模型 里补上 API Key");
  };
  setTimeout(() => { if (!form.hidden) keyEl.focus(); }, 60);
}

// ---------- 第二步：联网搜索（推荐） ----------
function renderOnbSearch(body) {
  const { st } = onbState;
  const sc = st.search || {};
  body.innerHTML = `
    ${onbHead("联网搜索", "让它能查资料、看新闻、核对事实。不填也能用免费的 DuckDuckGo，但结果一般、国内经常连不上。", "推荐")}
    ${sc.has_key ? `<div class="onb-ok">${ic("circle-check")} 已配 <b>${esc(sc.provider)}</b></div>` : ""}
    <label class="onb-lb">搜索服务商</label>
    <select id="onb-sp">
      <option value="tavily">Tavily（推荐 · 免费额度 · 不用绑卡）</option>
      <option value="jina">Jina（国内直连 · 免费额度）</option>
      <option value="brave">Brave Search（要绑卡）</option>
    </select>
    <div class="onb-tip" id="onb-sp-tip"></div>
    <label class="onb-lb">API Key</label>
    <input id="onb-sp-key" type="password" autocomplete="off" spellcheck="false">
    <div class="err" id="onb-err"></div>
    ${onbFoot(sc.has_key ? "下一步" : "保存并测试", "先跳过，用免费的 DuckDuckGo")}`;
  const sel = body.querySelector("#onb-sp");
  const keyEl = body.querySelector("#onb-sp-key");
  const tip = body.querySelector("#onb-sp-tip");
  const err = body.querySelector("#onb-err");
  const go = body.querySelector("#onb-go");
  sel.value = sc.provider || "jina";
  const sync = () => { const [ph, t] = ONB_SEARCH[sel.value] || ["", ""]; keyEl.placeholder = ph; tip.innerHTML = `${t} ${keyLink(sel.value)}`; };
  sel.onchange = sync;
  sync();
  go.onclick = async () => {
    const key = keyEl.value.trim();
    if (!key) { if (sc.has_key) return onbGo(2); err.textContent = "没填 Key。不想填就点「先跳过」"; return; }
    err.textContent = "";
    go.disabled = true;
    go.textContent = "保存并测试中…";
    try {
      const ok = await saveSettings({ search: { provider: sel.value, [sel.value + "_key"]: key } });
      if (!ok) { err.textContent = lastSaveError || "保存失败"; return; } // 服务端说了原因（如「归平台管理员管」）就别用四个字盖掉
      const r = await fetch("/api/search/test").then(x => x.json()).catch(() => ({ ok: false, error: "请求失败" }));
      if (!r.ok) { err.textContent = r.error || "测试失败"; return; }
      toast(`${r.provider} 可用`, "circle-check");
      await onbReload();
      onbGo(2);
    } finally {
      go.disabled = false;
      if (go.isConnected) go.textContent = sc.has_key ? "下一步" : "保存并测试";
    }
  };
  body.querySelector("#onb-skip-step").onclick = () => { onbState.skipped.add("search"); onbGo(2); };
}

// ---------- 第三步：生图 / 视频 / 语音 / 看图（可选） ----------
function renderOnbMedia(body) {
  const { st } = onbState;
  const md = st.media || {};
  body.innerHTML = `
    ${onbHead("生图 · 视频 · 语音 · 看图", "按需开通，都不填也不影响聊天和办公。每项只要一个 OpenAI 兼容的接口地址 + Key + 模型名。", "可选")}
    <div class="onb-rows" id="onb-media">${ONB_MEDIA.map(([k, icon, name, use]) => `
      <div class="onb-row" data-kind="${k}">
        <div class="onb-row-h"><i class="ic">${ic(icon)}</i><div class="tt"><b>${name}</b><span>${use}</span></div>
          <span class="onb-chip ${md[k] ? "ok" : ""}">${md[k] ? "已配" : "未配"}</span>
          <button type="button" class="btn-plain onb-fill" data-kind="${k}">${md[k] ? "修改" : "填写"}</button></div>
        <div class="onb-row-b" hidden>
          <div class="onb-presets">${(ONB_MEDIA_PRESETS[k] || []).map(([nm, base, model, voice]) => `<button type="button" class="onb-preset" data-base="${esc(base)}" data-model="${esc(model)}" data-voice="${esc(voice || "")}">${esc(nm)}</button>`).join("")}<span class="onb-tip onb-preset-src"></span></div>
          <input data-f="base_url" placeholder="接口地址（如 https://api.openai.com/v1）">
          <input data-f="api_key" type="password" placeholder="API Key" autocomplete="off">
          <input data-f="model" placeholder="模型名">
          ${k === "tts" ? '<input data-f="voice" placeholder="默认音色（可空）">' : ""}
          <div class="onb-act"><button type="button" class="btn-brand onb-save" data-kind="${k}">保存</button><span class="err"></span></div>
        </div>
      </div>`).join("")}</div>
    ${onbFoot("下一步", "都先不填")}`;
  body.querySelector("#onb-media").onclick = async (e) => {
    const fill = e.target.closest(".onb-fill");
    if (fill) {
      const b = fill.closest(".onb-row").querySelector(".onb-row-b");
      b.hidden = !b.hidden;
      if (!b.hidden) b.querySelector("input").focus();
      return;
    }
    const preset = e.target.closest(".onb-preset");
    if (preset) {
      // 一键填地址 + 模型（音色有默认就一并填），旁边亮出这家的「去拿 Key」；Key 本身还得用户自己粘
      const row = preset.closest(".onb-row");
      const set = (f, v) => { const i = row.querySelector(`input[data-f=${f}]`); if (i && v) i.value = v; };
      set("base_url", preset.dataset.base); set("model", preset.dataset.model); set("voice", preset.dataset.voice);
      row.querySelectorAll(".onb-preset").forEach(b => b.classList.toggle("on", b === preset));
      row.querySelector(".onb-preset-src").innerHTML = keyLink(preset.dataset.base);
      row.querySelector("input[data-f=api_key]").focus();
      return;
    }
    const save = e.target.closest(".onb-save");
    if (!save) return;
    const row = save.closest(".onb-row");
    const kind = save.dataset.kind;
    const err = row.querySelector(".err");
    const patch = {};
    row.querySelectorAll("input[data-f]").forEach(i => { patch[i.dataset.f] = i.value.trim(); });
    if (!patch.base_url || !patch.api_key) { err.textContent = "接口地址和 Key 都要填"; return; }
    err.textContent = "";
    save.disabled = true;
    const ok = await saveSettings({ media: { [kind]: patch } });
    save.disabled = false;
    if (!ok) { err.textContent = lastSaveError || "保存失败"; return; }
    const chip = row.querySelector(".onb-chip");
    chip.textContent = "已配";
    chip.classList.add("ok");
    row.querySelector(".onb-fill").textContent = "修改";
    row.querySelector(".onb-row-b").hidden = true;
    (onbState.st.media = onbState.st.media || {})[kind] = true;
  };
  body.querySelector("#onb-go").onclick = () => onbGo(3);
  body.querySelector("#onb-skip-step").onclick = () => { onbState.skipped.add("media"); onbGo(3); };
}

// ---------- 第四步：远程指挥（可选） ----------
function renderOnbIm(body) {
  const { st } = onbState;
  const n = (st.im || {}).configured || 0;
  body.innerHTML = `
    ${onbHead("远程指挥", "手机上在飞书 / 微信 / QQ / 企业微信里 @它就能下任务，跑完结果推回聊天。凭证在「助理设置」里按卡片填，等用顺手了再来也不迟。", "可选")}
    <div class="onb-rows">
      <div class="onb-row"><div class="onb-row-h"><i class="ic">${ic("smartphone")} </i><div class="tt"><b>IM 通道</b><span>飞书 · 微信 · QQ · 企业微信 · 钉钉 · Webhook</span></div>
        <span class="onb-chip ${n ? "ok" : ""}">${n ? `已配 ${n} 个` : "未配"}</span>
        <button type="button" class="btn-plain" id="onb-im-open">去助理设置</button></div>
        <div class="onb-row-b onb-im-src">先去各家开放平台建个应用拿凭证：${["feishu", "qq", "wecom_app", "wechat_mp"].map(k => keyLink(k, KEY_SOURCES[k].name)).join("")}</div></div>
    </div>
    ${onbFoot("下一步", "先不接")}`;
  body.querySelector("#onb-im-open").onclick = async () => {
    // 去填凭证要关掉向导；大脑已接上就顺手记成「走完」，别等人回来再弹一遍
    await finishOnb({ silent: true });
    openModal("settings", "im");
  };
  body.querySelector("#onb-go").onclick = () => onbGo(4);
  body.querySelector("#onb-skip-step").onclick = () => { onbState.skipped.add("im"); onbGo(4); };
}

// ---------- 第五步：完成 ----------
function renderOnbDone(body) {
  const { st, skipped } = onbState;
  const md = st.media || {};
  const mediaN = ONB_MEDIA.filter(([k]) => md[k]).length;
  const imN = (st.im || {}).configured || 0;
  const row = (icon, name, ok, txt, warn) => `<div class="onb-row"><div class="onb-row-h"><i class="ic">${ic(icon)}</i><div class="tt"><b>${name}</b><span>${txt}</span></div><span class="onb-chip ${ok ? "ok" : warn ? "warn" : ""}">${ok ? "✓" : warn ? "未配" : "跳过"}</span></div></div>`;
  body.innerHTML = `
    ${onbHead("都齐了", "这是它现在的能力清单。没配的随时到 设置 里补，这个向导在 设置 → 关于 里还能再打开。", "完成")}
    <div class="onb-rows" id="onb-sum">
      ${row("brain", "大模型", st.brain.ok, st.brain.ok ? `${esc(st.brain.name)}${st.brain.model ? " · " + esc(st.brain.model) : ""}` : "还没接上", true)}
      ${row("search", "联网搜索", st.search.has_key, st.search.has_key ? esc(st.search.provider) : "用免费 DuckDuckGo 顶着", !skipped.has("search"))}
      ${row("palette", "图 / 视频 / 语音 / 看图", mediaN > 0, mediaN ? `${mediaN} / ${ONB_MEDIA.length} 项已配` : "都没配", !skipped.has("media"))}
      ${row("smartphone", "远程指挥", imN > 0, imN ? `${imN} 个通道已配` : "没接 IM", !skipped.has("im"))}
    </div>
    <label class="onb-lb">工作目录（成果文件都放这儿）</label>
    <input id="onb-dir" placeholder="${esc(st.workspace_dir || "留空就用默认目录")}">
    <div class="err" id="onb-err"></div>
    ${onbFoot("开始使用", "先跳过")}`;
  body.querySelector("#onb-go").onclick = () => finishOnb({ dir: body.querySelector("#onb-dir").value.trim() });
  // 最后一步以前只有一颗「开始使用」。它一旦失败（没权限、服务端报错），整块全屏遮罩就没有出口了——
  // 没有 ✕、Escape 也不管，刷新还照弹。留一条「先跳过」，这一程就总能走出去。
  body.querySelector("#onb-skip-step").onclick = () => { onbSkipFlag(true); closeOnboarding(); };
}

async function finishOnb({ dir, silent } = {}) {
  const st = onbState.st;
  if (!st.brain.ok) {
    // 大脑没接上就没法「走完」，服务端也不会记；只在本次窗口内不再弹
    onbSkipFlag(true);
    closeOnboarding();
    if (!silent) toast("还没接上大模型，随时在 设置 → 模型 里补");
    return false;
  }
  const r = await fetch("/api/onboarding/done", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skipped: [...onbState.skipped], workspace_dir: dir || undefined }),
  }).then(r => r.json()).catch(() => ({ ok: false, error: "请求失败" }));
  if (!r.ok) {
    const err = document.getElementById("onb-err");
    if (err) err.textContent = r.error || "保存失败";
    return false;
  }
  closeOnboarding();
  if (!silent) toast("配好了，开始干活吧", "circle-check");
  refreshSettingsCache(); // 工作目录名跟着刷新
  return true;
}

// ================= 主区页面视图（助理 / 专家广场 / 模板库，都占主区而不是弹窗） =================
// assistViewOn 保留原名：全站多处用它判断"当前不是在聊天"，改名会牵一大片。
let assistViewOn = false;
let pageKind = null;
let assistTimer = null;
const PAGE_VIEWS = {
  assist: { icon: "bot", title: "助理模式", keepInput: true, render: () => renderAssistPage() },
  hub: { icon: "puzzle", title: "专家 · 技能 · 连接器", wide: true, render: () => renderHubPage() },
  prompts: { icon: "book-open-text", title: "参考模板库", wide: true, render: () => renderPromptPage() },
  proj: { icon: "folder", title: "项目", wide: true, render: () => renderProjPage() },
  autom: { icon: "clock", title: "自动化", wide: true, render: () => renderAutomPage() },
  lib: { icon: "book", title: "资料库", wide: true, render: () => renderLibPage() },
  eval: { icon: "flask-conical", title: "评测", wide: true, render: () => renderEvalPage() },
};
function openPageView(kind) {
  const v = PAGE_VIEWS[kind];
  if (!v) return;
  if (pageKind === kind) { v.render(); return; } // 同页重进 = 刷新内容
  if (assistTimer) { clearInterval(assistTimer); assistTimer = null; }
  assistViewOn = true;
  pageKind = kind;
  inAssistMode = kind === "assist";
  sessionId = null;
  pendingModel = defaultPendingModel();
  // 助理模式的模型选择存在配置里，进页面时读回来。模型已经从列表里删掉了就退回全局默认——
  // 标签跟着一起退，不能标签还写着它、真跑起来却是别的
  if (inAssistMode) {
    const am = settingsCache && settingsCache.assist_model;
    assistModel = am && (settingsCache.models || []).some(m => m.name === am) ? am : undefined;
  }
  updateModelLabel();
  renderGoalCard();
  // 这里必须 innerHTML：图标是内联 svg，textContent 会把标签当字面量打出来
  document.getElementById("session-title").innerHTML = ic(v.icon) + " " + esc(v.title);
  document.querySelector(".input-wrap").style.display = v.keepInput ? "" : "none";
  if (kind === "assist") inputEl.placeholder = "直接给助理发消息，和 IM 里 @它 一样，任务在本机执行…";
  renderHistory();
  document.querySelectorAll(".side-nav .item").forEach(el => el.classList.toggle("active", el.dataset.view === kind || (kind === "assist" && el.id === "ab-head")));
  chatCol.classList.toggle("wide-page", !!v.wide);
  chatCol.innerHTML = '<div class="assist-page" id="assist-page"></div>';
  v.render();
}
function openAssistView() {
  if (pageKind === "assist") return;
  openPageView("assist");
  assistTimer = setInterval(async () => {
    if (pageKind !== "assist" || !document.getElementById("im-feed")) { clearInterval(assistTimer); assistTimer = null; return; }
    renderAssistFeed(await fetch("/im/log").then(r => r.json()).catch(() => []));
    updateAssistLive();
  }, 5000);
}
function closeAssistView() {
  if (!assistViewOn) return;
  assistViewOn = false;
  pageKind = null;
  inAssistMode = false;
  updateModelLabel(); // 离开助理页，标签立刻换回这个对话自己的模型
  if (assistTimer) { clearInterval(assistTimer); assistTimer = null; }
  document.querySelectorAll(".side-nav .item.active").forEach(el => el.classList.remove("active"));
  chatCol.classList.remove("wide-page");
  document.querySelector(".input-wrap").style.display = "";
  setMode(currentMode); // 还原当前模式的输入提示语
}
async function renderAssistPage() {
  const page = document.getElementById("assist-page");
  if (!page) return;
  const [s, log] = await Promise.all([
    fetch("/im/status").then(r => r.json()).catch(() => null),
    fetch("/im/log").then(r => r.json()).catch(() => []),
  ]);
  if (!s) { page.innerHTML = '<div class="ab-empty">状态读取失败</div>'; return; }
  const f = s.feishu;
  const fOk = f.configured && f.ws.state === "connected";
  const q = s.qq || { configured: false, state: "off" };
  const qOk = q.configured && q.state === "connected";
  // 微信侧靠腾讯回调，本地探不了活，只报配置齐不齐
  const wxChip = (c = {}) => !c.configured ? ["", "未配置"] : !c.callback_ready ? ["err", "缺回调配置"] : ["ok", "等腾讯回调"];
  const il = s.wechat_ilink || { configured: false, state: "off" };
  const ilOk = il.configured && il.state === "connected";
  const chip = (icon, name, cls, st) =>
    `<span class="im-chip"><span class="dot ${cls}"></span>${ic(icon)} ${name}${st ? " · " + st : ""}</span>`;
  // 官方的顶栏只列「已连接」的通道，没配的不刷存在感（要配去齿轮里配）
  const rows = [
    ["bird", "飞书", f.configured, fOk, WS_STATE_TXT[f.ws.state] || f.ws.state],
    ["message-circle", "QQ", q.configured, qOk, WS_STATE_TXT[q.state] || q.state],
    ["message-square", "微信", il.configured, ilOk, !il.configured ? "未扫码" : WS_STATE_TXT[il.state] || il.state],
    ["building-2", "企微应用", (s.wecom_app || {}).configured, wxChip(s.wecom_app)[0] !== "err" && (s.wecom_app || {}).configured, wxChip(s.wecom_app)[1]],
    ["megaphone", "公众号", (s.wechat_mp || {}).configured, wxChip(s.wechat_mp)[0] !== "err" && (s.wechat_mp || {}).configured, wxChip(s.wechat_mp)[1]],
    ["briefcase", "企微群推送", s.wecom.configured, s.wecom.configured, "推送已配"],
  ];
  const conn = rows.filter((r) => r[2]);
  page.innerHTML = `
    <div class="im-head">
      <div class="im-strip" style="flex:1;border:0;padding:0;background:none">
        <b style="color:var(--wb-text-2);font-weight:500">已连接：</b>
        ${conn.length
          ? conn.map(([icon, nm, _c, ok, st]) => chip(icon, nm, ok ? "ok" : "err", ok ? "" : st)).join("")
          : '<span style="color:var(--wb-text-3)">还没有连接任何 IM 通道</span>'}
      </div>
      <div class="picker" id="im-model-picker">
        <button class="btn-plain" id="im-model-btn" title="助理页发消息用哪个模型（飞书 / QQ 等远程消息仍按全局默认跑）">${ic("sparkles")}<span id="im-model-label">模型</span>${ic("chevron-down")}</button>
        <div class="picker-menu down" id="im-model-menu"></div>
      </div>
      ${canOpenOnHost() ? `<button class="btn-plain" id="im-open-ws">${ic("folder-open")} 打开所在文件夹</button>` : ""}
      <button class="btn-plain" id="im-cfg">${ic("settings")} 设置</button>
    </div>
    <div class="im-feed" id="im-feed"></div>
    <div style="text-align:center;color:var(--wb-text-3);font-size: 13px;margin-top:8px">下方输入框直接对话，和在飞书/QQ/微信里 @机器人 一样，任务在这台电脑上执行。微信走扫码登录；企微应用与公众号得有公网 HTTPS 回调地址才能收消息。</div>`;
  setupPicker("im-model-btn", "im-model-menu");
  updateModelLabel(); // 顶栏每次重画都是新元素，标签和菜单当场填上
  page.querySelector("#im-cfg").onclick = () => openModal("settings", "im");
  const imWs = page.querySelector("#im-open-ws");
  if (imWs) imWs.onclick = () => openWorkspaceOnHost(); // 以前这里 fetch 完不接结果：403 之后按钮点了一声不吭
  renderAssistFeed(log);
}
// 助理模式下底部输入框发的消息走 local 通道（与 IM 消息同一条会话流），不新建任务。
// 连发多条时排队串行：两条并发 runTask 会交叉写同一份会话历史
let assistChain = Promise.resolve();
function sendAssistLocal(text) {
  // 模型在按下发送这一刻就定死：排队等前一条跑完期间用户可能已经离开助理页或又改了选择，
  // 到时候再读就跟他发的时候看到的标签对不上了
  const model = currentSessModel() || null;
  assistChain = assistChain.then(() => doAssistLocal(text, model)).catch(() => {});
  return assistChain;
}
/** IM 面板里助理那一侧的头像。以前写死 🤖：用户在设置里改了头像，聊天页变了这里还是机器人。 */
function imBotAva() {
  const b = avatarBits(assistant.avatar, assistant.name);
  return `<div class="im-ava${b.cls ? " " + b.cls : ""}">${b.html}</div>`;
}
async function doAssistLocal(text, model) {
  const feed = document.getElementById("im-feed");
  if (feed) {
    feed.insertAdjacentHTML("beforeend",
      `<div class="im-row usr"><div class="im-col" style="text-align:right"><div class="m">本地 · 用户</div><div class="im-b usr">${esc(text)}</div></div><div class="im-ava">${ic("user")} </div></div>` +
      `<div class="im-row bot" id="im-pending">${imBotAva()}<div class="im-col"><div class="im-b bot">执行中…</div></div></div>`);
    feed.scrollTop = feed.scrollHeight;
  }
  // 等结果期间把「执行中…」气泡变成实时进度（第几步、在用哪个工具），跟飞书状态消息同一份文案
  const liveT = setInterval(async () => {
    const el = document.querySelector("#im-pending .im-b");
    if (!el) return;
    const p = await fetch("/im/progress").then(r => r.json()).catch(() => null);
    if (p && p.local_assist && p.local_assist.text) setMsg(el, "hourglass", p.local_assist.text);
  }, 1500);
  try {
    // 模型标签上显示的是哪个就真用哪个：以前这里不带 model，助理页选了模型也是白选，
    // 跑的还是全局默认——标签说一套、实际跑一套，属于静默换模型
    await fetch("/im/local", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text, model: model || null }) });
  } catch {}
  clearInterval(liveT);
  document.getElementById("im-pending")?.remove();
  const fresh = await fetch("/im/log").then(r => r.json()).catch(() => []);
  const f2 = document.getElementById("im-feed");
  if (f2) { f2._n = -1; renderAssistFeed(fresh); f2.scrollTop = f2.scrollHeight; }
}
// 远程会话（飞书等）有任务在跑时，助理页尾部挂一行实时进度——不用翻手机也知道它在干嘛
async function updateAssistLive() {
  const feed = document.getElementById("im-feed");
  if (!feed) return;
  const p = await fetch("/im/progress").then(r => r.json()).catch(() => null);
  const remote = p ? Object.entries(p).filter(([k, v]) => k !== "local_assist" && v && v.text) : [];
  let el = document.getElementById("im-remote-live");
  if (!remote.length) { el?.remove(); return; }
  // 这行最后是塞进 textContent 的，只能是纯文字，别在这儿放图标
  const CH = { feishu: "飞书", qq: "QQ", wechat_ilink: "微信", wecom_app: "企业微信", webhook: "Webhook" };
  const txt = remote.map(([k, v]) => `${CH[v.channel] || v.channel || k} · ${v.text}`).join("；");
  if (!el) {
    feed.insertAdjacentHTML("beforeend", `<div class="im-row bot" id="im-remote-live"><div class="im-ava">${ic("hourglass")} </div><div class="im-col"><div class="im-b bot" style="color:var(--wb-text-2)"></div></div></div>`);
    el = document.getElementById("im-remote-live");
    if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120) feed.scrollTop = feed.scrollHeight;
  }
  el.querySelector(".im-b").textContent = "远程任务执行中 · " + txt;
}
function renderAssistFeed(log) {
  const feed = document.getElementById("im-feed");
  if (!feed) return;
  const CH_TXT = { feishu: "飞书", qq: "QQ", wechat_ilink: "微信", wecom_app: "企业微信", wechat_mp: "公众号", wecom: "企业微信", webhook: "Webhook", local: "本地" };
  const CH_ICON = { feishu: "bird", qq: "message-circle", wechat_ilink: "message-square", wecom_app: "building-2", wechat_mp: "megaphone", local: "laptop" };
  const n = (log || []).length;
  if (feed._n === n) return; // 没有新消息就不重绘，避免打断用户滚动/选中
  feed._n = n;
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  feed.innerHTML = n
    ? log.slice().reverse().map(m => {
        if (m.dir === "error") return `<div class="im-b error">${ic("triangle-alert")} ${esc(m.text)}</div>`;
        const meta = `${CH_TXT[m.channel] || m.channel} · ${m.dir === "in" ? "用户" : "助理"} · ${m.ts.slice(11, 19)}`;
        if (m.dir === "in") {
          return `<div class="im-row usr"><div class="im-col" style="text-align:right"><div class="m">${meta}</div><div class="im-b usr">${esc(m.text)}</div></div><div class="im-ava">${ic(CH_ICON[m.channel] || "link")}</div></div>`;
        }
        return `<div class="im-row bot">${imBotAva()}<div class="im-col"><div class="m">${meta}</div><div class="im-b bot a-text">${renderMd(m.text)}</div></div></div>`;
      }).join("")
    : '<div class="ab-empty">还没有对话。直接在下方输入框发条消息，或在飞书/微信里 @机器人。</div>';
  if (atBottom || feed._first === undefined) { feed.scrollTop = feed.scrollHeight; feed._first = 1; }
}


// ================= 项目页（主区：卡片广场 + 模板 + 新建/编辑弹窗） =================
// 官方 WorkBuddy 的「项目」不只是切目录：一个项目自带指令（背景/规范）和挂载的专家/技能/连接器。
// 指令会真的进系统提示词（服务端 projectContext），不是摆设。
const PROJ_TEMPLATES = [
  { icon: "clipboard-list", tt: "产品需求全流程", dd: "从需求规划、PRD 到研发测试验收", ins: "这是一个产品研发项目。输出遵守：需求先写用户故事和验收标准；PRD 用「背景/目标/方案/边界/里程碑」结构；技术方案要列出取舍理由；每个交付物开头放一段 3 句话内的摘要。" },
  { icon: "bug", tt: "Bug 跟踪/测试验收", dd: "持续跟踪 Bug，统一测试用例和验收", ins: "这是一个测试与质量项目。报 Bug 必须带：复现步骤、期望结果、实际结果、影响范围、严重级别（P0-P3）。测试用例用表格：编号/前置条件/步骤/期望。验收结论只有「通过/不通过+原因」两种，不许写「基本可用」。" },
  { icon: "package", tt: "项目交付", dd: "管理客户需求、计划、风险和周报", ins: "这是一个对客户的交付项目。所有对外文档开头都要有结论摘要；周报固定三段：本周进展/风险与阻塞/下周计划；风险必须写清楚影响和应对，不许只列现象；涉及排期变化要显式标出来。" },
  { icon: "megaphone", tt: "内容营销", dd: "选题、成稿、多平台分发一条线", ins: "这是一个内容营销项目。选题先给出目标人群和钩子；正文口语化、短句、多分段；每篇产出都附一条一句话摘要和 3 个候选标题；发布渠道不同措辞不同：公众号可长文，小红书要点化+emoji。" },
];
async function renderProjPage() {
  const page = document.getElementById("assist-page");
  if (!page) return;
  await refreshProjects();
  const q = (page._q || "").toLowerCase();
  const mine = projects.filter(p => !q || p.name.toLowerCase().includes(q));
  page.innerHTML = `
    <div class="pg-hero"><h1>项目</h1><div class="sub">每个项目一个独立工作目录，自带指令与专属配置，任务历史按项目分组</div></div>
    <div class="hub-head">
      <button class="btn-brand" id="pj-new" style="padding:8px 16px">${ic("plus")}新建项目</button>
      <div class="hub-search" style="margin-left:auto">${ic("search")}<input id="pj-q" placeholder="搜索项目" value="${esc(page._q || "")}"></div>
    </div>
    <div class="hub-sec-title">我的项目</div>
    <div class="tpl-grid" style="margin-bottom:22px">${mine.map(p => `
      <div class="proj-card ${p.name === activeProject ? "active" : ""}" data-name="${esc(p.name)}">
        <div class="tt">${ic("folder-open")} ${esc(p.name)} ${p.name === activeProject ? '<span class="badge">当前</span>' : ""}</div>
        <div class="dd">${p.instructions ? esc(p.instructions.slice(0, 60)) + (p.instructions.length > 60 ? "…" : "") : "还没有写项目指令"}</div>
        <div class="dd" title="${esc(p.dir)}">${p.created_at ? "添加于 " + esc(p.created_at.slice(0, 10)) : esc(p.dir)}</div>
        <div class="ops">
          <a class="link" data-act="open" href="#">${p.name === activeProject ? "去新建任务" : "切换到此项目"}</a>
          <a class="link" data-act="edit" href="#">编辑</a>
          ${projects.length > 1 ? '<a class="link danger" data-act="del" href="#">移除</a>' : ""}
        </div>
      </div>`).join("") || '<div class="hub-empty">没有匹配的项目</div>'}
    </div>
    <div class="hub-sec-title">从模版创建 <span class="sub">带着写好的项目指令开工</span></div>
    <div class="tpl-grid">${PROJ_TEMPLATES.map((t, i) => `
      <div class="proj-card" data-tpl="${i}">
        <div class="tt">${ic(t.icon)} ${esc(t.tt)}</div>
        <div class="dd">${esc(t.dd)}</div>
        <div class="ops"><a class="link" href="#">用这个模版新建${ic("arrow-right")}</a></div>
      </div>`).join("")}
    </div>`;
  page.querySelector("#pj-new").onclick = () => openProjEditor(null);
  const qEl = page.querySelector("#pj-q");
  qEl.oninput = () => { page._q = qEl.value; clearTimeout(page._t); page._t = setTimeout(renderProjPage, 200); };
  page.querySelectorAll(".proj-card[data-tpl]").forEach(el => el.onclick = (e) => { e.preventDefault(); openProjEditor(null, PROJ_TEMPLATES[+el.dataset.tpl]); });
  page.querySelectorAll(".proj-card[data-name]").forEach(el => el.onclick = async (e) => {
    e.preventDefault();
    const name = el.dataset.name;
    const act = (e.target.closest("a[data-act]") || {}).dataset ? e.target.closest("a[data-act]").dataset.act : "open";
    const proj = projects.find(p => p.name === name);
    if (act === "edit") return openProjEditor(proj);
    if (act === "del") {
      if (!confirm(`把项目「${name}」从列表移除？（目录和文件不会删除）`)) return;
      await fetch("/api/projects/" + encodeURIComponent(name), { method: "DELETE" });
      refreshProjects().then(refreshSettingsCache);
      renderProjPage();
      return;
    }
    if (name !== activeProject) {
      await fetch("/api/projects/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      activeProject = name;
      refreshSettingsCache();
      fetch("/api/files").then(r => r.json()).then(renderFiles);
    }
    closeAssistView();
    document.getElementById("new-task").click();
  });
}

/** 新建/编辑项目弹窗（proj 传 null = 新建；tpl 传模板预填指令） */
async function openProjEditor(proj, tpl) {
  mask.classList.add("show");
  modalBox.classList.add("wide");
  mTitle.textContent = proj ? `编辑项目「${proj.name}」` : "新建项目";
  // 可挂载的专家/技能/连接器清单（挂载=写进项目配置；任务执行时优先用这些）
  let [experts, skills, mcp] = await Promise.all([
    fetch("/api/experts").then(r => r.json()).catch(() => []),
    fetch("/api/skills").then(r => r.json()).catch(() => []),
    fetch("/api/mcp").then(r => r.json()).catch(() => []),
  ]);
  // /api/mcp 回的是 { servers, total_tools } 不是数组；这里不容错的话整个弹窗都渲染不出来
  mcp = Array.isArray(mcp) ? mcp : (mcp && Array.isArray(mcp.servers) ? mcp.servers : []);
  if (!Array.isArray(experts)) experts = [];
  if (!Array.isArray(skills)) skills = [];
  const sel = {
    connectors: new Set((proj || {}).connectors || []),
    experts: new Set((proj || {}).experts || []),
    skills: new Set((proj || {}).skills || []),
  };
  const pickRow = (key, label, items) => `
    <label>${label} <span class="cnt">（可选，已选 <span id="pk-n-${key}">${sel[key].size}</span>）</span></label>
    <div class="picks" data-key="${key}">${items.length
      ? items.map(n => `<span class="pk ${sel[key].has(n) ? "on" : ""}" data-v="${esc(n)}">${esc(n)}</span>`).join("")
      : '<span style="font-size: 13px;color:var(--wb-text-3)">还没有可挂载的条目</span>'}</div>`;
  mBody.innerHTML = `<div class="proj-form">
    <label>项目名称 <span class="cnt"><span id="pj-cnt">0</span>/15</span></label>
    <input id="pj-name" maxlength="15" placeholder="请输入项目名称" value="${esc((proj || {}).name || (tpl || {}).tt || "")}">
    <label>指令
      <select id="pj-tpl" class="cnt" style="float:right;font-size: 13px;padding:2px 6px">
        <option value="">选择模板</option>
        ${PROJ_TEMPLATES.map((t, i) => `<option value="${i}">${esc(t.tt)}</option>`).join("")}
      </select>
    </label>
    <textarea id="pj-ins" rows="5" placeholder="提供当前项目的背景信息和规范，让 AI 的回复更精准、更符合要求。比如：项目目标、团队习惯、风格偏好、输出约束等">${esc((proj || {}).instructions || (tpl || {}).ins || "")}</textarea>
    ${pickRow("connectors", "连接器", mcp.map(m => m.name))}
    ${pickRow("experts", "专家", experts.map(e => e.name))}
    ${pickRow("skills", "技能", skills.map(k => k.name))}
    <div class="foot">
      <span class="hint">切换模版会覆盖当前编辑的指令</span>
      <button class="btn-plain" id="pj-cancel">取消</button>
      <button class="btn-brand" id="pj-ok">确定</button>
    </div>
  </div>`;
  const nameEl = mBody.querySelector("#pj-name"), cntEl = mBody.querySelector("#pj-cnt");
  const syncCnt = () => { cntEl.textContent = nameEl.value.length; };
  nameEl.oninput = syncCnt; syncCnt();
  mBody.querySelector("#pj-tpl").onchange = (e) => {
    const t = PROJ_TEMPLATES[+e.target.value];
    if (t) { mBody.querySelector("#pj-ins").value = t.ins; if (!nameEl.value.trim()) { nameEl.value = t.tt; syncCnt(); } }
  };
  mBody.querySelectorAll(".picks").forEach(box => box.onclick = (e) => {
    const pk = e.target.closest(".pk");
    if (!pk) return;
    const key = box.dataset.key, v = pk.dataset.v;
    sel[key].has(v) ? sel[key].delete(v) : sel[key].add(v);
    pk.classList.toggle("on");
    mBody.querySelector("#pk-n-" + key).textContent = sel[key].size;
  });
  mBody.querySelector("#pj-cancel").onclick = () => mask.classList.remove("show");
  mBody.querySelector("#pj-ok").onclick = async () => {
    const name = nameEl.value.trim();
    if (!name) return toast("项目名称不能为空", "circle-x");
    const body = {
      name,
      instructions: mBody.querySelector("#pj-ins").value.trim(),
      connectors: [...sel.connectors], experts: [...sel.experts], skills: [...sel.skills],
    };
    const resp = proj
      ? await fetch("/api/projects/" + encodeURIComponent(proj.name), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      : await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return toast((data.error || "保存失败"), "circle-x");
    mask.classList.remove("show");
    toast(proj ? "项目已更新" : "项目已创建", "circle-check");
    refreshProjects().then(refreshSettingsCache);
    if (pageKind === "proj") renderProjPage();
  };
}

// ================= 自动化页（定时任务 + 运行记录 + 批量管理 + 模板） =================
const AUTOM_TEMPLATES = [
  { icon: "newspaper", tt: "每日 AI 新闻晨报", cron: "0 9 * * *", task: "搜索过去 24 小时内 AI 行业的重要新闻（新模型、产品、融资、政策），挑 5-8 条真实可查的，生成一份 Markdown 晨报，每条附来源链接。" },
  { icon: "notebook-pen", tt: "每周五工作周报", cron: "0 17 * * 5", task: "读取本周工作目录里新增/修改的成果文件，按「本周进展 / 问题与风险 / 下周计划」三段生成一份周报，进展要具体到产出物。" },
  { icon: "wrench", tt: "每小时网站巡检", cron: "0 * * * *", task: "用 fetch_url 检查以下网址是否能正常打开、响应是否异常（先在这里填上你的网址）：https://example.com 。异常时写清楚状态码和现象。" },
  { icon: "eraser", tt: "每周清理临时文件", cron: "0 10 * * 1", task: "列出工作目录里超过 7 天没动过的 .tmp/.log/中间产物文件，汇总成清单报告（只报告，不要直接删除）。" },
];
const automState = { tab: "tasks", q: "", bulk: false, sel: new Set(), editing: null, showForm: false };
function buildCronFrom(root) {
  const freq = root.querySelector("#sf-freq").value;
  const t = (root.querySelector("#sf-time").value || "09:00").split(":");
  const m = +t[1] || 0, h = +t[0] || 9;
  switch (freq) {
    case "daily": return `${m} ${h} * * *`;
    case "workday": return `${m} ${h} * * 1-5`;
    case "weekly": return `${m} ${h} * * ${root.querySelector("#sf-dow").value}`;
    case "monthly": return `${m} ${h} ${root.querySelector("#sf-dom").value} * *`;
    case "hourly": return `${m} * * * *`;
    case "half-hour": return `*/30 * * * *`;
    case "custom": return root.querySelector("#sf-cron").value.trim();
  }
}
/** 反推：已有 cron 回填到表单（编辑时用；反推不出来就落到自定义档） */
function cronToForm(root, cron) {
  const set = (id, v) => { root.querySelector(id).value = v; };
  const m = (cron || "").match(/^(\d+) (\d+) (\S+) \* (\S+)$/);
  const time = m ? `${m[2].padStart(2, "0")}:${m[1].padStart(2, "0")}` : "09:00";
  if (cron === "*/30 * * * *") set("#sf-freq", "half-hour");
  else if (/^\d+ \* \* \* \*$/.test(cron)) { set("#sf-freq", "hourly"); set("#sf-time", `09:${cron.split(" ")[0].padStart(2, "0")}`); }
  else if (m && m[3] === "*" && m[4] === "*") { set("#sf-freq", "daily"); set("#sf-time", time); }
  else if (m && m[3] === "*" && m[4] === "1-5") { set("#sf-freq", "workday"); set("#sf-time", time); }
  else if (m && m[3] === "*" && /^\d$/.test(m[4])) { set("#sf-freq", "weekly"); set("#sf-dow", m[4]); set("#sf-time", time); }
  else if (m && /^\d+$/.test(m[3]) && m[4] === "*") { set("#sf-freq", "monthly"); set("#sf-dom", m[3]); set("#sf-time", time); }
  else { set("#sf-freq", "custom"); set("#sf-cron", cron || ""); }
  root.querySelector("#sf-freq").onchange();
}
async function renderAutomPage() {
  const page = document.getElementById("assist-page");
  if (!page) return;
  const st = automState;
  if (st.tab === "runs") return renderAutomRuns(page);
  const { list, error } = await getList("/api/schedules");
  // 服务端说了不给（多人服务器上定时任务归平台管理员），就把这句话摆出来。
  // 以前这儿直接 list.filter，403 的那个对象一进来整页就断在半空，白屏。
  if (error) {
    page.innerHTML = `<div class="hub-empty">${ic("clock")} 自动化<br><br>${esc(error)}<br><br><span style="font-size: 13px">定时任务跑在这台服务器上、花的是服务器的额度，所以归平台管理员统一排。<br>你自己要跑的活，直接在对话里说就行。</span></div>`;
    return;
  }
  const q = st.q.toLowerCase();
  const match = list.filter(t => !q || t.name.toLowerCase().includes(q) || t.task.toLowerCase().includes(q));
  const on = match.filter(t => t.enabled), off = match.filter(t => !t.enabled);
  const row = (t) => `
    <div class="at-row" data-id="${t.id}">
      ${st.bulk ? `<input type="checkbox" data-sel="${t.id}" ${st.sel.has(t.id) ? "checked" : ""}>` : ""}
      <span class="nm">${esc(t.name)}</span>
      <span class="meta" title="${esc(t.task)}">${esc(t.task.slice(0, 50))} · ${esc(cronToHuman(t.cron))}${t.last_run ? " · 上次 " + esc(t.last_run.slice(5, 16).replace("T", " ")) : ""}</span>
      <span class="st ${t.running ? "" : !t.enabled ? "" : t.last_result ? (/^出错/.test(t.last_result) ? "err" : "ok") : ""}">${t.running ? "执行中…" : !t.enabled ? "已暂停" : t.last_result ? (/^出错/.test(t.last_result) ? "上次失败" : "上次成功") : "待首跑"}</span>
      <span class="ops">
        <a class="link" data-act="run" href="#">立即执行</a>
        <a class="link" data-act="edit" href="#">编辑</a>
        <a class="link" data-act="toggle" href="#">${t.enabled ? "暂停" : "启用"}</a>
        <a class="link danger" data-act="del" href="#">删除</a>
      </span>
    </div>`;
  page.innerHTML = `
    <div class="hub-head">
      <div class="hub-tabs">
        <button class="active" data-tab="tasks">${ic("timer")} 定时任务</button>
        <button data-tab="runs">${ic("scroll-text")} 运行记录</button>
      </div>
      <div class="hub-search">${ic("search")}<input id="at-q" placeholder="搜索自动化" value="${esc(st.q)}"></div>
      <button class="btn-plain" id="at-bulk" style="${st.bulk ? "border-color: var(--wb-brand-text);color: var(--wb-brand-text)" : ""}">${ic("list-checks")} 批量管理</button>
      <button class="btn-plain" id="at-tpl">${ic("clipboard-list")} 从模版添加</button>
      <button class="btn-brand" id="at-new">${ic("plus")}添加自动化</button>
    </div>
    ${st.bulk ? `<div class="hub-bar" style="margin:0 0 8px">
      <a class="link" id="bk-all" href="#">全选</a>
      <span style="font-size: 13px;color:var(--wb-text-3)">已选 ${st.sel.size} 个</span>
      <a class="link" id="bk-en" href="#">批量启用</a>
      <a class="link" id="bk-dis" href="#">批量暂停</a>
      <a class="link danger" id="bk-del" href="#">批量删除</a>
    </div>` : ""}
    <div id="at-form-box"></div>
    ${on.length ? `<div class="at-group">启用中（${on.length}）</div>` + on.map(row).join("") : ""}
    ${off.length ? `<div class="at-group">已暂停（${off.length}）</div>` + off.map(row).join("") : ""}
    ${!match.length ? '<div class="hub-empty">还没有自动化任务。点右上角「添加自动化」或「从模版添加」建一个。</div>' : ""}`;
  page.querySelector('[data-tab="runs"]').onclick = () => { st.tab = "runs"; renderAutomPage(); };
  const qEl = page.querySelector("#at-q");
  qEl.oninput = () => { st.q = qEl.value; clearTimeout(page._t); page._t = setTimeout(renderAutomPage, 200); };
  page.querySelector("#at-bulk").onclick = () => { st.bulk = !st.bulk; st.sel.clear(); renderAutomPage(); };
  page.querySelector("#at-new").onclick = () => { st.editing = null; st.showForm = true; renderAutomForm(page.querySelector("#at-form-box")); };
  page.querySelector("#at-tpl").onclick = () => renderAutomTplPicker(page.querySelector("#at-form-box"));
  if (st.showForm) renderAutomForm(page.querySelector("#at-form-box"));
  page.querySelectorAll("input[data-sel]").forEach(cb => cb.onchange = () => {
    cb.checked ? st.sel.add(cb.dataset.sel) : st.sel.delete(cb.dataset.sel);
    renderAutomPage();
  });
  if (st.bulk) {
    page.querySelector("#bk-all").onclick = (e) => { e.preventDefault(); match.forEach(t => st.sel.add(t.id)); renderAutomPage(); };
    const bulk = async (action, confirmText) => {
      if (!st.sel.size) return toast("先勾选要操作的任务", "circle-x");
      if (confirmText && !confirm(confirmText)) return;
      const r = await fetch("/api/schedules/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [...st.sel], action }) }).then(r => r.json()).catch(() => ({}));
      toast(r.ok ? `已处理 ${r.count} 个` : r.error || "操作失败", r.ok ? "circle-check" : "circle-x");
      st.sel.clear();
      renderAutomPage();
    };
    page.querySelector("#bk-en").onclick = (e) => { e.preventDefault(); bulk("enable"); };
    page.querySelector("#bk-dis").onclick = (e) => { e.preventDefault(); bulk("disable"); };
    page.querySelector("#bk-del").onclick = (e) => { e.preventDefault(); bulk("delete", `确认删除选中的 ${st.sel.size} 个自动化任务？运行记录会一并清掉`); };
  }
  page.querySelectorAll(".at-row a[data-act]").forEach(a => a.onclick = async (e) => {
    e.preventDefault();
    const id = a.closest(".at-row").dataset.id;
    const t = list.find(x => x.id === id);
    const act = a.dataset.act;
    if (act === "edit") { st.editing = t; st.showForm = true; renderAutomForm(page.querySelector("#at-form-box")); window.scrollTo(0, 0); return; }
    if (act === "del") { if (!confirm(`确认删除「${t.name}」？`)) return; await fetch("/api/schedules/" + id, { method: "DELETE" }); }
    else if (act === "toggle") await fetch(`/api/schedules/${id}/toggle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !t.enabled }) });
    else if (act === "run") {
      a.textContent = "执行中…";
      const r = await fetch(`/api/schedules/${id}/run`, { method: "POST" }).catch(() => null);
      const j = r ? await r.json().catch(() => ({})) : {};
      toast(!r || !r.ok ? j.error || "执行失败" : "执行完成", !r || !r.ok ? "circle-x" : "circle-check");
      fetch("/api/files").then(r => r.json()).then(renderFiles);
    }
    renderAutomPage();
  });
}
function renderAutomTplPicker(box) {
  automState.showForm = false;
  box.innerHTML = `<div class="tpl-grid" style="margin:4px 0 14px">${AUTOM_TEMPLATES.map((t, i) => `
    <div class="proj-card" data-i="${i}">
      <div class="tt">${ic(t.icon)} ${esc(t.tt)}</div>
      <div class="dd">${esc(cronToHuman(t.cron))} · ${esc(t.task.slice(0, 46))}…</div>
      <div class="ops"><a class="link" href="#">用这个模版${ic("arrow-right")}</a></div>
    </div>`).join("")}</div>`;
  box.querySelectorAll(".proj-card").forEach(el => el.onclick = (e) => {
    e.preventDefault();
    automState.editing = null; automState.showForm = true;
    renderAutomForm(box, AUTOM_TEMPLATES[+el.dataset.i]);
  });
}
function renderAutomForm(box, tpl) {
  const ed = automState.editing;
  box.innerHTML = `<div style="border:1px solid var(--wb-border);border-radius:12px;padding:14px 16px;margin:4px 0 16px">
    <div style="font-weight:600;margin-bottom:10px">${ed ? `编辑「${esc(ed.name)}」` : "添加自动化"}</div>
    <input id="sf-name" placeholder="任务名（如：每日晨报）" value="${esc((ed || tpl || {}).name || (tpl || {}).tt || "")}">
    <div class="form-row">
      <select id="sf-freq">
        <option value="daily">每天</option>
        <option value="workday">工作日（周一到周五）</option>
        <option value="weekly">每周某天</option>
        <option value="monthly">每月某日</option>
        <option value="hourly">每小时</option>
        <option value="half-hour">每 30 分钟</option>
        <option value="custom">自定义 cron</option>
      </select>
      <select id="sf-dow" style="display:none">
        <option value="1">周一</option><option value="2">周二</option><option value="3">周三</option>
        <option value="4">周四</option><option value="5">周五</option><option value="6">周六</option><option value="0">周日</option>
      </select>
      <select id="sf-dom" style="display:none">${Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}">${i + 1} 日</option>`).join("")}</select>
      <input id="sf-time" type="time" value="09:00">
    </div>
    <input id="sf-cron" placeholder="cron 表达式：分 时 日 月 周" style="display:none">
    <textarea id="sf-task" rows="2" placeholder="要自动执行的任务描述，如：抓取今天的 AI 新闻生成晨报">${esc((ed || tpl || {}).task || "")}</textarea>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn-brand" id="sf-add">${ed ? "保存修改" : "添加"}</button>
      <button class="btn-plain" id="sf-cancel">收起</button>
    </div>
  </div>`;
  const freqEl = box.querySelector("#sf-freq");
  freqEl.onchange = () => {
    const v = freqEl.value;
    box.querySelector("#sf-dow").style.display = v === "weekly" ? "" : "none";
    box.querySelector("#sf-dom").style.display = v === "monthly" ? "" : "none";
    box.querySelector("#sf-cron").style.display = v === "custom" ? "" : "none";
    box.querySelector("#sf-time").style.display = ["hourly", "half-hour", "custom"].includes(v) ? "none" : "";
  };
  cronToForm(box, (ed || tpl || {}).cron || "0 9 * * *");
  box.querySelector("#sf-cancel").onclick = () => { automState.showForm = false; automState.editing = null; box.innerHTML = ""; };
  box.querySelector("#sf-add").onclick = async () => {
    const name = box.querySelector("#sf-name").value.trim();
    const task = box.querySelector("#sf-task").value.trim();
    const cron = buildCronFrom(box);
    if (!task) return toast("请填写任务描述", "circle-x");
    if (!cron) return toast("请完成时间设置", "circle-x");
    const resp = ed
      ? await fetch("/api/schedules/" + ed.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, cron, task }) })
      : await fetch("/api/schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, cron, task }) });
    if (!resp.ok) return toast(((await resp.json()).error || "保存失败"), "circle-x");
    toast(ed ? "已保存" : "已添加", "circle-check");
    automState.showForm = false; automState.editing = null;
    renderAutomPage();
  };
}
async function renderAutomRuns(page) {
  const { list: runs, error: runsErr } = await getList("/api/schedules/runs?limit=100");
  if (runsErr) {
    page.innerHTML = `<div class="hub-empty">${ic("scroll-text")} 运行记录<br><br>${esc(runsErr)}</div>`;
    return;
  }
  const fmtMs = (ms) => ms >= 60000 ? Math.round(ms / 60000) + " 分" : Math.max(1, Math.round(ms / 1000)) + " 秒";
  // 判据里的 **重点** 是写给人看的，交给共享的 escInline（转义完再翻标记），不然界面上会印出一串星号
  const bold = escInline;
  // 一条红的运行记录得能当场回答两件事：为什么红、下一步干什么。
  // 只印一句被截断的正文，等于让人自己去猜——而这正是「面板一片绿/一片红都看不出所以然」的来源。
  const runCell = (r) => {
    const raw = String(r.result || "");
    if (!r.label) return esc(raw.slice(0, 90)) + (raw.length > 90 ? "…" : "");
    const i = raw.indexOf("上游原话：");
    const quoted = i >= 0 ? raw.slice(i) : "";
    return `<b>${esc(r.label)}</b>`
      + (r.hint ? `<div class="at-hint">${bold(r.hint)}</div>` : "")
      + (quoted ? `<div class="at-raw">${esc(quoted.slice(0, 200))}${quoted.length > 200 ? "…" : ""}</div>` : "");
  };
  page.innerHTML = `
    <div class="hub-head">
      <div class="hub-tabs">
        <button data-tab="tasks">${ic("timer")} 定时任务</button>
        <button class="active" data-tab="runs">${ic("scroll-text")} 运行记录</button>
      </div>
      <span style="font-size: 13px;color:var(--wb-text-3);margin-left:auto">最近 ${runs.length} 次执行，最新在前</span>
    </div>
    ${runs.length ? `<table class="at-runs">
      <tr><th>时间</th><th>任务</th><th>触发</th><th>耗时</th><th>结果</th></tr>
      ${runs.map(r => `<tr>
        <td style="white-space:nowrap">${esc((r.started_at || "").slice(5, 16).replace("T", " "))}</td>
        <td>${esc(r.name)}</td>
        <td>${esc(r.trigger || "")}</td>
        <td style="white-space:nowrap">${r.ended_at ? fmtMs(r.ms) : "进行中…"}</td>
        <td>${ic(r.ok === null ? "hourglass" : r.ok ? "circle-check" : "circle-x")} ${runCell(r)}</td>
      </tr>`).join("")}
    </table>` : '<div class="hub-empty">还没有运行记录。任务跑过之后（定时触发或手动执行）这里会留下每一次的流水。</div>'}`;
  page.querySelector('[data-tab="tasks"]').onclick = () => { automState.tab = "tasks"; renderAutomPage(); };
}

// ================= 资料库页（左侧文件树 + 右侧预览：MD 渲染 / CSV 表格 / HTML 真渲染） =================
const libState = { pick: null, q: "" }; // pick: {src:"lib"|"ws"|"notes", name}
function csvToTable(text) {
  // 迷你 CSV 解析（带引号转义）。行数封顶，别让一个 10 万行的表把页面卡死
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length && rows.length < 500; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(x => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); if (row.some(x => x !== "")) rows.push(row); }
  if (!rows.length) return '<div class="ph">空表</div>';
  const [head, ...body] = rows;
  return `<table class="csv"><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr>` +
    body.map(r => `<tr>${head.map((_, i) => `<td>${esc(r[i] || "")}</td>`).join("")}</tr>`).join("") +
    `</table>${rows.length >= 500 ? '<div style="font-size: 13px;color:var(--wb-text-3);margin-top:6px">表太长，只显示前 500 行</div>' : ""}`;
}
// ================= 评测页：给模型跑基准，机器判分 =================
let evalArm = false; // 两段式确认：真实计费的操作不许一键就跑
let evalDetailDir = null;
/** 评测页顶部的「用户反馈」：对话里点的 👍👎 就是最准的效果信号，按模型/模式切着看，👎 能点回现场 */
async function renderFeedbackSummary(days = 30) {
  const box = document.getElementById("ev-fb");
  if (!box) return;
  const d = await fetch(`/api/feedback/summary?days=${days}`).then((r) => r.json()).catch(() => null);
  if (!d) { box.textContent = "反馈汇总读取失败"; return; }
  if (!d.total) {
    box.innerHTML = `<div class="ev-fb-empty">近 ${days} 天还没有人点过${ic("thumbs-up")}${ic("thumbs-down")}。每条回复下面都有，点一下就进这里——这是最准的效果信号，比机器判分还准。</div>`;
    return;
  }
  const pct = (n, of) => (of ? Math.round((n / of) * 100) + "%" : "—");
  const card = (k, v, s) => `<div class="ev-fb-card"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
  const rows = (list, label) => (list.length ? `<table class="ev-fb-tab"><tr><th>${label}</th><th>${ic("thumbs-up")} </th><th>${ic("thumbs-down")} </th><th>好评率</th></tr>` +
    list.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.up}</td><td>${r.down}</td><td><span class="ev-bar"><i style="width:${Math.round(r.upRate * 100)}%"></i></span>${pct(r.up, r.up + r.down)}</td></tr>`).join("") + `</table>` : "");
  const downs = d.downs.slice(0, 20).map((f) =>
    `<div class="ev-fb-down"><span class="t">${esc(String(f.at || "").slice(5, 16).replace("T", " "))}</span><span class="m" title="${esc(f.provider || "")}">${esc(f.model || "—")}</span>` +
    `<span class="task" title="${esc(f.task || "")}">${esc(f.task || "")}</span><span class="note" title="${esc(f.note || "")}">${f.note ? esc(f.note) : "<i>没写理由</i>"}</span>` +
    (f.session ? `<a href="#" data-sid="${esc(f.session)}">打开对话</a>` : "<span></span>") + `</div>`).join("");
  box.innerHTML =
    `<div class="ev-fb-cards">${card("反馈总数", d.total, `${d.up} ${ic("thumbs-up")} · ${d.down} ${ic("thumbs-down")}`)}${card("好评率", pct(d.up, d.total), ic("thumbs-up") + " ÷ 全部反馈")}` +
    `${card(ic("thumbs-down") + " 写了理由", pct(d.downWithNote, d.down), "写了理由的才进得了复盘")}${card("近 7 天", `${d.last7.up} / ${d.last7.down}`, `${ic("thumbs-up")} / ${ic("thumbs-down")}`)}</div>` +
    rows(d.byModel.filter((r) => r.name !== "（未知）" || d.byModel.length === 1), "按模型") + rows(d.byMode.filter((r) => r.name !== "（未知）"), "按模式") +
    (d.down ? `<div class="side-label" style="margin:10px 0 4px">最近的${ic("thumbs-down")}（${d.down} 条）· 点「打开对话」回到现场</div>${downs}` : "");
  box.querySelectorAll("a[data-sid]").forEach((a) => { a.onclick = (e) => { e.preventDefault(); openSession(a.dataset.sid); }; });
}

const EV_FAIL_LABELS = { crash: "崩溃", timeout: "超时", max_steps: "步数用尽", loop_suspect: "疑似死循环", tool_error_storm: "工具连环报错", missing_artifact: "没交产物", wrong_output: "内容不对" };
async function renderEvalPage() {
  const page = document.getElementById("assist-page");
  if (!page) return;
  evalArm = false;
  evalDetailDir = null;
  if (!settingsCache) await refreshSettingsCache().catch(() => {});
  const models = (settingsCache && settingsCache.models) || [];
  const cur = (settingsCache && settingsCache.active_model) || "";
  const opts = (sel) => models.map((m) => `<option value="${esc(m.name)}" ${m.name === sel ? "selected" : ""}>${esc(m.name)}</option>`).join("");
  page.innerHTML = `
    <div class="hub-head" style="flex-wrap:wrap;gap:8px">
      <div style="font-weight:700;font-size:15px">${ic("flask-conical")} 智能体评测</div>
      <label style="font-size:12px;color:var(--wb-text-3)">被测模型</label>
      <select id="ev-model">${opts(cur)}</select>
      <label style="font-size:12px;color:var(--wb-text-3)">每题次数</label>
      <select id="ev-repeat" title="重复跑才能看出稳定性：pass@1 均值看「能不能」，k 次全过看「稳不稳」。费用按次数翻倍">
        <option value="1">1 次 · 最快</option><option value="3">3 次 · 测稳定</option><option value="5">5 次 · 严格</option>
      </select>
      <label style="font-size:12px;color:var(--wb-text-3)">AI 评委</label>
      <select id="ev-judge"><option value="">不用（只机器判分）</option>${opts("")}</select>
      <button class="btn-brand" id="ev-start">开始评测</button>
      <span id="ev-state" style="font-size:13px;color:var(--wb-text-3)"></span>
    </div>
    <div style="font-size:13px;color:var(--wb-text-3);line-height:1.7;margin:0 0 10px">
      15 道分层任务（L1 基础 / L2 进阶 / L3 高难）把整个智能体当黑盒考（写代码 / 算表格 / 修 bug / 跨文件重构 / 日志管线…）。三条评分线互相独立：<b>机器判分</b>（跑代码、对数字、验结构，只认硬证据，失败自动归因成败因码）、<b>稳定性</b>（每题重复 k 次：pass@1 均值看能不能，k 次全过看稳不稳）、<b>AI 评委</b>（逐条质量维度只判 是/否，不打印象分）。跑完可「设为基线」——之后每轮自动逐题对比，退步点名。
      <b>会真实调用所选模型计费</b>，费用随次数翻倍（DeepSeek 单次约几毛钱）。命令行同款：<code>npm run eval -- --repeat 3 --judge 评委名</code>
    </div>
    <div class="side-label" style="margin:6px 0">用户反馈 · 近 30 天在对话里点的 ${ic("thumbs-up")}${ic("thumbs-down")}</div>
    <div id="ev-fb" style="font-size:13px;color:var(--wb-text-3);margin:0 0 14px">加载中…</div>
    <pre id="ev-log" style="display:none;background:var(--wb-card);border:1px solid var(--wb-line);border-radius:10px;padding:12px 14px;font-size:12px;line-height:1.8;max-height:320px;overflow:auto;white-space:pre-wrap;margin:0 0 14px"></pre>
    <div id="ev-detail"></div>
    <div class="side-label" style="margin:6px 0">历史成绩 · 点一行看每题明细 / 打人工分 / 设为基线</div>
    <div id="ev-hist" style="font-size:13px;color:var(--wb-text-3)">加载中…</div>`;
  renderFeedbackSummary();
  document.getElementById("ev-start").onclick = async () => {
    const btn = document.getElementById("ev-start");
    if (!evalArm) {
      evalArm = true;
      btn.textContent = "确认开跑？真实计费 · 再点一次";
      btn.style.background = "var(--wb-err)";
      setTimeout(() => { if (evalArm && pageKind === "eval") { evalArm = false; btn.textContent = "开始评测"; btn.style.background = ""; } }, 6000);
      return;
    }
    evalArm = false; btn.textContent = "开始评测"; btn.style.background = "";
    const model = document.getElementById("ev-model").value;
    const judge = document.getElementById("ev-judge").value;
    const repeat = +document.getElementById("ev-repeat").value || 1;
    const body = { model, repeat };
    if (judge) body.judge = judge;
    const r = await fetch("/api/eval/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => null);
    if (!r || r.error) return toast(((r && r.error) || "启动失败"), "circle-x");
    toast("评测已开跑：" + model + (repeat > 1 ? `（每题 ${repeat} 次）` : "") + (judge ? "（评委 " + judge + "）" : ""));
    updateEvalView();
  };
  updateEvalView();
}
