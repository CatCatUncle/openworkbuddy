"use strict";
/**
 * 企业管理后台的前端（/admin.html）。
 *
 * 三条自己给自己定的规矩，后面加页面照着来：
 *
 * 1）**只显示后端真的会执行的开关。** 「配了但没人读」的开关比没有这个开关更糟——管理员
 *    以为命令行已经关了，实际一直开着。所以这页上每一个开关背后都能指到具体是哪个文件在拦人，
 *    指不出来的（比如「安全等级」这种听着像样但没人读的）就不放上来。
 *
 * 2）**审计员看到的按钮不能是会 403 的按钮。** 后端 adminGuard 放行 GET、adminOnly 拦写操作，
 *    前端就得跟着把写操作的控件禁掉。给一个点下去必然报错的按钮，比不给这个按钮更伤。
 *
 * 3）**累计就写累计，本月就写本月。** by_user / by_model / by_source / by_dept 是**全量**聚合，
 *    today / month / last7 才是按窗口切的。把前者标成「本月」，数字就在无声地撒谎。
 */

/* ---------------- 小工具 ---------------- */
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = (name, cls) => `<svg class="i${cls ? " " + cls : ""}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const num = (n) => (+n || 0).toLocaleString("zh-CN");
/** tokens 这类大数走「万」，一屏里塞得下也读得出量级 */
const big = (n) => {
  n = +n || 0;
  if (n >= 100000000) return (n / 100000000).toFixed(2) + " 亿";
  if (n >= 10000) return (n / 10000).toFixed(n >= 1000000 ? 0 : 1) + " 万";
  return num(n);
};
const pad2 = (n) => String(n).padStart(2, "0");
function fmtTs(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "—";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "—";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/** 「3 天前」这种相对时间：最近活跃那一列用绝对时间戳读起来太费劲 */
function ago(iso) {
  if (!iso) return "从未";
  const ms = Date.now() - Date.parse(iso);
  if (!(ms >= 0)) return fmtDate(iso);
  const m = Math.floor(ms / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return m + " 分钟前";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " 小时前";
  const d = Math.floor(h / 24);
  if (d < 30) return d + " 天前";
  return fmtDate(iso);
}
const mb = (b) => {
  b = +b || 0;
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + " GB";
  if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
  if (b >= 1024) return (b / 1024).toFixed(0) + " KB";
  return b + " B";
};
const ROLE_LABEL = { admin: "管理员", auditor: "审计员", member: "成员" };
const STATUS_LABEL = { active: "正常", pending: "待审核", disabled: "已停用" };
const SOURCE_LABEL = { web: "网页", feishu: "飞书", wecom: "企业微信", dingtalk: "钉钉", qq: "QQ", schedule: "定时任务", api: "接口", cli: "命令行" };

/* ---------------- 请求 ---------------- */
async function api(path, opts) {
  const r = await fetch(path, Object.assign({ credentials: "same-origin" }, opts));
  let body = null;
  try { body = await r.json(); } catch { /* 有些错误页不是 JSON，下面按状态码给话 */ }
  if (!r.ok) {
    const e = new Error((body && body.error) || `请求没成功（HTTP ${r.status}）`);
    e.status = r.status;
    e.body = body || {};
    throw e;
  }
  return body;
}
const jsonOpts = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
const post = (path, body) => api(path, jsonOpts("POST", body));
const del = (path) => api(path, { method: "DELETE" });

let toastTimer = 0;
function toast(msg, bad) {
  const el = $("ad-toast");
  el.textContent = msg;
  el.classList.toggle("bad", !!bad);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), bad ? 4200 : 2400);
}
/** 写操作统一走这里：出错就把后端那句原话端上来，别自己编一句「操作失败」 */
async function act(fn, okMsg) {
  try {
    const out = await fn();
    if (okMsg) toast(okMsg);
    return out;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

/* ---------------- 弹层 ---------------- */
/**
 * @param opts { title, fields:[{name,label,desc,type,value,options,placeholder}], ok, onOk }
 * onOk 拿到 {name: value}，返回 Promise；抛错就把错误留在弹层上，别把用户填的东西一起关掉
 */
function modal(opts) {
  const mask = document.createElement("div");
  mask.className = "ui-overlay";
  const fields = (opts.fields || [])
    .map((f) => {
      const id = "mf-" + f.name;
      let ctl;
      if (f.type === "select")
        ctl = `<select class="ui-input ui-select" id="${id}">${(f.options || [])
          .map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(f.value) ? " selected" : ""}>${esc(o.label)}</option>`)
          .join("")}</select>`;
      else if (f.type === "textarea")
        ctl = `<textarea class="ui-input" id="${id}" rows="4" style="height:auto;resize:vertical" placeholder="${esc(f.placeholder || "")}">${esc(f.value || "")}</textarea>`;
      else
        ctl = `<input class="ui-input" id="${id}" type="${f.type || "text"}" value="${esc(f.value == null ? "" : f.value)}" placeholder="${esc(f.placeholder || "")}">`;
      return `<div><label for="${id}">${esc(f.label)}</label>${ctl}${f.desc ? `<div class="fd" style="margin-top:6px">${f.desc}</div>` : ""}</div>`;
    })
    .join("");
  mask.innerHTML = `<div class="ui-dialog" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
    <h2>${esc(opts.title)}</h2>
    <div class="bd">${opts.body || ""}${fields}<div class="fd" id="mf-err" style="color:var(--danger-text);display:none"></div></div>
    <div class="ft">
      <button class="ui-btn ui-btn--ghost ui-btn--sm" data-x>取消</button>
      <button class="ui-btn ui-btn--${opts.danger ? "destructive" : "default"} ui-btn--sm" data-ok>${esc(opts.ok || "确定")}</button>
    </div>
  </div>`;
  document.body.appendChild(mask);
  const close = () => { document.removeEventListener("keydown", onKey); mask.remove(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  mask.addEventListener("click", (e) => { if (e.target === mask) close(); });
  mask.querySelector("[data-x]").onclick = close;
  const okBtn = mask.querySelector("[data-ok]");
  okBtn.onclick = async () => {
    const vals = {};
    for (const f of opts.fields || []) vals[f.name] = mask.querySelector("#mf-" + f.name).value;
    okBtn.disabled = true;
    try {
      await opts.onOk(vals, mask);
      close();
    } catch (e) {
      const err = mask.querySelector("#mf-err");
      err.textContent = e.message;
      err.style.display = "";
      okBtn.disabled = false;
    }
  };
  const first = mask.querySelector(".bd input, .bd select, .bd textarea");
  if (first) first.focus();
  return mask;
}
function confirmBox(title, text, ok, onOk, danger) {
  return modal({ title, body: `<div class="fd" style="font-size:14px;color:var(--foreground)">${text}</div>`, fields: [], ok, danger, onOk });
}

/* ---------------- 渲染碎片 ---------------- */
const card = (inner, pad) => `<section class="ui-card" style="padding:${pad == null ? 20 : pad}px">${inner}</section>`;
/**
 * 卡片头 + 一块贴边的内容（表格 / 空状态）。
 * 表格自己带内边距的话，分隔线会停在卡片内边距上——一屏十几条断头横线，看着就是散的。
 * 所以头部单独一块，表格从卡片左边一直画到右边。
 */
const cardT = (head, body) => `<section class="ui-card ad-card"><div class="ad-card-h">${head}</div>${body}</section>`;
const secT = (t, d) => `<div><div class="ad-sec-t">${esc(t)}</div>${d ? `<div class="ad-sec-d">${d}</div>` : ""}</div>`;
/** 卡片头一行：左边标题、右边一组按钮。窄屏自己换行，不会把按钮挤没 */
const headRow = (left, right) => `<div class="ad-hrow">${left}${right ? `<div class="ad-row">${right}</div>` : ""}</div>`;
const ALERT_ICON = { info: "info", warn: "triangle-alert", success: "circle-check", destructive: "triangle-alert" };
/**
 * note(文案) 是说明，note(文案, true) / note(文案, "warn") 是提醒。
 * 底色压到 5%-7%，正文仍然是正文色——整条高饱和底配同色文字，在一屏三四条的密度下会盖过它旁边真正的内容。
 */
const note = (text, kind) => {
  const k = kind === true ? "warn" : kind || "info";
  return `<div class="ui-alert ui-alert--${k}">${ic(ALERT_ICON[k] || "info")}<div>${text}</div></div>`;
};
const kpi = (list) =>
  `<div class="ui-stats">${list
    .map((k) => `<div class="ui-stat"><div class="l">${esc(k.label)}</div><div class="v">${k.value}</div>${k.hint ? `<div class="h">${k.hint}</div>` : ""}</div>`)
    .join("")}</div>`;
const badge = (text, kind) => `<span class="ui-badge${kind ? " ui-badge--" + kind : ""}">${esc(text)}</span>`;
const empty = (text) => `<div class="ad-empty">${ic("file-text")}<span>${esc(text)}</span></div>`;
/** 进度条：快满了变黄、满了变红。席位只剩最后一个的时候，一根纯色条是看不出来的 */
const progress = (pct) => {
  const v = Math.max(0, Math.min(100, Math.round(pct || 0)));
  return `<div class="ui-progress${v >= 100 ? " ui-progress--full" : v >= 80 ? " ui-progress--warn" : ""}"><i style="width:${v}%"></i></div>`;
};
/**
 * 只读信息表。field() 是「左说明右控件」的设置项，这个是给「看」的事实行——
 * 把改不了的东西也排成设置项那种跨半屏的样子，标签和值离得太远，眼睛得来回找。
 */
const dl = (rows) => `<dl class="ad-dl">${rows.map((r) => `<dt>${esc(r[0])}</dt><dd>${r[1]}</dd>`).join("")}</dl>`;
function table(cols, rows) {
  if (!rows.length) return empty("这里还没有数据");
  return `<div class="ui-table-wrap ui-table-wrap--flush"><table class="ui-table"><thead><tr>${cols
    .map((c) => `<th${c.right ? ' class="ui-num"' : ""}>${esc(c.t)}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((cell, i) => `<td${cols[i] && cols[i].right ? ' class="ui-num"' : ""}>${cell}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}
/** 7 日柱状。取的是 tokens，因为运行次数看不出「一次跑了多大」 */
function bars7(last7) {
  const max = Math.max(1, ...last7.map((d) => d.tokens));
  return `<div class="ad-bars">${last7
    .map((d) => {
      const h = Math.round((d.tokens / max) * 100);
      return `<div class="b" title="${esc(d.day)}：${num(d.runs)} 次 · ${num(d.tokens)} tokens"><i style="height:${Math.max(2, h)}%"></i><u>${esc(d.day.slice(5))}</u></div>`;
    })
    .join("")}</div>`;
}
/** 多行输入比一行控件高得多，跟标签垂直居中对齐会让标签浮在半空，所以自动改顶对齐 */
const field = (label, desc, control) =>
  `<div class="ad-field${/<textarea/.test(control) ? " ad-field--top" : ""}"><div><div class="fl">${esc(label)}</div>${
    desc ? `<div class="fd">${desc}</div>` : ""
  }</div><div class="fc">${control}</div></div>`;
const sw = (name, on) =>
  `<label class="ui-switch"><input type="checkbox" data-k="${esc(name)}"${on ? " checked" : ""}${RO ? " disabled" : ""}><i></i></label>`;
const inp = (name, value, extra) =>
  `<input class="ui-input" data-k="${esc(name)}" value="${esc(value == null ? "" : value)}"${RO ? " disabled" : ""} ${extra || ""}>`;

/* ---------------- 状态 ---------------- */
let ME = null;          // 当前登录的人
let PLATFORM = false;   // 是不是平台管理员（默认组织的管理员）
let RO = false;         // 审计员：只读
let MULTI = false;      // 有没有开第二个组织

/* ---------------- 页面表 ---------------- */
/**
 * 侧边栏的分组照着「先看钱、再看人、最后看设置」排：
 * 一个管理员打开后台，八成是来看这个月花了多少、谁在花的，不是来改配置的。
 */
const NAV = [
  { grp: "", items: [{ id: "security", icon: "shield", title: "客户端安全", sub: "管住这个组织的成员在客户端能做什么" }] },
  {
    grp: "订阅与用量",
    items: [
      { id: "sub", icon: "wallet", title: "订阅管理", sub: "套餐、席位、到期时间和这个月的固定用量" },
      { id: "usage-member", icon: "users", title: "成员用量", sub: "每个人的额度、余额和累计消耗" },
      { id: "usage-org", icon: "building", title: "组织用量", sub: "整个组织今天/本月花了多少" },
      { id: "usage-app", icon: "blocks", title: "应用用量", sub: "按模型、按入口拆开看" },
      { id: "usage-detail", icon: "file-text", title: "用量明细", sub: "一条一条的流水，可导出" },
    ],
  },
  { grp: "数据统计", items: [{ id: "stats", icon: "chart", title: "数据统计", sub: "活跃、效率、缓存命中和成果文件占用" }] },
  {
    grp: "成员授权",
    items: [
      { id: "members", icon: "users", title: "成员与部门", sub: "加人、分部门、发邀请码" },
      { id: "pending", icon: "circle-check", title: "成员审核", sub: "自助注册进来的人在这里点头" },
      { id: "roles", icon: "key", title: "管理员角色", sub: "谁能改、谁只能查" },
    ],
  },
  {
    grp: "企业设置",
    items: [
      { id: "basic", icon: "settings", title: "基础设置", sub: "组织名和成员怎么进来" },
      { id: "net", icon: "globe", title: "网络设置", sub: "抓网页时放行哪些域名" },
      { id: "meter", icon: "zap", title: "计量设置", sub: "开不开用量闸门、每人每月发多少" },
      { id: "orgs", icon: "building", title: "组织管理", sub: "新建组织、给别的组织配套餐", platform: true },
      { id: "audit", icon: "clock", title: "操作审计", sub: "谁在什么时候改了什么" },
    ],
  },
  { grp: "开放与集成", items: [{ id: "integration", icon: "plug", title: "开放与集成", sub: "机器人渠道、MCP 和接口" }] },
];
const PAGES = {};

/* ============ 客户端安全 ============ */
PAGES.security = {
  load: () => api("/api/admin/org"),
  render: (d) => {
    const s = d.org.settings;
    return `<div class="ad-wrap">
      ${note("这页上的开关是<b>真的会拦人</b>的：关掉命令行之后，连工具定义都不会发给模型，它不会再想着用命令行去解决问题；登录有效期改小之后，<b>已经发出去</b>的登录状态立刻作废。")}
      ${card(`${secT("命令行", "关掉之后 run_shell / run_node 两个工具直接从模型的工具表里摘掉。写文件、抓网页、生成图表这些不受影响。")}
        <div style="margin-top:14px">
          ${field("允许运行命令行", "开着的时候，任务可以在这台服务器上执行 shell 命令和 Node 代码。安全要求高的组织建议关掉。", sw("allow_shell", s.allow_shell !== false))}
          ${field("登录有效期", "单位是天，1 - 365。改小之后成员手上已经登录的浏览器会在下一次请求时被踢出去，不用等他自己退出。", inp("session_days", s.session_days, 'type="number" min="1" max="365" style="width:120px"'))}
        </div>`)}
      ${saveBar()}
    </div>`;
  },
  bind: (root, d) => bindSettings(root, d),
};

/* ============ 订阅管理 ============ */
PAGES.sub = {
  load: () => api("/api/admin/overview"),
  render: (d) => {
    const p = d.plan;
    const seatPct = p.seats ? Math.min(100, Math.round((d.seats.used / p.seats) * 100)) : 0;
    const expBadge = p.expired
      ? badge("已过期", "destructive")
      : p.days_left != null && p.days_left <= 14
      ? badge(`还剩 ${p.days_left} 天`, "outline")
      : badge("订阅中", "success");
    return `<div class="ad-wrap">
      ${cardT(
        headRow(secT("订阅信息", esc(d.org.name) + " · " + esc(d.org.root_hint)), `${badge(p.label, "secondary")}${expBadge}`),
        `<div class="ad-card-b">${dl([
          ["当前版本", `<span class="v">${esc(p.label)}</span><div class="fd">决定席位上限和每月固定用量的默认值。</div>`],
          [
            "到期时间",
            `<span class="v ad-mono">${p.expires_at ? esc(fmtTs(p.expires_at)) : "长期有效"}</span>
             <div class="fd">${p.expires_at ? "到期后不影响已有数据，只是不能再新建成员。" : "没设到期时间，等于长期有效。"}</div>`,
          ],
          [
            "席位",
            `<div class="ad-row" style="gap:12px">
               <span class="v ad-num">${d.seats.used} / ${p.seats}</span>
               <div style="flex:1;min-width:120px;max-width:260px">${progress(seatPct)}</div>
               <span class="fd ad-num">${seatPct}%</span>
             </div>
             <div class="fd">${d.seats.pending ? `另有 ${d.seats.pending} 人等审核。` : ""}停用的成员不占席位。</div>`,
          ],
          ["创建时间", `<span class="v ad-mono">${esc(fmtDate(d.org.created_at))}</span>`],
        ])}</div>`
      )}

      ${note("<b>用量抵扣顺序：</b>先扣本月固定用量，扣完了再扣加油包余额。固定用量每月 1 号重置、<b>不累积</b>；加油包不过期。所以给成员充加油包不会顶掉他这个月的固定额度。")}

      ${card(`${secT("月固定用量", d.settings.credits_enabled ? "闸门开着：余额扣完就跑不动任务了。" : "闸门现在是<b>关</b>的：只记账、不拦人。要真拦人去「计量设置」打开。")}
        <div style="margin-top:14px">
          ${kpi([
            { label: "每人每月", value: num(d.monthly.per_member), hint: "在「计量设置」里改" },
            { label: "全组织已发放", value: num(d.monthly.granted), hint: "按成员实际额度合计" },
            { label: "本月已用固定额度", value: num(d.monthly.used) },
            { label: "本月消耗积分", value: num(d.monthly.credits), hint: "固定额度 + 加油包" },
          ])}
        </div>`)}

      ${PLATFORM
        ? card(`${secT("改套餐（平台管理员）", "这三项是「卖出去的东西」，只有平台管理员能动——分公司管理员在自己组织里权力再大，也不该能给自己加席位。")}
          <div style="margin-top:8px">
            ${field("套餐", "", `<select class="ui-input ui-select" data-o="plan" style="width:200px">${d.plans_html || ""}</select>`)}
            ${field("席位上限", "1 - 100000。", inpO("seats", p.seats, 'type="number" min="1" style="width:140px"'))}
            ${field("到期时间", "留空 = 长期有效。", inpO("expires_at", p.expires_at ? p.expires_at.slice(0, 10) : "", 'type="date" style="width:180px"'))}
          </div>
          <div class="ad-actions" style="margin-top:12px"><button class="ui-btn ui-btn--default ui-btn--sm" data-save-plan>保存套餐</button></div>`)
        : note("套餐、席位和到期时间由平台管理员维护，这里只能看。要升级找平台管理员。", true)}
    </div>`;
  },
  bind: async (root, d) => {
    const sel = root.querySelector('[data-o="plan"]');
    if (!sel) return;
    const meta = await api("/api/admin/org");
    sel.innerHTML = meta.plan_order
      .map((k) => `<option value="${k}"${k === d.plan.plan ? " selected" : ""}>${esc(meta.plans[k].label)}（${meta.plans[k].seats} 席）</option>`)
      .join("");
    root.querySelector("[data-save-plan]").onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const body = {
        plan: sel.value,
        seats: +root.querySelector('[data-o="seats"]').value || 1,
        expires_at: root.querySelector('[data-o="expires_at"]').value ? root.querySelector('[data-o="expires_at"]').value + "T23:59:59" : "",
      };
      try {
        await post("/api/admin/org", body);
        toast("套餐已保存");
        route(true);
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    };
  },
};
const inpO = (name, value, extra) => `<input class="ui-input" data-o="${esc(name)}" value="${esc(value == null ? "" : value)}" ${extra || ""}>`;

/* ============ 成员用量 ============ */
PAGES["usage-member"] = {
  load: () => api("/api/admin/usage?limit=1"),
  render: (d) => {
    const byUser = new Map(d.by_user.map((x) => [x.key, x]));
    const rows = d.members.map((m) => {
      const u = byUser.get(m.username) || { runs: 0, tokens: 0, credits: 0 };
      return [
        `<div style="font-weight:500">${esc(m.nickname || m.username)}</div><div class="fd ad-mono">${esc(m.username)}</div>`,
        esc(m.dept || "—"),
        badge(ROLE_LABEL[m.role] || m.role, m.role === "member" ? "outline" : "secondary"),
        num(m.monthly_quota),
        num(m.monthly_left),
        num(m.credits),
        `<b>${num(m.balance)}</b>`,
        num(u.runs),
        big(u.tokens),
        RO ? "" : `<button class="ui-btn ui-btn--outline ui-btn--xs" data-topup="${esc(m.username)}">充加油包</button>`,
      ];
    });
    const cols = [
      { t: "成员" }, { t: "部门" }, { t: "角色" },
      { t: "月额度", right: true }, { t: "本月剩余", right: true }, { t: "加油包", right: true }, { t: "可用合计", right: true },
      { t: "累计运行", right: true }, { t: "累计 tokens", right: true }, { t: "" },
    ];
    return `<div class="ad-wrap">
      ${note("「月额度 / 本月剩余 / 加油包」是当下的余额；右边两列<b>累计</b>是这个人从有记录以来的总消耗，不是本月。想看本月请去「组织用量」。")}
      ${cardT(secT("成员用量", "扣费顺序：先扣本月固定额度，再扣加油包。"), table(cols, rows))}
    </div>`;
  },
  bind: (root) => {
    root.querySelectorAll("[data-topup]").forEach((b) => {
      b.onclick = () =>
        modal({
          title: "给「" + b.dataset.topup + "」充加油包",
          fields: [{ name: "amount", label: "充多少", type: "number", value: 1000, desc: "1 - 1000000。加油包不过期，也不会顶掉本月的固定额度。" }],
          ok: "充值",
          onOk: async (v) => {
            await post("/api/admin/topup", { username: b.dataset.topup, amount: +v.amount });
            toast("充值成功");
            route(true);
          },
        });
    });
  },
};

/* ============ 组织用量 ============ */
PAGES["usage-org"] = {
  load: async () => {
    const [o, s] = await Promise.all([api("/api/admin/overview"), api("/api/admin/stats")]);
    return { o, s };
  },
  render: ({ o, s }) => {
    const deptRows = s.by_dept.map((x) => [esc(x.key), num(x.runs), big(x.tokens), num(x.credits), x.runs ? Math.round(x.elapsed_ms / x.runs / 1000) + " 秒" : "—"]);
    return `<div class="ad-wrap">
      ${card(`${secT("今天", "当天 0 点起算，按服务器本地时间。")}<div style="margin-top:14px">${kpi([
        { label: "运行次数", value: num(o.today.runs) },
        { label: "tokens", value: big(o.today.tokens) },
        { label: "消耗积分", value: num(o.today.credits) },
        { label: "平均耗时", value: o.today.runs ? Math.round(o.today.elapsed_ms / o.today.runs / 1000) + " 秒" : "—" },
      ])}</div>`)}
      ${card(`${secT("本月", "自然月，每月 1 号归零。")}<div style="margin-top:14px">${kpi([
        { label: "运行次数", value: num(o.month.runs) },
        { label: "tokens", value: big(o.month.tokens) },
        { label: "消耗积分", value: num(o.month.credits) },
        { label: "其中走固定额度", value: num(o.month.from_monthly) },
      ])}</div>`)}
      ${card(`${secT("最近 7 天", "柱子高度按 tokens 画，鼠标停上去看具体数。")}<div style="margin-top:16px">${bars7(o.last7)}</div>`)}
      ${cardT(
        secT("按部门（累计）", "流水记的是<b>花钱当时</b>那个人在哪个部门。人换了部门，老账不跟着搬——不然上个月的部门账会被改掉。"),
        table([{ t: "部门" }, { t: "运行", right: true }, { t: "tokens", right: true }, { t: "积分", right: true }, { t: "平均耗时", right: true }], deptRows)
      )}
    </div>`;
  },
};

/* ============ 应用用量 ============ */
PAGES["usage-app"] = {
  load: () => api("/api/admin/stats"),
  render: (s) => {
    const modelRows = s.by_model.map((x) => [`<span class="ad-mono">${esc(x.key)}</span>`, num(x.runs), big(x.tokens), num(x.credits), x.runs ? Math.round(x.elapsed_ms / x.runs / 1000) + " 秒" : "—"]);
    const srcRows = s.by_source.map((x) => [esc(SOURCE_LABEL[x.key] || x.key), num(x.runs), big(x.tokens), num(x.credits)]);
    return `<div class="ad-wrap">
      ${note("这两张表都是<b>累计</b>口径——从有记录以来的总量，不是本月。要看时间窗口去「组织用量」。")}
      ${cardT(
        secT("按模型", "同一个任务里换过模型的，按每次调用分别记。"),
        table([{ t: "模型" }, { t: "运行", right: true }, { t: "tokens", right: true }, { t: "积分", right: true }, { t: "平均耗时", right: true }], modelRows)
      )}
      ${cardT(
        secT("按入口", "任务是从哪儿发起的：网页工作台、飞书、定时任务…"),
        table([{ t: "入口" }, { t: "运行", right: true }, { t: "tokens", right: true }, { t: "积分", right: true }], srcRows)
      )}
    </div>`;
  },
};

/* ============ 用量明细 ============ */
let detailUser = "";
PAGES["usage-detail"] = {
  load: () => api("/api/admin/usage?limit=500" + (detailUser ? "&user=" + encodeURIComponent(detailUser) : "")),
  render: (d) => {
    const rows = d.detail.map((e) => [
      `<span class="ad-mono">${esc(fmtTs(e.ts))}</span>`,
      esc(e.user || "—"),
      e.kind === "topup" ? badge("充值", "success") : badge("运行", "secondary"),
      `<span class="ad-mono">${esc(e.model || "—")}</span>`,
      esc(SOURCE_LABEL[e.source] || e.source || "—"),
      e.kind === "topup" ? "—" : num((e.prompt || 0) + (e.completion || 0)),
      e.cached ? num(e.cached) : "—",
      num(e.credits),
      e.elapsed_ms ? Math.round(e.elapsed_ms / 1000) + " 秒" : "—",
    ]);
    const opts = ['<option value="">全部成员</option>']
      .concat(d.members.map((m) => `<option value="${esc(m.username)}"${m.username === detailUser ? " selected" : ""}>${esc(m.nickname || m.username)}</option>`))
      .join("");
    return `<div class="ad-wrap">
      ${cardT(
        headRow(
          secT("用量明细", `最近 ${d.detail.length} 条。再往前的记录还在服务器上，只是这页不往下翻——要全量请导出。`),
          `<select class="ui-input ui-select" data-user style="width:180px;height:32px;font-size:13px">${opts}</select>
           <button class="ui-btn ui-btn--outline ui-btn--sm" data-csv>${ic("download")} 导出 CSV</button>`
        ),
        table(
          [{ t: "时间" }, { t: "成员" }, { t: "类型" }, { t: "模型" }, { t: "入口" }, { t: "tokens", right: true }, { t: "命中缓存", right: true }, { t: "积分", right: true }, { t: "耗时", right: true }],
          rows
        )
      )}
    </div>`;
  },
  bind: (root, d) => {
    root.querySelector("[data-user]").onchange = (e) => { detailUser = e.target.value; route(true); };
    root.querySelector("[data-csv]").onclick = () => {
      const head = ["时间", "成员", "类型", "模型", "入口", "prompt", "completion", "命中缓存", "积分", "耗时毫秒"];
      const lines = [head.join(",")].concat(
        d.detail.map((e) =>
          [e.ts, e.user, e.kind, e.model || "", e.source || "", e.prompt || 0, e.completion || 0, e.cached || 0, e.credits || 0, e.elapsed_ms || 0]
            .map((x) => `"${String(x == null ? "" : x).replace(/"/g, '""')}"`)
            .join(",")
        )
      );
      // ﻿：不加这个 BOM，Excel 打开中文表头是乱码
      const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `用量明细_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast("已导出 " + d.detail.length + " 条");
    };
  },
};

/* ============ 数据统计 ============ */
PAGES.stats = {
  load: () => api("/api/admin/stats"),
  render: (s) => {
    const t = s.totals;
    const userRows = s.by_user.map((x) => [esc(x.key), num(x.runs), big(x.tokens), num(x.credits), x.runs ? Math.round(x.elapsed_ms / x.runs / 1000) + " 秒" : "—"]);
    return `<div class="ad-wrap">
      ${card(`${secT("总览", "运行相关的口径都是<b>本月</b>；缓存命中率只算记过这个字段的那些条。")}<div style="margin-top:14px">${kpi([
        { label: "成员数", value: num(t.members) },
        { label: "今日活跃", value: num(t.active_today), hint: "今天跑过任务的人" },
        { label: "本月运行", value: num(t.runs_month) },
        { label: "本月 tokens", value: big(t.tokens_month) },
        { label: "本月积分", value: num(t.credits_month) },
        { label: "缓存命中率", value: t.cache_hit == null ? "—" : t.cache_hit + "%", hint: t.cache_hit == null ? "还没有带这个字段的记录" : "命中越高越省钱" },
        { label: "平均耗时", value: t.avg_ms ? Math.round(t.avg_ms / 1000) + " 秒" : "—" },
        s.storage
          ? { label: "成果文件", value: num(s.storage.files), hint: mb(s.storage.bytes) }
          : { label: "成果文件", value: "—", hint: "读不到这个组织的目录" },
      ])}</div>`)}
      ${card(`${secT("最近 7 天")}<div style="margin-top:16px">${bars7(s.last7)}</div>`)}
      ${cardT(
        secT("成员排行（累计）", "按 tokens 从多到少，最多 20 人。"),
        table([{ t: "成员" }, { t: "运行", right: true }, { t: "tokens", right: true }, { t: "积分", right: true }, { t: "平均耗时", right: true }], userRows)
      )}
    </div>`;
  },
};

/* ============ 成员与部门 ============ */
PAGES.members = {
  load: async () => {
    const [m, i] = await Promise.all([api("/api/admin/members"), api("/api/admin/invites")]);
    return { m, i };
  },
  render: ({ m, i }) => {
    const rows = m.members.map((u) => [
      `<div style="font-weight:500">${esc(u.nickname || u.username)}${u.owner ? " " + badge("所有者", "outline") : ""}</div><div class="fd ad-mono">${esc(u.username)}</div>`,
      badge(ROLE_LABEL[u.role] || u.role, u.role === "member" ? "outline" : "secondary"),
      esc(u.dept || "—"),
      u.status === "active" ? badge("正常", "success") : u.status === "pending" ? badge("待审核") : badge("已停用", "destructive"),
      num(u.balance),
      `<span class="fd">${esc(ago(u.last_active))}</span>`,
      RO
        ? ""
        : `<div class="ad-actions">
            <button class="ui-btn ui-btn--ghost ui-btn--xs" data-edit="${esc(u.username)}">${ic("pencil", "i-sm")} 改</button>
            <button class="ui-btn ui-btn--ghost ui-btn--xs" data-pwd="${esc(u.username)}">${ic("key", "i-sm")} 重置密码</button>
            ${u.owner ? "" : `<button class="ui-btn ui-btn--ghost ui-btn--xs" data-del="${esc(u.username)}">${ic("trash", "i-sm")}</button>`}
          </div>`,
    ]);
    const deptChips = m.depts.length
      ? m.depts
          .map(
            (d) =>
              `<span class="ui-badge ui-badge--secondary" style="gap:4px">${esc(d.name)}${
                RO ? "" : `<button class="ui-btn ui-btn--ghost ui-btn--icon" style="width:16px;height:16px;padding:0" data-deldept="${esc(d.id)}" title="删除部门">${ic("x", "i-sm")}</button>`
              }</span>`
          )
          .join(" ")
      : `<span class="fd">还没有部门。分了部门之后，用量能按部门拆开看。</span>`;
    const invRows = i.invites.map((v) => [
      `<span class="ad-mono" style="font-weight:600">${esc(v.code)}</span>`,
      badge(ROLE_LABEL[v.role] || v.role, "outline"),
      esc(v.dept || "—"),
      `${v.uses} / ${v.max_uses}`,
      `<span class="ad-mono">${esc(fmtDate(v.expires_at))}</span>`,
      v.expired ? badge("已过期", "destructive") : v.used_up ? badge("已用完") : badge("可用", "success"),
      RO
        ? ""
        : `<div class="ad-actions">
            <button class="ui-btn ui-btn--ghost ui-btn--xs" data-copy="${esc(v.code)}">${ic("copy", "i-sm")} 复制</button>
            <button class="ui-btn ui-btn--ghost ui-btn--xs" data-revoke="${esc(v.code)}">${ic("trash", "i-sm")}</button>
          </div>`,
    ]);
    return `<div class="ad-wrap">
      ${cardT(
        headRow(
          secT("成员", `共 ${m.members.length} 人。停用的成员不占席位，账号和他产出的文件都还在。`),
          RO ? "" : `<button class="ui-btn ui-btn--default ui-btn--sm" data-add>${ic("plus")} 添加成员</button>`
        ),
        table([{ t: "成员" }, { t: "角色" }, { t: "部门" }, { t: "状态" }, { t: "可用余额", right: true }, { t: "最近活跃" }, { t: "" }], rows)
      )}

      ${card(`${headRow(
        secT("部门", "只是个标签，用来把用量拆开看，不影响权限。"),
        RO ? "" : `<button class="ui-btn ui-btn--outline ui-btn--sm" data-adddept>${ic("plus")} 新建部门</button>`
      )}
      <div class="ad-row" style="margin-top:14px">${deptChips}</div>`)}

      ${cardT(
        headRow(
          secT("邀请码", "比开放注册安全得多：能限次数、能设过期、能预先指定角色和部门，撤销也只影响还没用的那批人。"),
          RO ? "" : `<button class="ui-btn ui-btn--outline ui-btn--sm" data-addinv>${ic("plus")} 生成邀请码</button>`
        ),
        table([{ t: "邀请码" }, { t: "角色" }, { t: "部门" }, { t: "已用" }, { t: "到期" }, { t: "状态" }, { t: "" }], invRows)
      )}
    </div>`;
  },
  bind: (root, { m }) => {
    const deptOpts = [{ value: "", label: "（不分部门）" }].concat(m.depts.map((d) => ({ value: d.name, label: d.name })));
    const roleOpts = [
      { value: "member", label: "成员 —— 只能用，看不到后台" },
      { value: "auditor", label: "审计员 —— 能查账，改不动" },
      { value: "admin", label: "管理员 —— 能改所有东西" },
    ];
    const add = root.querySelector("[data-add]");
    if (add)
      add.onclick = () =>
        modal({
          title: "添加成员",
          fields: [
            { name: "username", label: "登录名", placeholder: "字母数字，建议用工号或邮箱前缀", desc: "登录名<b>之后不能改</b>——改了就等于换了个账号。" },
            { name: "role", label: "角色", type: "select", options: roleOpts, value: "member" },
            { name: "dept", label: "部门", type: "select", options: deptOpts, value: "" },
            { name: "monthly_quota", label: "每月固定额度", type: "number", placeholder: "留空 = 跟随团队设置", desc: "只想给某个人开小灶时才填。" },
          ],
          ok: "创建",
          onOk: async (v) => {
            const r = await post("/api/admin/members", v);
            showPassword(r.user.username, r.password, "账号建好了");
            route(true);
          },
        });

    root.querySelectorAll("[data-edit]").forEach((b) => {
      const u = m.members.find((x) => x.username === b.dataset.edit);
      b.onclick = () =>
        modal({
          title: "修改「" + (u.nickname || u.username) + "」",
          fields: [
            { name: "role", label: "角色", type: "select", options: roleOpts, value: u.role },
            { name: "dept", label: "部门", type: "select", options: deptOpts, value: u.dept || "" },
            {
              name: "status", label: "状态", type: "select", value: u.status,
              options: [
                { value: "active", label: "正常" },
                { value: "disabled", label: "停用 —— 立刻踢掉他所有已登录的浏览器" },
              ],
            },
            { name: "monthly_quota", label: "每月固定额度", type: "number", value: u.monthly_quota == null ? "" : u.monthly_quota, desc: "留空 = 跟随团队设置。" },
          ],
          ok: "保存",
          onOk: async (v) => {
            await post("/api/admin/members/" + encodeURIComponent(u.username), {
              role: v.role, dept: v.dept, status: v.status,
              monthly_quota: v.monthly_quota === "" ? null : +v.monthly_quota,
            });
            toast("已保存");
            route(true);
          },
        });
    });

    root.querySelectorAll("[data-pwd]").forEach((b) => {
      b.onclick = () =>
        confirmBox(
          "重置「" + b.dataset.pwd + "」的密码",
          "会生成一串新的随机密码。<b>只显示这一次</b>，服务器上不会留明文，也不进审计记录。他手上已经登录的浏览器不受影响。",
          "重置",
          async () => {
            const r = await post("/api/admin/members/" + encodeURIComponent(b.dataset.pwd) + "/reset-password");
            showPassword(b.dataset.pwd, r.password, "新密码");
          }
        );
    });

    root.querySelectorAll("[data-del]").forEach((b) => {
      b.onclick = () =>
        confirmBox(
          "删除成员「" + b.dataset.del + "」",
          "账号会被删掉，他<b>已经产出的文件和历史用量记录还在</b>。只是想让他登不进来的话，用「改 → 状态 → 停用」更合适。",
          "删除",
          async () => {
            await del("/api/admin/members/" + encodeURIComponent(b.dataset.del));
            toast("已删除");
            route(true);
          },
          true
        );
    });

    const ad = root.querySelector("[data-adddept]");
    if (ad)
      ad.onclick = () =>
        modal({
          title: "新建部门",
          fields: [{ name: "name", label: "部门名", placeholder: "比如：市场部", desc: "最多 24 个字。" }],
          ok: "创建",
          onOk: async (v) => { await post("/api/admin/depts", { name: v.name }); toast("部门已创建"); route(true); },
        });
    root.querySelectorAll("[data-deldept]").forEach((b) => {
      b.onclick = () =>
        confirmBox("删除部门", "已经在这个部门里的成员会变成「不分部门」。<b>历史用量记录不动</b>——账本记的是花钱当时的部门。", "删除", async () => {
          await del("/api/admin/depts/" + encodeURIComponent(b.dataset.deldept));
          toast("已删除");
          route(true);
        }, true);
    });

    const ai = root.querySelector("[data-addinv]");
    if (ai)
      ai.onclick = () =>
        modal({
          title: "生成邀请码",
          fields: [
            { name: "role", label: "拿这个码注册的人是什么角色", type: "select", options: roleOpts, value: "member" },
            { name: "dept", label: "自动分到哪个部门", type: "select", options: deptOpts, value: "" },
            { name: "max_uses", label: "最多能用几次", type: "number", value: 1, desc: "1 - 1000。发给一个人就填 1。" },
            { name: "days", label: "几天后过期", type: "number", value: 7, desc: "1 - 365。" },
          ],
          ok: "生成",
          onOk: async (v) => {
            const inv = await post("/api/admin/invites", v);
            copyText(inv.code);
            toast("邀请码 " + inv.code + " 已生成并复制");
            route(true);
          },
        });
    root.querySelectorAll("[data-copy]").forEach((b) => {
      b.onclick = () => { copyText(b.dataset.copy); toast("已复制 " + b.dataset.copy); };
    });
    root.querySelectorAll("[data-revoke]").forEach((b) => {
      b.onclick = () =>
        confirmBox("撤销邀请码 " + b.dataset.revoke, "已经用这个码注册进来的人<b>不受影响</b>，只是这个码之后用不了了。", "撤销", async () => {
          await del("/api/admin/invites/" + encodeURIComponent(b.dataset.revoke));
          toast("已撤销");
          route(true);
        }, true);
    });
  },
};

function showPassword(username, password, title) {
  modal({
    title: title || "密码",
    body: `<div class="fd" style="font-size:14px;color:var(--foreground)">把下面这串发给 <b>${esc(username)}</b>。<b>关掉这个框就再也看不到了</b>——服务器上不存明文，只能重置。</div>
      <div class="ad-mono" style="margin-top:8px;padding:12px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--muted);word-break:break-all;font-size:15px">${esc(password)}</div>`,
    fields: [],
    ok: "复制并关闭",
    onOk: async () => { copyText(password); toast("已复制"); },
  });
}
function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).catch(() => fallbackCopy(t));
  fallbackCopy(t);
}
function fallbackCopy(t) {
  const ta = document.createElement("textarea");
  ta.value = t;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch { /* 非安全上下文里复制不了，用户手动选也行 */ }
  ta.remove();
}

/* ============ 成员审核 ============ */
PAGES.pending = {
  load: () => api("/api/admin/pending"),
  render: (d) => {
    const rows = d.members.map((u) => [
      `<div style="font-weight:500">${esc(u.nickname || u.username)}</div><div class="fd ad-mono">${esc(u.username)}</div>`,
      esc(u.dept || "—"),
      badge(ROLE_LABEL[u.role] || u.role, "outline"),
      `<span class="ad-mono">${esc(fmtTs(u.created_at))}</span>`,
      RO
        ? ""
        : `<div class="ad-actions">
            <button class="ui-btn ui-btn--default ui-btn--xs" data-pass="${esc(u.username)}">${ic("check", "i-sm")} 通过</button>
            <button class="ui-btn ui-btn--outline ui-btn--xs" data-reject="${esc(u.username)}">拒绝</button>
          </div>`,
    ]);
    return `<div class="ad-wrap">
      ${d.members.length
        ? note(`有 <b>${d.members.length}</b> 个人在等你点头。通过之后他就能登录了；拒绝 = 直接删号——人还没进来过，留着只会占席位。`, true)
        : note("没有待审核的人。开放注册 + 需要审核这两个开关都在「基础设置」里。")}
      ${cardT(
        secT("待审核"),
        table([{ t: "申请人" }, { t: "部门" }, { t: "角色" }, { t: "申请时间" }, { t: "" }], rows)
      )}
    </div>`;
  },
  bind: (root) => {
    root.querySelectorAll("[data-pass]").forEach((b) => {
      b.onclick = async () => {
        await act(() => post("/api/admin/pending/" + encodeURIComponent(b.dataset.pass), { action: "approve" }), "已通过，他现在可以登录了");
        route(true);
      };
    });
    root.querySelectorAll("[data-reject]").forEach((b) => {
      b.onclick = () =>
        confirmBox("拒绝「" + b.dataset.reject + "」", "会把这个账号<b>直接删掉</b>。他可以拿新的邀请码重新申请。", "拒绝并删除", async () => {
          await post("/api/admin/pending/" + encodeURIComponent(b.dataset.reject), { action: "reject" });
          toast("已拒绝");
          route(true);
        }, true);
    });
  },
};

/* ============ 管理员角色 ============ */
PAGES.roles = {
  load: () => api("/api/admin/members"),
  render: (d) => {
    const staff = d.members.filter((u) => u.role === "admin" || u.role === "auditor");
    const rows = staff.map((u) => [
      `<div style="font-weight:500">${esc(u.nickname || u.username)}${u.owner ? " " + badge("所有者", "outline") : ""}</div><div class="fd ad-mono">${esc(u.username)}</div>`,
      badge(ROLE_LABEL[u.role], "secondary"),
      esc(u.dept || "—"),
      `<span class="fd">${esc(ago(u.last_active))}</span>`,
      RO || u.owner ? "" : `<button class="ui-btn ui-btn--ghost ui-btn--xs" data-demote="${esc(u.username)}">降为成员</button>`,
    ]);
    const others = d.members.filter((u) => u.role === "member" && u.status !== "disabled");
    return `<div class="ad-wrap">
      ${card(`${secT("三种角色", "后端是按这三档拦的，不是界面上藏一藏而已。")}
        <div style="margin-top:14px">
          ${field("成员", "只能用工作台，进不来这个后台。", badge("默认", "outline"))}
          ${field("审计员", "后台<b>全部能看</b>，一个字都改不了。合规、外包、财务对账用得上——给他看账，不给他动手。", badge("只读", "secondary"))}
          ${field("管理员", "后台里所有东西都能改，包括加人、改额度、改安全开关。", badge("可写", "secondary"))}
          ${field("平台管理员", "默认组织的管理员。<b>只有他</b>能新建组织、改别的组织的套餐席位，以及改引擎、密钥、MCP 这些服务器级设置。这个身份不能在界面上授予。", PLATFORM ? badge("就是你", "success") : badge("不是你", "outline"))}
        </div>`)}
      ${cardT(
        headRow(
          secT("当前的管理员和审计员", `共 ${staff.length} 人。组织所有者不能被别的管理员降级或删除——不然两个管理员能互相踢。`),
          RO || !others.length ? "" : `<button class="ui-btn ui-btn--outline ui-btn--sm" data-promote>${ic("plus")} 提升成员</button>`
        ),
        table([{ t: "成员" }, { t: "角色" }, { t: "部门" }, { t: "最近活跃" }, { t: "" }], rows)
      )}
    </div>`;
  },
  bind: (root, d) => {
    const others = d.members.filter((u) => u.role === "member" && u.status !== "disabled");
    const p = root.querySelector("[data-promote]");
    if (p)
      p.onclick = () =>
        modal({
          title: "提升成员",
          fields: [
            { name: "username", label: "选一个人", type: "select", options: others.map((u) => ({ value: u.username, label: (u.nickname || u.username) + "（" + u.username + "）" })) },
            {
              name: "role", label: "提升为", type: "select", value: "auditor",
              options: [
                { value: "auditor", label: "审计员 —— 能查账，改不动" },
                { value: "admin", label: "管理员 —— 能改所有东西" },
              ],
            },
          ],
          ok: "提升",
          onOk: async (v) => {
            await post("/api/admin/members/" + encodeURIComponent(v.username), { role: v.role });
            toast("已提升为" + ROLE_LABEL[v.role]);
            route(true);
          },
        });
    root.querySelectorAll("[data-demote]").forEach((b) => {
      b.onclick = () =>
        confirmBox("把「" + b.dataset.demote + "」降为成员", "降完之后他<b>进不来这个后台</b>了，工作台照常用。", "降级", async () => {
          await post("/api/admin/members/" + encodeURIComponent(b.dataset.demote), { role: "member" });
          toast("已降为成员");
          route(true);
        });
    });
  },
};

/* ============ 企业设置：基础 / 网络 / 计量 ============ */
/** 三页共用一个「保存」条：改了才亮，没改就是灰的，省得每次都要猜自己到底改没改 */
function saveBar() {
  if (RO) return note("你是<b>审计员</b>：这页能看，改不了。要改找管理员。", true);
  return `<div class="ad-actions"><span class="fd" data-dirty style="margin-right:auto;align-self:center;display:none">有改动还没保存</span>
    <button class="ui-btn ui-btn--default ui-btn--sm" data-save disabled>保存</button></div>`;
}
function bindSettings(root, d) {
  if (RO) return;
  const btn = root.querySelector("[data-save]");
  const tip = root.querySelector("[data-dirty]");
  if (!btn) return;
  const ctls = [...root.querySelectorAll("[data-k]")];
  const readAll = () => {
    const out = {};
    for (const c of ctls) {
      const k = c.dataset.k;
      if (c.type === "checkbox") out[k] = c.checked;
      else if (c.dataset.list === "1") out[k] = c.value.split(/[\s,，、\n]+/).map((x) => x.trim()).filter(Boolean);
      else if (c.type === "number") out[k] = +c.value || 0;
      else out[k] = c.value;
    }
    return out;
  };
  const base = JSON.stringify(readAll());
  const check = () => {
    const dirty = JSON.stringify(readAll()) !== base;
    btn.disabled = !dirty;
    tip.style.display = dirty ? "" : "none";
  };
  ctls.forEach((c) => { c.addEventListener("input", check); c.addEventListener("change", check); });
  btn.onclick = async () => {
    btn.disabled = true;
    const all = readAll();
    // 组织名不属于 settings，它是组织本身的字段
    const body = { settings: {} };
    for (const [k, v] of Object.entries(all)) {
      if (k === "name") body.name = v;
      else body.settings[k] = v;
    }
    try {
      await post("/api/admin/org", body);
      toast("已保存，立刻生效");
      route(true);
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
    }
  };
}

PAGES.basic = {
  load: () => api("/api/admin/org"),
  render: (d) => {
    const s = d.org.settings;
    return `<div class="ad-wrap">
      ${card(`${secT("组织")}
        <div style="margin-top:14px">
          ${field("组织名", "最多 40 个字。成员在工作台上看到的就是这个名字。", inp("name", d.org.name, 'style="width:220px"'))}
          ${field("组织 ID", "系统生成，不能改。接口和日志里认的是这个。", `<span class="ad-mono fd">${esc(d.org.id)}</span>`)}
        </div>`)}
      ${card(`${secT("成员怎么进来", "两条路：管理员直接加人，或者发邀请码。开放注册是第三条，最松。")}
        <div style="margin-top:14px">
          ${field("开放自助注册", "打开之后，<b>任何人</b>只要能访问到这个地址就能自己注册。放在公网上的部署强烈建议关掉，改用邀请码。", sw("open_register", s.open_register))}
          ${field("注册后需要审核", "只在开放注册打开时才有意义：注册进来的人先挂在「成员审核」里，你点头了才能登录。", sw("need_approval", s.need_approval))}
        </div>`)}
      ${saveBar()}
    </div>`;
  },
  bind: (root, d) => bindSettings(root, d),
};

PAGES.net = {
  load: () => api("/api/admin/org"),
  render: (d) => {
    const s = d.org.settings;
    const ta = (k, v, ph) =>
      `<textarea class="ui-input" data-k="${k}" data-list="1" rows="5" style="width:280px;height:auto;resize:vertical;font-family:var(--font-mono);font-size:13px" placeholder="${esc(ph)}"${RO ? " disabled" : ""}>${esc((v || []).join("\n"))}</textarea>`;
    return `<div class="ad-wrap">
      ${note("这两个名单管的是任务里的<b>抓网页</b>和<b>渲染网页</b>两个工具。填域名就行，一行一个。<code>example.com</code> 会连 <code>a.example.com</code> 一起覆盖，但不会误伤 <code>evilexample.com</code>。")}
      ${card(`${secT("域名放行")}
        <div style="margin-top:14px">
          ${field("白名单", "<b>留空 = 不限制</b>。一旦填了东西，就只有名单里的域名能抓，其它全拦。", ta("net_allow", s.net_allow, "example.com\ndocs.company.cn"))}
          ${field("黑名单", "优先级高于白名单：同时命中两边，还是拦。", ta("net_deny", s.net_deny, "facebook.com\ninternal-admin.company.cn"))}
        </div>`)}
      ${(s.net_allow || []).length || (s.net_deny || []).length
        ? note(`现在的状态：${(s.net_allow || []).length ? `<b>只放行</b> ${(s.net_allow || []).length} 个域名` : "不限白名单"}，${(s.net_deny || []).length ? `另外拦掉 ${(s.net_deny || []).length} 个` : "没有黑名单"}。`, true)
        : note("两个名单都是空的：抓网页不受限制。")}
      ${saveBar()}
    </div>`;
  },
  bind: (root, d) => bindSettings(root, d),
};

PAGES.meter = {
  load: () => api("/api/admin/org"),
  render: (d) => {
    const s = d.org.settings;
    return `<div class="ad-wrap">
      ${note("<b>闸门关着的时候只记账、不拦人。</b>这是故意的默认值：一上来就拦，容易在你还没搞清楚用量分布之前就把人卡死。先开着看两周账，再决定要不要拦。")}
      ${card(`${secT("用量闸门")}
        <div style="margin-top:14px">
          ${field("余额扣完就不让跑", "打开之后，可用余额（本月固定额度 + 加油包）为 0 的成员发不出任务。关着就只记账。", sw("credits_enabled", s.credits_enabled))}
          ${field("每人每月固定额度", "每月 1 号重置，<b>不累积</b>。填 0 = 不发月额度，只用加油包。", inp("member_monthly_credits", s.member_monthly_credits, 'type="number" min="0" style="width:140px"'))}
          ${field("新成员的加油包初始余额", "只在建号那一刻发一次。加油包不过期。", inp("default_member_credits", s.default_member_credits, 'type="number" min="0" style="width:140px"'))}
        </div>`)}
      ${note("<b>扣费顺序：</b>先扣本月固定额度，扣完了才动加油包。所以充加油包不会浪费掉这个月还没用的固定额度。", true)}
      ${saveBar()}
    </div>`;
  },
  bind: (root, d) => bindSettings(root, d),
};

/* ============ 组织管理（平台管理员）============ */
PAGES.orgs = {
  load: () => api("/api/admin/orgs"),
  render: (d) => {
    const rows = d.orgs.map((o) => [
      `<div style="font-weight:500">${esc(o.name)}</div><div class="fd ad-mono">${esc(o.id)}</div>`,
      badge(o.label, o.expired ? "destructive" : "secondary"),
      `${o.active} / ${o.seats}`,
      o.expires_at ? `<span class="ad-mono">${esc(fmtDate(o.expires_at))}</span>${o.expired ? " " + badge("已过期", "destructive") : ""}` : "长期",
      `<span class="fd">${esc(o.root_dir || (o.id === "default" ? "默认工作目录" : "自动分配"))}</span>`,
      RO ? "" : `<button class="ui-btn ui-btn--ghost ui-btn--xs" data-org="${esc(o.id)}">${ic("pencil", "i-sm")} 改</button>`,
    ]);
    return `<div class="ad-wrap">
      ${note("<b>租户边界划在工作目录上，不划在整台机器上。</b>真隔离的是：成果文件、会话、账号、席位、用量账本、权限、审计。<b>不隔离</b>的是：引擎和密钥、MCP、技能、专家、记忆库、素材库、定时任务、备份——这些配的是<b>这台服务器</b>，归你（平台管理员）管，各组织共用。")}
      ${cardT(
        headRow(
          secT("组织", `共 ${d.orgs.length} 个。只有一个组织的时候，整套「组织」概念对普通成员是隐身的。`),
          RO ? "" : `<button class="ui-btn ui-btn--default ui-btn--sm" data-neworg>${ic("plus")} 新建组织</button>`
        ),
        table([{ t: "组织" }, { t: "套餐" }, { t: "在用席位" }, { t: "到期" }, { t: "工作目录" }, { t: "" }], rows)
      )}
    </div>`;
  },
  bind: (root, d) => {
    const planOpts = d.plan_order.map((k) => ({ value: k, label: `${d.plans[k].label}（${d.plans[k].seats} 席 · 月额度 ${num(d.plans[k].monthly_credits)}）` }));
    const n = root.querySelector("[data-neworg]");
    if (n)
      n.onclick = () =>
        modal({
          title: "新建组织",
          body: `<div class="fd">新组织会拿到一个<b>独立的工作目录</b>，里面的成员看不到别的组织的文件。引擎、密钥、MCP 这些还是共用这台服务器上的。</div>`,
          fields: [
            { name: "name", label: "组织名", placeholder: "比如：华东分公司", desc: "最多 40 个字，不能重名。" },
            { name: "plan", label: "套餐", type: "select", options: planOpts, value: "team" },
            { name: "seats", label: "席位上限", type: "number", placeholder: "留空 = 用套餐默认值" },
            { name: "expires_at", label: "到期时间", type: "date", desc: "留空 = 长期有效。" },
          ],
          ok: "创建",
          onOk: async (v) => {
            await post("/api/admin/orgs", {
              name: v.name, plan: v.plan,
              seats: v.seats ? +v.seats : undefined,
              expires_at: v.expires_at ? v.expires_at + "T23:59:59" : "",
            });
            toast("组织已创建");
            route(true);
          },
        });
    root.querySelectorAll("[data-org]").forEach((b) => {
      const o = d.orgs.find((x) => x.id === b.dataset.org);
      b.onclick = () =>
        modal({
          title: "修改「" + o.name + "」",
          fields: [
            { name: "name", label: "组织名", value: o.name },
            { name: "plan", label: "套餐", type: "select", options: planOpts, value: o.plan },
            { name: "seats", label: "席位上限", type: "number", value: o.seats },
            { name: "expires_at", label: "到期时间", type: "date", value: o.expires_at ? o.expires_at.slice(0, 10) : "", desc: "留空 = 长期有效。" },
          ],
          ok: "保存",
          onOk: async (v) => {
            await post("/api/admin/orgs/" + encodeURIComponent(o.id), {
              name: v.name, plan: v.plan, seats: +v.seats || 1,
              expires_at: v.expires_at ? v.expires_at + "T23:59:59" : "",
            });
            toast("已保存");
            route(true);
          },
        });
    });
  },
};

/* ============ 操作审计 ============ */
PAGES.audit = {
  load: () => api("/api/admin/audit?limit=300"),
  render: (d) => {
    const rows = d.audit.map((a) => [
      `<span class="ad-mono">${esc(fmtTs(a.ts))}</span>`,
      esc(a.actor || "系统"),
      badge(a.action, "outline"),
      esc(a.target || "—"),
      `<span class="fd">${esc(a.detail || "")}</span>`,
    ]);
    return `<div class="ad-wrap">
      ${note("记的是<b>管理动作</b>：谁加了人、谁改了额度、谁动了安全开关。任务本身跑了什么在「用量明细」里。密码、密钥这类东西<b>不会</b>进这张表。")}
      ${cardT(
        secT("操作审计", `最近 ${d.audit.length} 条。`),
        table([{ t: "时间" }, { t: "操作人" }, { t: "动作" }, { t: "对象" }, { t: "详情" }], rows)
      )}
    </div>`;
  },
};

/* ============ 开放与集成 ============ */
PAGES.integration = {
  load: () => api("/api/admin/overview"),
  render: () => {
    const row = (name, desc, where) =>
      field(name, desc, `<span class="fd" style="text-align:right;max-width:200px">${where}</span>`);
    return `<div class="ad-wrap">
      ${note("下面这些渠道配的是<b>这台服务器</b>，不是单个组织——一个飞书机器人对应一个部署。所以入口在工作台的设置里，归平台管理员管，这页只做个索引。")}
      ${card(`${secT("机器人渠道", "接上之后，成员在聊天软件里 @ 一下就能发任务，产出直接回到会话里。")}
        <div style="margin-top:14px">
          ${row("飞书 / Lark", "支持扫码绑定，不用手填 App ID。", "工作台 → 设置 → 消息渠道")}
          ${row("企业微信", "自建应用或群机器人 Webhook 二选一。", "工作台 → 设置 → 消息渠道")}
          ${row("钉钉", "群机器人 Webhook。", "工作台 → 设置 → 消息渠道")}
          ${row("QQ / 微信公众号", "需要对应平台的开发者资质。", "工作台 → 设置 → 消息渠道")}
        </div>`)}
      ${card(`${secT("能力扩展")}
        <div style="margin-top:14px">
          ${row("MCP 服务器", "把外部系统的工具接进来给任务用。", "工作台 → 设置 → MCP")}
          ${row("技能与专家", "把重复的活儿固化成可复用的流程。", "工作台 → 技能 / 专家")}
          ${row("定时任务", "让任务按点自己跑，产出推到聊天软件里。", "工作台 → 定时任务")}
        </div>`)}
      ${card(`${secT("对外接口", "现在还没有<b>按组织发放的 API 密钥</b>——所以这里不给你一个点了没用的开关。")}
        <div style="margin-top:14px">
          ${row("HTTP 接口", "服务端接口走的是登录态（Cookie），拿浏览器里的登录状态就能调。适合内网脚本，不适合发给第三方。", "同源调用")}
          ${row("独立 API 密钥", "还没做。要给第三方系统调用，暂时的办法是单独建一个成员账号，用它的登录态。", "尚未支持")}
        </div>`)}
    </div>`;
  },
};

/* ---------------- 导航 + 路由 ---------------- */
function renderNav(current) {
  $("ad-nav").innerHTML = NAV.map((g) => {
    const items = g.items.filter((it) => !it.platform || PLATFORM);
    if (!items.length) return "";
    return (
      (g.grp ? `<div class="ad-grp">${esc(g.grp)}</div>` : "") +
      items
        .map(
          (it) =>
            `<a class="ad-nav-i${it.id === current ? " on" : ""}" href="#/${it.id}">${ic(it.icon)}<span>${esc(it.title)}</span></a>`
        )
        .join("")
    );
  }).join("");
}
function navItem(id) {
  for (const g of NAV) for (const it of g.items) if (it.id === id) return it;
  return null;
}

let routeSeq = 0;
async function route(keepScroll) {
  const id = (location.hash.replace(/^#\/?/, "") || "sub").split("?")[0];
  const it = navItem(id) && PAGES[id] ? navItem(id) : navItem("sub");
  const pid = it.id;
  if (it.platform && !PLATFORM) return (location.hash = "#/sub");
  const seq = ++routeSeq;
  const body = $("ad-body");
  const scroll = keepScroll ? body.scrollTop : 0;

  renderNav(pid);
  $("ad-title").textContent = it.title;
  $("ad-sub").textContent = it.sub;
  $("ad-top-r").innerHTML = `${RO ? badge("只读（审计员）", "outline") : ""}
    <button class="ui-btn ui-btn--ghost ui-btn--sm" id="ad-refresh" title="重新拉一次数据">${ic("refresh-cw")}</button>`;
  $("ad-refresh").onclick = () => route(true);
  body.innerHTML = `<div class="ad-wrap"><div class="ui-skeleton" style="height:120px"></div><div class="ui-skeleton" style="height:220px"></div></div>`;

  const page = PAGES[pid];
  try {
    const data = await page.load();
    if (seq !== routeSeq) return; // 用户在等数据的时候又点了别的页，这份结果作废
    body.innerHTML = page.render(data);
    if (page.bind) await page.bind(body, data);
    body.scrollTop = scroll;
  } catch (e) {
    if (seq !== routeSeq) return;
    body.innerHTML = gate(e);
  }
}

function gate(e) {
  const s = e.status;
  if (s === 401)
    return `<div class="ad-gate">${ic("lock")}<div class="ad-sec-t">先登录</div>
      <div class="ad-sec-d">这个后台要管理员身份才能进。</div>
      <a class="ui-btn ui-btn--default ui-btn--sm" href="/">去登录</a></div>`;
  if (s === 403)
    return `<div class="ad-gate">${ic("shield")}<div class="ad-sec-t">${esc(e.message)}</div>
      <div class="ad-sec-d">管理后台只对管理员和审计员开放。要权限找你们组织的管理员。</div>
      <a class="ui-btn ui-btn--outline ui-btn--sm" href="/">返回工作台</a></div>`;
  return `<div class="ad-gate">${ic("triangle-alert")}<div class="ad-sec-t">没加载出来</div>
    <div class="ad-sec-d">${esc(e.message)}</div>
    <button class="ui-btn ui-btn--outline ui-btn--sm" onclick="location.reload()">重试</button></div>`;
}

async function boot() {
  try {
    const d = await api("/api/admin/overview");
    ME = d.me;
    PLATFORM = !!d.platform_admin;
    MULTI = !!d.multi_tenant;
    RO = ME && ME.role === "auditor";
    document.title = `${d.org.name} · 企业管理后台`;
  } catch (e) {
    $("ad-body").innerHTML = gate(e);
    $("ad-sub").textContent = "进不来";
    return;
  }
  addEventListener("hashchange", () => route(false));
  await route(false);
}
boot();
