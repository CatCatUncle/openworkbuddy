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
const ROLE_LABEL = { owner: "超级管理员", admin: "管理员", auditor: "审计员", member: "成员" };
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
      // 选人：人多的时候下拉框是不能用的（三千个 <option>，而且找一个人只能一路滚）。
      // 换成打字搜——敲字的时候才去要二十个候选，选中之后框里留的是登录名，
      // 后端拿它精确比对；打错了会被后端挡下并说清楚「不是这个组织的人」
      if (f.type === "user")
        ctl = `<input class="ui-input" id="${id}" list="${id}-l" value="${esc(f.value || "")}" placeholder="${esc(f.placeholder || "")}" autocomplete="off"><datalist id="${id}-l"></datalist>`;
      else if (f.type === "select")
        ctl = `<select class="ui-input ui-select" id="${id}">${(f.options || [])
          .map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(f.value) ? " selected" : ""}>${esc(o.label)}</option>`)
          .join("")}</select>`;
      else if (f.type === "checks") {
        // 一组勾选＋一个隐藏格。勾选的结果同步进隐藏格，
        // 下面读值那一句（querySelector("#mf-"+name).value）就一个字都不用改。
        const on = new Set((Array.isArray(f.value) ? f.value : String(f.value || "").split(",")).map((x) => String(x).trim()).filter(Boolean));
        ctl = `<div class="ad-checks" data-checks>${(f.options || [])
          .map((o) => `<label><input type="checkbox" value="${esc(o.value)}"${on.has(String(o.value)) ? " checked" : ""}>${esc(o.label)}</label>`)
          .join("")}<input type="hidden" id="${id}"></div>`;
      } else if (f.type === "textarea")
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
  // 选人格：一打开就先给几个候选（别让人对着一个空框猜有谁），之后打字再换
  mask.querySelectorAll("input[list]").forEach((box) => {
    const list = mask.querySelector("#" + box.getAttribute("list"));
    const fill = async () => { const { html } = await userOptions(box.value); if (list) list.innerHTML = html; };
    let t = 0;
    box.oninput = () => { clearTimeout(t); t = setTimeout(fill, 250); };
    fill();
  });
  // 勾选组 → 隐藏格。先同步一次，否则「没动过就点保存」会把原来勾着的全清掉
  mask.querySelectorAll("[data-checks]").forEach((box) => {
    const hid = box.querySelector('input[type="hidden"]');
    const sync = () => {
      hid.value = [...box.querySelectorAll('input[type="checkbox"]')].filter((c) => c.checked).map((c) => c.value).join(",");
    };
    box.addEventListener("change", sync);
    sync();
  });
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
/**
 * 一行放几张 KPI 卡。以前交给 CSS 的 auto-fit 自己算，结果是：容器宽度决定列数，
 * 六张就排成 5 + 1、八张排成 5 + 3——最后一行孤零零吊着一两张，看着像页面没加载完。
 * 这里反过来，按**张数**挑一个排得整齐的列数：能整除的优先，5 张以内就一行排开。
 * （窄屏另说，CSS 里有断点接手。）
 */
function statCols(n) {
  if (n <= 5) return n || 1;
  for (const c of [5, 4, 3]) if (n % c === 0) return c;
  return 4;
}
const kpi = (list) =>
  `<div class="ui-stats" style="--n:${statCols(list.length)}">${list
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
/* ---------------- 流水筛选（用量明细 / 操作审计 共用） ----------------
 * 这两张表以前都是「给你看最近 200 条，看不到的自己导出去用 Excel 查」。
 * 管钱和管合规的人来后台，问的第一句就是「上个月」「9 月 3 号」「小圆那几笔」——
 * 时间范围、搜索、翻页这三样缺一样，这个后台在他手里就等于没有。
 */
const DAY = 86400000;
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
/** 快捷区间。返回 [from, to]，都是闭区间的本地日期 */
function presetRange(key) {
  const now = new Date();
  const today = iso(now);
  if (key === "today") return [today, today];
  if (key === "7d") return [iso(new Date(now.getTime() - 6 * DAY)), today];
  if (key === "30d") return [iso(new Date(now.getTime() - 29 * DAY)), today];
  if (key === "month") return [today.slice(0, 8) + "01", today];
  if (key === "last-month") {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastEnd = new Date(first.getTime() - DAY);
    return [iso(new Date(lastEnd.getFullYear(), lastEnd.getMonth(), 1)), iso(lastEnd)];
  }
  return ["", ""]; // all
}
/** 当前筛选跟哪个快捷键对得上（对不上就是「自定义」），用来点亮那个按钮 */
function activePreset(f) {
  for (const k of ["today", "7d", "30d", "month", "last-month", "all"]) {
    const [a, b] = presetRange(k);
    if (a === (f.from || "") && b === (f.to || "")) return k;
  }
  return "custom";
}
const PRESETS = [["today", "今天"], ["7d", "近 7 天"], ["30d", "近 30 天"], ["month", "本月"], ["last-month", "上月"], ["all", "全部"]];
/**
 * 筛选条。extra 里放这张表专有的下拉（比如审计的「操作人」）。
 * 日期用原生 date 输入：后台是给内部人用的，自己写日历控件只会多一堆没人维护的代码。
 */
function filterBar(f, opts = {}) {
  const cur = activePreset(f);
  const chips = PRESETS.map(
    ([k, t]) => `<button class="ad-chip${cur === k ? " is-on" : ""}" data-preset="${k}">${t}</button>`
  ).join("");
  return `<div class="ad-filter">
    <div class="ad-chips">${chips}${cur === "custom" ? '<span class="ad-chip is-on">自定义</span>' : ""}</div>
    <div class="ad-filter-r">
      <input type="date" class="ui-input ad-date" data-from value="${esc(f.from || "")}" aria-label="起始日期">
      <span class="ad-dash">至</span>
      <input type="date" class="ui-input ad-date" data-to value="${esc(f.to || "")}" aria-label="结束日期">
      ${opts.extra || ""}
      <input class="ui-input ad-search" data-q value="${esc(f.q || "")}" placeholder="${esc(opts.placeholder || "搜索")}" aria-label="搜索">
      ${opts.right || ""}
    </div>
  </div>`;
}
/** 把筛选条上的交互接起来。onChange 收到的是改好的 f，调用方自己决定重新拉数据 */
function bindFilter(root, f, onChange) {
  root.querySelectorAll("[data-preset]").forEach((b) => {
    b.onclick = () => { const [a, z] = presetRange(b.dataset.preset); onChange({ ...f, from: a, to: z, offset: 0 }); };
  });
  const from = root.querySelector("[data-from]"), to = root.querySelector("[data-to]");
  if (from) from.onchange = () => onChange({ ...f, from: from.value, offset: 0 });
  if (to) to.onchange = () => onChange({ ...f, to: to.value, offset: 0 });
  const q = root.querySelector("[data-q]");
  if (q) {
    // 防抖 300ms：不防的话打一个字发一次请求，一个词打完就是六七次
    let t = 0;
    q.oninput = () => { clearTimeout(t); t = setTimeout(() => onChange({ ...f, q: q.value, offset: 0 }), 300); };
    q.onkeydown = (e) => { if (e.key === "Enter") { clearTimeout(t); onChange({ ...f, q: q.value, offset: 0 }); } };
  }
}
/**
 * 翻页条。写「第 X-Y 条，共 N 条」而不是「第 3 页」——
 * 对账的人心里记的是条数，不是页码。
 */
function pager(f, total, limit, unit = "条") {
  if (!total) return "";
  const from = f.offset + 1, to = Math.min(total, f.offset + limit);
  const more = f.offset + limit < total;
  if (!more && f.offset === 0) return `<div class="ad-pager"><span class="ad-pager-n">共 ${num(total)} ${unit}</span></div>`;
  return `<div class="ad-pager">
    <span class="ad-pager-n">第 ${num(from)}-${num(to)} ${unit}，共 ${num(total)} ${unit}</span>
    <span class="ad-row">
      <button class="ui-btn ui-btn--outline ui-btn--sm" data-prev${f.offset ? "" : " disabled"}>上一页</button>
      <button class="ui-btn ui-btn--outline ui-btn--sm" data-next${more ? "" : " disabled"}>下一页</button>
    </span>
  </div>`;
}
function bindPager(root, f, limit, onChange) {
  const p = root.querySelector("[data-prev]"), n = root.querySelector("[data-next]");
  if (p) p.onclick = () => onChange({ ...f, offset: Math.max(0, f.offset - limit) });
  if (n) n.onclick = () => onChange({ ...f, offset: f.offset + limit });
}
/**
 * 「看谁的」这类选人框：打字才去问候选，不预先把花名册搬下来。
 *
 * 下拉框在人多的时候是不能用的——三千个 <option> 光这份清单就 491 KB，而且要在里面
 * 找一个人只能一路滚。这里换成输入框 + <datalist>：敲字的时候才去要二十个候选，
 * 原生下拉负责摆出来，键盘上下选也是浏览器自己的事。
 *
 * 框里留的是**登录名**（datalist 选中之后回填进输入框的就是 option 的 value），
 * 所以拿去筛是精确的，不会因为两个人昵称一样而筛错人。
 */
async function userOptions(kw) {
  try {
    const r = await api("/api/admin/members?" + qs({ q: String(kw || "").trim(), fields: "lite", limit: 20 }));
    const list = r.members || [];
    return { list, html: list
      .map((m) => `<option value="${esc(m.username)}">${esc(m.nickname || m.username)}${m.dept ? " · " + esc(m.dept) : ""}</option>`)
      .join("") };
  } catch {
    // 候选拉不到就是没有下拉，框本身照样能用——别让一趟失败的补全把整张表卡住
    return { list: [], html: "" };
  }
}
function userPick(attr, value, placeholder = "全部成员") {
  const id = "ad-pick-" + attr;
  return `<input class="ui-input ad-search" list="${id}" data-${attr} value="${esc(value || "")}"
    placeholder="${esc(placeholder)}" autocomplete="off" aria-label="${esc(placeholder)}"><datalist id="${id}"></datalist>`;
}
/**
 * 把上面那个框接起来。onPick 收到的是登录名，清空了就是空串。
 *
 * 判「选好了没」看的是「这串是不是真有这么个人」，不是「按没按回车」——从原生下拉里
 * 点一下是不按回车的。反过来，打了一半还没匹配上的时候不动表格：那会儿筛出来多半是空的，
 * 而空表跟「这个人没有流水」长得一模一样。
 */
function bindUserPick(root, attr, current, onPick) {
  const box = root.querySelector("[data-" + attr + "]");
  if (!box) return;
  const list = root.querySelector("#ad-pick-" + attr);
  let t = 0, last = String(current || "");
  const run = async () => {
    const kw = box.value.trim();
    const { list: found, html } = await userOptions(kw);
    if (list) list.innerHTML = html;
    if (kw === last) return;
    if (!kw) { last = ""; onPick(""); return; }
    const who = found.find((m) => m.username === kw);
    if (!who) return;
    last = who.username;
    onPick(who.username);
  };
  box.oninput = () => { clearTimeout(t); t = setTimeout(run, 250); };
  box.onchange = () => { clearTimeout(t); run(); };
}
/** 存成 CSV 下载。BOM 不能省，不然 Excel 打开中文表头是乱码 */
function downloadCsv(name, head, rows) {
  const q = (x) => `"${String(x == null ? "" : x).replace(/"/g, '""')}"`;
  const lines = [head.map(q).join(",")].concat(rows.map((r) => r.map(q).join(",")));
  const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}_${iso(new Date())}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast("已导出 " + rows.length + " 条");
}
/** 把筛选拼成 query string。空值不拼，URL 干净点，后端也少判几个空串 */
const qs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");

/**
 * 7 日柱状。取的是 tokens，因为运行次数看不出「一次跑了多大」。
 *
 * 两件事以前是错的，都得在这儿改：
 *   1. 数只写在 title 里，非得把鼠标停上去才看得见。截图发群里、打印、用键盘的人
 *      看到的就是七根没有刻度的柱子——等于一张插图。所以数直接写在柱子头上。
 *   2. 没有用量的那天也被 `Math.max(2, h)` 顶出一根小柱子，看着跟「跑了一点点」
 *      一模一样。空就该是空的：不画柱子，只留一条地平线和一个「—」。
 */
function bars7(last7) {
  const max = Math.max(1, ...last7.map((d) => d.tokens));
  return `<div class="ad-bars">${last7
    .map((d) => {
      const h = Math.round((d.tokens / max) * 100);
      return `<div class="b${d.tokens ? "" : " z"}" title="${esc(d.day)}：${num(d.runs)} 次 · ${num(d.tokens)} tokens">
        <b>${d.tokens ? big(d.tokens) : ""}</b>
        <span class="t">${d.tokens ? `<i style="height:${Math.max(3, h)}%"></i>` : "<em>—</em>"}</span>
        <u>${esc(d.day.slice(5))}</u></div>`;
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
let OWNER = false;      // 是不是平台超级管理员（默认组织的超管 = 这台机器的主人）
let RO = false;         // 审计员：只读
let MULTI = false;      // 有没有开第二个组织

/* ---------------- 页面表 ---------------- */
/**
 * 侧边栏的分组照着「先看钱、再看人、最后看设置」排：
 * 一个管理员打开后台，八成是来看这个月花了多少、谁在花的，不是来改配置的。
 */
const NAV = [
  { grp: "", items: [
    { id: "home", icon: "app-window", title: "总览", sub: "今天这个组织怎么样，有什么等着你处理" },
    { id: "security", icon: "shield", title: "客户端安全", sub: "管住这个组织的成员在客户端能做什么" },
  ] },
  {
    grp: "订阅与用量",
    items: [
      { id: "sub", icon: "wallet", title: "订阅管理", sub: "套餐、席位、到期时间和这个月的固定用量" },
      { id: "usage-member", icon: "users", title: "成员用量", sub: "每个人的额度、余额和累计消耗" },
      { id: "usage-org", icon: "building", title: "组织用量", sub: "整个组织今天/本月花了多少" },
      { id: "usage-app", icon: "blocks", title: "应用用量", sub: "按模型、按入口拆开看" },
      { id: "usage-detail", icon: "file-text", title: "用量明细", sub: "一条一条的流水，可导出" },
      { id: "relay", icon: "link", title: "API 中转站", sub: "对外发 Key、按型号计价、按人按月限额" },
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
      { id: "models", icon: "sparkles", title: "模型与 Key", sub: "这台服务器用哪些模型、哪把 Key", platform: true },
      { id: "apiquota", icon: "sliders-horizontal", title: "API 与额度", sub: "搜索、生图、生视频这些按次收费的接口，统一配、统一限", platform: true },
      { id: "orgs", icon: "building", title: "组织管理", sub: "新建组织、给别的组织配套餐", platform: true, owner: true },
      { id: "audit", icon: "clock", title: "操作审计", sub: "谁在什么时候改了什么" },
    ],
  },
  { grp: "开放与集成", items: [{ id: "integration", icon: "plug", title: "开放与集成", sub: "机器人渠道、MCP 和接口" }] },
];
const PAGES = {};

/* ============ 客户端安全 ============ */
/* ============ 总览 ============ */
/**
 * 后台以前的落地页是「订阅管理」——一个管理员打开后台，第一眼看到的是套餐和席位。
 * 可他八成不是来看套餐的，是来看「今天团队怎么样」「有没有事等着我点头」。
 *
 * 所以这页分两半：上半是数，下半是**待办**。待办才是这页存在的理由——
 * 一个不会告诉你「有 3 个人等着审核」的后台，等于要人每天挨个页面翻一遍。
 */
PAGES.home = {
  load: async () => {
    // 「额度见底几个人」以前是把整份花名册拉过来前端自己数的——3000 人的组织，
    // 为了首页上一行待办搬 1041 KB。现在概览那趟顺手把这个数一起带回来了
    const [o, st] = await Promise.all([api("/api/admin/overview"), api("/api/admin/stats")]);
    return { o, st };
  },
  render: ({ o, st }) => {
    const t = st.totals;
    const seatPct = o.seats.total ? (o.seats.used / o.seats.total) * 100 : 0;

    // ---- 待办：只列真的需要人动手的，凑数的条目会让人很快学会无视这一整块 ----
    const todo = [];
    if (o.seats.pending)
      todo.push({ kind: "warn", icon: "circle-check", text: `<b>${o.seats.pending} 个人</b>自助注册后等着审核，没通过之前他们进不来。`, to: "pending", act: "去审核" });
    if (o.seats.total && o.seats.used >= o.seats.total)
      todo.push({ kind: "warn", icon: "users", text: `席位满了（${o.seats.used} / ${o.seats.total}），再加人会被挡下。`, to: "sub", act: "看套餐" });
    else if (seatPct >= 80)
      todo.push({ kind: "info", icon: "users", text: `席位用到 ${Math.round(seatPct)}%，还剩 ${o.seats.total - o.seats.used} 个。`, to: "sub", act: "看套餐" });
    // 额度见底的人：闸门开着才有意义，关着的时候额度只是记账，拦不住人
    if (o.settings && o.settings.meter_on && o.monthly.dry)
      todo.push({ kind: "warn", icon: "zap", text: `<b>${o.monthly.dry} 个人</b>本月固定额度已用完（${(o.monthly.dry_names || []).map(esc).join("、")}${o.monthly.dry > (o.monthly.dry_names || []).length ? " 等" : ""}），他们现在发不出请求。`, to: "usage-member?dry=1", act: "去充值" });
    if (!t.runs_month)
      todo.push({ kind: "info", icon: "info", text: "这个月还没有人跑过任务。新部署的话，先去「模型与 Key」确认渠道填好了。", to: PLATFORM ? "models" : "usage-org", act: "去看看" });
    const todoHtml = todo.length
      ? `<ul class="ad-todo">${todo
          .map(
            (x) => `<li class="ad-todo-i ad-todo-i--${x.kind}">${ic(x.icon)}<span>${x.text}</span>
              <a class="ui-btn ui-btn--outline ui-btn--sm" href="#/${x.to}">${esc(x.act)}</a></li>`
          )
          .join("")}</ul>`
      : `<div class="ad-todo-ok">${ic("circle-check")}<div><b>没有要处理的事。</b><span class="fd">席位够用，没人卡在审核里，额度也没见底。</span></div></div>`;

    const topUser = st.by_user.slice(0, 5).map((x) => [esc(x.key), num(x.runs), big(x.tokens)]);
    const topModel = st.by_model.slice(0, 5).map((x) => [`<span class="ad-mono">${esc(x.key)}</span>`, num(x.runs), big(x.tokens)]);

    return `<div class="ad-wrap ad-wrap--wide">
      ${cardT(
        headRow(
          secT(o.org.name, `${esc(o.plan.label)} · ${o.seats.used}/${o.seats.total} 席${o.plan.expired ? " · <b>已过期</b>" : o.plan.days_left != null && o.plan.days_left <= 30 ? ` · ${o.plan.days_left} 天后到期` : ""} · 建于 ${esc(fmtDate(o.org.created_at))}`),
          `<a class="ui-btn ui-btn--outline ui-btn--sm" href="#/usage-detail">${ic("file-text")} 查流水</a>`
        ),
        // 只留四张卡，不是为了少显示，是为了排得开：一行六张在 1400px 以下会折成 5 + 1，
        // 剩下那张孤零零吊在第二行，看着像页面坏了。平均耗时和缓存命中本来也不是独立的指标，
        // 它们是在形容旁边那个数——「本月跑了 240 次」和「平均 3 秒一次」写在一起才有意义，
        // 拆成两张并排的卡反而要人自己在心里连线。
        `<div class="ad-card-b">${kpi([
          { label: "今日运行", value: num(o.today.runs), hint: `今天有 ${num(t.active_today)} 个人在用` },
          { label: "今日 tokens", value: big(o.today.tokens) },
          { label: "本月运行", value: num(t.runs_month), hint: t.avg_ms ? `平均 ${Math.round(t.avg_ms / 1000)} 秒跑完一次` : "" },
          { label: "本月 tokens", value: big(t.tokens_month), hint: t.cache_hit == null ? "" : `缓存命中 ${t.cache_hit}%，越高越省钱` },
        ])}</div>`
      )}

      ${cardT(
        secT("要你处理的", todo.length ? `有 ${todo.length} 件事等着你点头，处理完这块就空了。` : "这块是空的才算正常。"),
        `<div class="ad-card-b">${todoHtml}</div>`
      )}

      ${cardT(secT("最近 7 天", "柱子高低看的是 tokens——只数次数看不出「一次跑了多大」。"), `<div class="ad-card-b">${bars7(st.last7)}</div>`)}

      <div class="ad-two">
        ${cardT(
          headRow(secT("谁在用", "本月按 tokens 排"), `<a class="ui-btn ui-btn--ghost ui-btn--sm" href="#/usage-member">全部</a>`),
          table([{ t: "成员" }, { t: "运行", right: true }, { t: "tokens", right: true }], topUser)
        )}
        ${cardT(
          headRow(secT("用了哪些模型", "本月按 tokens 排"), `<a class="ui-btn ui-btn--ghost ui-btn--sm" href="#/usage-app">全部</a>`),
          table([{ t: "模型" }, { t: "运行", right: true }, { t: "tokens", right: true }], topModel)
        )}
      </div>
    </div>`;
  },
};

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
      ${card(`${secT("密码与二次验证", "改完<b>只对之后设的新密码生效</b>——已经在用的旧密码不会被追着作废，也不会有人突然登不进来。")}
        <div style="margin-top:14px">
          ${field("密码最短位数", "6 - 64。注册、成员自己改密码、你在这儿点「重置密码」，三个地方一起管。系统发给成员的那串随机密码也会跟着变长。", inp("password_min", s.password_min == null ? 6 : s.password_min, 'type="number" min="6" max="64" style="width:120px"'))}
          ${field("要求密码有复杂度", "开了之后，密码里要凑够「大写字母、小写字母、数字、符号」四类里的至少三类。不开也一样会挡掉 123456、woaini1314 这种常见弱密码。", sw("password_strong", !!s.password_strong))}
          ${field("强制二次验证", "开了之后，没绑验证器的成员登进来只能停在绑定页，别的什么都做不了。你自己也一样——<b>先把自己绑上再开这个开关</b>，不然你会被自己锁在门外（真锁上了也有救：在服务器上跑 <code>openworkbuddy 2fa --off 用户名</code>）。", sw("require_2fa", !!s.require_2fa))}
        </div>`)}
      ${card(`${secT("远程访问与远程操控", "这两条<b>默认都是关的</b>。装好之后没人动过它，这台机器就只能在它自己面前用——要在手机上用，得先在这儿主动打开。")}
        <div style="margin-top:14px">
          ${field("允许远程设备接入", "开了之后，才能在「设置 → 设备」里生成二维码，把手机或另一台电脑扫码连上来共用这份数据（密码不会离开这台机器）。<b>关掉的同时，已经扫码连上的设备下一次请求就会被踢下线</b>，不用一台台去撤。", sw("remote_devices", !!s.remote_devices))}
          ${field("允许远程操控终端任务", "开了之后，网页和手机上才看得到这台机器终端里 <code>openworkbuddy</code> 正在跑的活儿，才能给它插话、替它批准危险操作。关掉之后终端照跑不误，只是外面看不见也插不上手。", sw("remote_control", !!s.remote_control))}
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
/**
 * 这一页是按人头长的：一行一个人。所以筛、排、切全在服务端做，跟成员页一个规矩。
 * 以前是一趟把整份花名册（连额度带余额）拉回来前端自己画——3000 人的组织一次回包
 * 678 KB、服务端为它翻了 5.0 MB 的盘，而屏幕上看得见的是十几行。
 *
 * 默认按「累计 tokens」从多到少。这一页回答的是「钱花在谁身上了」；按花名册顺序排的话，
 * 花得最多的那几个散在六十页中间，等于没答。
 */
const USAGE_PAGE = 50;
let usageMQ = { q: "", dry: false, offset: 0 };
let usageMQRaw = null; // 上次从地址栏里读进来的那串
/**
 * 首页那条待办点「去充值」过来是 #/usage-member?dry=1，得直接落在见底的那几个人身上。
 *
 * 只在地址栏**变了**的时候读：页内搜索和翻页走的是 route(true)，地址栏原样不动，
 * 每次都读一遍的话，人刚敲进搜索框的字会被地址栏里那份旧的冲掉。
 */
function syncUsageMQ() {
  const raw = location.hash.split("?")[1] || "";
  if (raw === usageMQRaw) return;
  usageMQRaw = raw;
  const p = new URLSearchParams(raw);
  usageMQ = { q: p.get("q") || "", dry: p.get("dry") === "1", offset: 0 };
}
PAGES["usage-member"] = {
  load: async () => {
    syncUsageMQ();
    // dry 是个开关，关着的时候别往 URL 上拼 dry=false——qs 只滤空串和 null，false 会原样拼出去
    const d = await api("/api/admin/usage/members?" + qs({
      q: usageMQ.q, dry: usageMQ.dry ? 1 : "", offset: usageMQ.offset, limit: USAGE_PAGE,
    }));
    // 翻到第 5 页的时候别人删掉了几个人，服务端会把这一趟退回最后一页。
    // 把它退回来的那个位置记下来，不然翻页条上写的还是第 5 页
    usageMQ.offset = d.offset;
    return d;
  },
  render: (d) => {
    const filtered = d.matched !== d.total;
    const rows = d.rows.map((m) => [
      `<div style="font-weight:500">${esc(m.nickname || m.username)}</div><div class="fd ad-mono">${esc(m.username)}</div>`,
      esc(m.dept || "—"),
      badge(ROLE_LABEL[m.role] || m.role, m.role === "member" ? "outline" : "secondary"),
      num(m.monthly_quota),
      // 见底的那几个人得一眼看出来——这一页多半就是为他们打开的
      num(m.monthly_left) + (m.dry ? " " + badge("见底", "destructive") : ""),
      num(m.credits),
      `<b>${num(m.balance)}</b>`,
      num(m.runs),
      big(m.tokens),
      RO ? "" : `<button class="ui-btn ui-btn--outline ui-btn--xs" data-topup="${esc(m.username)}">充加油包</button>`,
    ]);
    const cols = [
      { t: "成员" }, { t: "部门" }, { t: "角色" },
      { t: "月额度", right: true }, { t: "本月剩余", right: true }, { t: "加油包", right: true }, { t: "可用合计", right: true },
      { t: "累计运行", right: true }, { t: "累计 tokens", right: true }, { t: "" },
    ];
    // 人多的时候才出筛选条：三个人的团队顶一条筛选栏在头上，纯属添乱。
    // 「只看额度见底」那颗钮上的数是**全组织**的总数，不跟着筛选变——跟着变的话，
    // 一按下去它就只数筛出来的那些，钮上永远写着自己筛出来的结果
    const bar = d.total < 8 ? "" : `<div class="ad-filter">
      <div class="ad-chips">
        <span class="ad-sub">${filtered ? `筛出 ${num(d.matched)} / ${num(d.total)} 人` : `共 ${num(d.total)} 人`}</span>
        ${d.dry || usageMQ.dry ? `<button class="ad-chip${usageMQ.dry ? " is-on" : ""}" data-dry>只看额度见底（${num(d.dry)}）</button>` : ""}
      </div>
      <div class="ad-filter-r">
        <input class="ui-input ad-search" data-uq value="${esc(usageMQ.q)}" placeholder="搜姓名 / 账号 / 部门">
      </div>
    </div>`;
    return `<div class="ad-wrap">
      ${note("「月额度 / 本月剩余 / 加油包」是当下的余额；右边两列<b>累计</b>是这个人从有记录以来的总消耗，不是本月。想看本月请去「组织用量」。")}
      ${cardT(
        secT("成员用量", "按累计 tokens 从多到少排。扣费顺序：先扣本月固定额度，再扣加油包。"),
        bar + (rows.length
          ? table(cols, rows) + pager(usageMQ, d.matched, USAGE_PAGE, "人")
          : empty(usageMQ.dry ? "没有人的本月固定额度见底" : filtered ? "没有符合条件的成员" : "还没有成员"))
      )}
    </div>`;
  },
  bind: (root) => {
    // 改了筛选条件就回到第一页：留在第 7 页搜一个字，多半是一张空表，
    // 而人只会以为「没这个人」
    const go = (f) => { usageMQ = f; route(true); };
    const q = root.querySelector("[data-uq]");
    if (q) {
      // 防抖 250ms：搜的是**整个组织**，每个字发一趟请求，一个词打完就是六七趟
      let t = 0;
      q.oninput = () => { clearTimeout(t); t = setTimeout(() => go({ ...usageMQ, q: q.value, offset: 0 }), 250); };
      q.onkeydown = (e) => { if (e.key === "Enter") { clearTimeout(t); go({ ...usageMQ, q: q.value, offset: 0 }); } };
    }
    const dry = root.querySelector("[data-dry]");
    if (dry) dry.onclick = () => go({ ...usageMQ, dry: !usageMQ.dry, offset: 0 });
    bindPager(root, usageMQ, USAGE_PAGE, go);
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
/**
 * 用量明细 = 这个组织的账本。四件事缺一不可：按时间查、按关键词搜、往下翻、导出。
 * 以前只有「最近 25 条 + 导出」，等于让财务拿 Excel 当查询工具。
 */
let detailUser = "";
let detailF = { from: "", to: "", q: "", offset: 0 };
const DETAIL_PAGE = 50;
PAGES["usage-detail"] = {
  // 这一页只要流水，不要花名册。「看谁的」那个框是打字才去问候选的（见 userPick），
  // 以前是把整份名单捎带回来画成下拉——于是 ?limit= 根本缩不小回包：3000 人时 limit=50 是 491 KB，
  // 其中 430 KB 是那三千个 <option>
  load: () =>
    api("/api/admin/usage?" + qs({ limit: DETAIL_PAGE, offset: detailF.offset, user: detailUser, from: detailF.from, to: detailF.to, q: detailF.q })),
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
    const r = d.range || {};
    const filtered = !!(detailF.from || detailF.to || detailF.q || detailUser);
    return `<div class="ad-wrap ad-wrap--wide">
      ${cardT(
        headRow(
          secT("用量明细", filtered ? "下面这些数只统计<b>当前筛选</b>命中的流水。" : "这个组织的全部流水。选个时间范围或者搜一下，下面的合计跟着变。"),
          `<button class="ui-btn ui-btn--outline ui-btn--sm" data-csv>${ic("download")} 导出本页</button>`
        ),
        `${filterBar(detailF, {
          placeholder: "搜成员 / 模型 / 入口",
          extra: userPick("user", detailUser, "全部成员"),
        })}
        ${kpi([
          { label: "命中条数", value: num(d.total || 0) },
          { label: "运行次数", value: num(r.runs || 0) },
          { label: "tokens", value: big(r.tokens || 0) },
          { label: "积分", value: num(r.credits || 0) },
          { label: "平均耗时", value: r.runs ? Math.round(r.elapsed_ms / r.runs / 1000) + " 秒" : "—" },
        ])}
        ${table(
          [{ t: "时间" }, { t: "成员" }, { t: "类型" }, { t: "模型" }, { t: "入口" }, { t: "tokens", right: true }, { t: "命中缓存", right: true }, { t: "积分", right: true }, { t: "耗时", right: true }],
          rows
        )}
        ${pager(detailF, d.total || 0, DETAIL_PAGE)}`
      )}
    </div>`;
  },
  bind: (root, d) => {
    const go = (f) => { detailF = f; route(true); };
    bindFilter(root, detailF, go);
    bindPager(root, detailF, DETAIL_PAGE, go);
    bindUserPick(root, "user", detailUser, (name) => { detailUser = name; detailF = { ...detailF, offset: 0 }; route(true); });
    root.querySelector("[data-csv]").onclick = () =>
      downloadCsv(
        "用量明细",
        ["时间", "成员", "类型", "模型", "入口", "prompt", "completion", "命中缓存", "积分", "耗时毫秒"],
        d.detail.map((e) => [e.ts, e.user, e.kind, e.model || "", e.source || "", e.prompt || 0, e.completion || 0, e.cached || 0, e.credits || 0, e.elapsed_ms || 0])
      );
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
/**
 * 成员的筛选和翻页都在**服务端**做。以前是整份拉回来前端自己筛——二十个人的团队没问题，
 * 三千人的时候是一次 1041 KB 的回包、浏览器里 78098 个 DOM 节点、点进来到表格出来 878ms，
 * 而一屏看得见十几行。想找一个人，前提是先把三千人搬到浏览器里。
 */
const MEMBER_PAGE = 50;
let memberQ = { q: "", role: "", status: "", offset: 0 };
PAGES.members = {
  load: async () => {
    const [m, i] = await Promise.all([
      api("/api/admin/members?" + qs({ ...memberQ, limit: MEMBER_PAGE })),
      api("/api/admin/invites"),
    ]);
    // 翻到第 5 页的时候别人删掉了几个人，服务端会把这一趟退回最后一页。
    // 把它退回来的那个位置记下来，不然翻页条上写的还是第 5 页
    memberQ.offset = m.offset;
    return { m, i };
  },
  render: ({ m, i }) => {
    const shown = m.members;                    // 筛完切完的这一页，服务端给的
    const filtered = m.matched !== m.total;
    const rows = shown.map((u) => [
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
            ${u.owner || u.status === "disabled" ? "" : `<button class="ui-btn ui-btn--ghost ui-btn--xs" data-off="${esc(u.username)}" title="一次关掉他手上所有还能用的口子">${ic("log-out", "i-sm")} 办离职</button>`}
            ${u.owner ? "" : `<button class="ui-btn ui-btn--ghost ui-btn--xs" data-del="${esc(u.username)}">${ic("trash", "i-sm")}</button>`}
          </div>`,
    ]);
    // 部门以前只画成一排标签。加了权限模板之后标签就不够用了——「销售部进来的人默认是成员、
    // 每月 2000 额度」这句话得摆在明处，不然模板改了没人看得见，下一个新人按着一份谁都不记得的
    // 配置进的门。所以改成表：一行一个部门，模板长什么样直接写在旁边
    const T = m.templates || {};
    const deptRows = m.depts.map((d) => {
      const t = T[d.name];
      return [
        `<span style="font-weight:500">${esc(d.name)}</span>`,
        t ? badge(ROLE_LABEL[t.role] || t.role, t.role === "member" ? "outline" : "secondary") : `<span class="fd">成员</span>`,
        t && t.monthly_quota !== null && t.monthly_quota !== undefined ? num(t.monthly_quota) : `<span class="fd">跟随团队</span>`,
        RO
          ? ""
          : `<div class="ad-actions">
              <button class="ui-btn ui-btn--ghost ui-btn--xs" data-tpl="${esc(d.name)}" title="这个部门进来的新人，默认按什么权限开号">${ic("sliders-horizontal", "i-sm")} 权限模板</button>
              ${t ? `<button class="ui-btn ui-btn--ghost ui-btn--xs" data-tplx="${esc(d.name)}" title="清掉模板，以后这个部门进来的人按默认（成员 · 跟随团队额度）">${ic("x", "i-sm")} 清空模板</button>` : ""}
              <button class="ui-btn ui-btn--ghost ui-btn--xs" data-deldept="${esc(d.id)}" title="删除部门">${ic("trash", "i-sm")}</button>
            </div>`,
      ];
    });
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
            <button class="ui-btn ui-btn--ghost ui-btn--xs" data-copy="${esc(v.code)}" title="${esc(inviteLink(v.code))}">${ic("link", "i-sm")} 复制链接</button>
            <button class="ui-btn ui-btn--ghost ui-btn--xs" data-copycode="${esc(v.code)}" title="只复制这串码本身">${ic("copy", "i-sm")}</button>
            <button class="ui-btn ui-btn--ghost ui-btn--xs" data-revoke="${esc(v.code)}">${ic("trash", "i-sm")}</button>
          </div>`,
    ]);
    const pick = (k, cur, list, all) =>
      `<select class="ui-input ui-select ad-pick" data-m${k}>` +
      [`<option value="">${all}</option>`]
        .concat(list.map(([v, t]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(t)}</option>`))
        .join("") + `</select>`;
    // 人多的时候才出筛选条：三个人的团队顶一条筛选栏在头上，纯属添乱
    const bar = m.total < 8 ? "" : `<div class="ad-filter">
      <div class="ad-chips"><span class="ad-sub">${filtered ? `筛出 ${num(m.matched)} / ${num(m.total)} 人` : `共 ${num(m.total)} 人`}</span></div>
      <div class="ad-filter-r">
        ${pick("role", memberQ.role, Object.entries(ROLE_LABEL), "全部角色")}
        ${pick("status", memberQ.status, [["active", "正常"], ["pending", "待审核"], ["disabled", "已停用"]], "全部状态")}
        <input class="ui-input ad-search" data-mq value="${esc(memberQ.q)}" placeholder="搜姓名 / 账号 / 部门">
      </div>
    </div>`;
    return `<div class="ad-wrap ad-wrap--wide">
      ${cardT(
        headRow(
          secT("成员", `共 ${num(m.total)} 人。停用的成员不占席位，账号和他产出的文件都还在。`),
          RO ? "" : `<button class="ui-btn ui-btn--default ui-btn--sm" data-add>${ic("plus")} 添加成员</button>`
        ),
        bar + (shown.length
          ? table([{ t: "成员" }, { t: "角色" }, { t: "部门" }, { t: "状态" }, { t: "可用余额", right: true }, { t: "最近活跃" }, { t: "" }], rows)
            + pager(memberQ, m.matched, MEMBER_PAGE, "人")
          : empty(filtered ? "没有符合条件的成员" : "还没有成员"))
      )}

      ${cardT(
        headRow(
          secT("部门", "用量能按部门拆开看。另外每个部门可以存一份<b>权限模板</b>——添加成员时角色/额度留空，就按这个部门的模板开号，同一个部门第三个人和第一个人的权限长得一模一样。"),
          RO ? "" : `<button class="ui-btn ui-btn--outline ui-btn--sm" data-adddept>${ic("plus")} 新建部门</button>`
        ),
        m.depts.length
          ? table([{ t: "部门" }, { t: "新人默认角色" }, { t: "新人默认月额度" }, { t: "" }], deptRows)
          : empty("还没有部门。分了部门之后，用量能按部门拆开看，也能给每个部门存一份新人权限模板。")
      )}

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
    // 改了筛选条件就回到第一页：留在第 7 页搜一个字，多半是一张空表，
    // 而人只会以为「没这个人」
    const go = (f) => { memberQ = f; route(true); };
    const mq = root.querySelector("[data-mq]");
    if (mq) {
      // 防抖 250ms：搜的是**整个组织**，每个字发一趟请求，一个词打完就是六七趟
      let t = 0;
      mq.oninput = () => { clearTimeout(t); t = setTimeout(() => go({ ...memberQ, q: mq.value, offset: 0 }), 250); };
      mq.onkeydown = (e) => { if (e.key === "Enter") { clearTimeout(t); go({ ...memberQ, q: mq.value, offset: 0 }); } };
    }
    for (const k of ["role", "status"]) {
      const el = root.querySelector("[data-m" + k + "]");
      if (el) el.onchange = () => go({ ...memberQ, [k]: el.value, offset: 0 });
    }
    bindPager(root, memberQ, MEMBER_PAGE, go);
    const deptOpts = [{ value: "", label: "（不分部门）" }].concat(m.depts.map((d) => ({ value: d.name, label: d.name })));
    // 下拉里只放这个人**真发得出去**的角色：管理员发不出管理员，那一档得超管来。
    // 服务端给清单，前端不自己编——编一份迟早跟 rbac.js 那张表走散
    const ROLE_OPT = {
      member: "成员 —— 只能用，看不到后台",
      auditor: "审计员 —— 能查账，改不动",
      admin: "管理员 —— 能管成员、改设置；但改不了另一个管理员",
    };
    const roleOpts = (m.can_assign || ["member"]).filter((r) => ROLE_OPT[r]).map((r) => ({ value: r, label: ROLE_OPT[r] }));
    // 改人的时候，他现在那一档得先摆在下拉里，哪怕你发不出这一档——不然下拉默认落在
    // 第一项上，看着像「他是成员」，一点保存就把人降了。改不动的那些后端会拦，界面别先说谎
    const roleOptsFor = (cur) =>
      roleOpts.some((o) => o.value === cur) ? roleOpts : [{ value: cur, label: (ROLE_LABEL[cur] || cur) + "（当前，你改不了这一档）" }].concat(roleOpts);
    // 走 /api/admin/onboard 而不是 /api/admin/members：两条路都建号，区别在前者会套部门模板。
    // 角色和额度默认留空（= 跟模板走），填了就以填的为准——模板是默认值，不是强制
    const T = m.templates || {};
    const add = root.querySelector("[data-add]");
    if (add)
      add.onclick = () =>
        modal({
          title: "添加成员",
          fields: [
            { name: "username", label: "登录名", placeholder: "字母数字，建议用工号或邮箱前缀", desc: "登录名<b>之后不能改</b>——改了就等于换了个账号。" },
            { name: "dept", label: "部门", type: "select", options: deptOpts, value: "" },
            {
              name: "role", label: "角色", type: "select", value: "",
              options: [{ value: "", label: "跟部门模板（没存模板就按「成员」）" }].concat(roleOpts),
              desc: Object.keys(T).length ? "已存模板的部门：" + Object.keys(T).map((d) => esc(d) + "→" + esc(ROLE_LABEL[T[d].role] || T[d].role)).join("、") : "",
            },
            { name: "monthly_quota", label: "每月固定额度", type: "number", placeholder: "留空 = 跟部门模板 / 团队设置", desc: "只想给某个人开小灶时才填。" },
          ],
          ok: "创建",
          onOk: async (v) => {
            const r = await post("/api/admin/onboard", v);
            const a = r.applied || {};
            showPassword(
              r.user.username,
              r.password,
              "账号建好了" + (a.from_template ? `（套用了「${a.dept}」的权限模板：${ROLE_LABEL[a.role] || a.role}、每月额度 ${a.monthly_quota}）` : "")
            );
            route(true);
          },
        });

    // 部门权限模板。改的是「以后」——已经建好的账号一个都不动，
    // 不然改一次模板，全部门的人权限跟着跳，谁也说不清昨天谁能干什么
    root.querySelectorAll("[data-tpl]").forEach((b) => {
      const d = b.dataset.tpl;
      const cur = T[d] || null;
      b.onclick = () =>
        modal({
          title: "「" + d + "」的新人权限模板",
          fields: [
            { name: "role", label: "默认角色", type: "select", options: roleOpts, value: (cur && cur.role) || "member" },
            {
              name: "monthly_quota", label: "默认每月额度", type: "number",
              value: cur && cur.monthly_quota !== null && cur.monthly_quota !== undefined ? cur.monthly_quota : "",
              desc: "留空 = 跟随团队设置。",
            },
          ],
          body: `<div class="fd" style="margin-bottom:12px">只影响<b>之后</b>从这个部门进来的新人，已经建好的账号一个都不动。添加成员时角色/额度填了具体值的，以填的为准。</div>`,
          ok: cur ? "保存" : "存下模板",
          onOk: async (v) => {
            await post("/api/admin/dept-templates", {
              dept: d,
              template: { role: v.role, monthly_quota: v.monthly_quota === "" ? null : +v.monthly_quota },
            });
            toast("模板已保存");
            route();
          },
        });
    });
    root.querySelectorAll("[data-tplx]").forEach((b) => {
      const d = b.dataset.tplx;
      b.onclick = () =>
        confirmBox(
          "清空「" + d + "」的权限模板",
          "以后从这个部门进来的新人按默认开号（成员 · 跟随团队额度）。<b>已经建好的账号不受影响。</b>",
          "清空",
          async () => { await post("/api/admin/dept-templates", { dept: d, remove: true }); toast("模板已清空"); route(); }
        );
    });

    root.querySelectorAll("[data-edit]").forEach((b) => {
      const u = m.members.find((x) => x.username === b.dataset.edit);
      b.onclick = () =>
        modal({
          title: "修改「" + (u.nickname || u.username) + "」",
          fields: [
            { name: "role", label: "角色", type: "select", options: roleOptsFor(u.role), value: u.role },
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

    // 办离职。为什么不是「改 → 状态 → 停用」就够：停用只删登录令牌，
    // 他名下的定时任务照跑（花公司的钱、推到他自己的企业微信）、他发出去的邀请码照样能注册进来。
    // 整段缘由在 lifecycle.js 头上；这里把「交接给谁」一并问掉，因为问完这一次就再没人会回头补了
    root.querySelectorAll("[data-off]").forEach((b) => {
      b.onclick = async () => {
        const who = b.dataset.off;
        // 交接对象是**全公司在职的人**，不是屏幕上这一页的五十个——所以单独去拉一趟名单，
        // 只要名字那几格（fields=lite）。名单拉不到就只剩「不交接」这一个选项：
        // 一个下拉框不该把整件事卡在这儿
        let mates = [];
        try {
          const r = await api("/api/admin/members?" + qs({ status: "active", fields: "lite", limit: 500 }));
          mates = (r.members || []).filter((x) => x.username !== who).map((x) => x.username);
        } catch { /* 下面按「没有别的在职成员」画 */ }
        modal({
          title: "给「" + who + "」办离职",
          body: `<div class="fd" style="font-size:14px;color:var(--foreground)">会一次性关掉：
            <b>账号</b>、<b>所有登录令牌</b>（含扫码连进来的手机 / 平板）、<b>他名下的定时任务</b>、
            <b>他发出去还没过期的邀请码</b>、<b>他绑的二次验证</b>，并掐断他正在跑的任务。<br><br>
            <b>不会删任何数据</b>：用量流水、对话记录、产出文件、历史审计一律原样保留——人走了账还得能对。</div>`,
          fields: [
            {
              name: "handover",
              label: "名下的定时任务交接给谁",
              type: "select",
              value: "",
              options: [{ value: "", label: mates.length ? "不交接（只停掉）" : "不交接（当前没有别的在职成员）" }].concat(mates.map((x) => ({ value: x, label: x }))),
              desc: "交接过去也是<b>关着</b>的——接手的人得先看清楚这条任务到底在干什么，再自己打开。直接接着跑最容易出的事是：他根本不知道每周一早上那封邮件是自己发的。",
            },
          ],
          ok: "办理离职",
          danger: true,
          onOk: async (v) => {
            const r = await post("/api/admin/members/" + encodeURIComponent(who) + "/offboard", { handover: (v.handover || "").trim() });
            showReceipt(who, r.text);
            route(true);
          },
        });
      };
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
            copyText(inviteLink(inv.code));
            toast("邀请码 " + inv.code + " 已生成，注册链接已复制");
            route(true);
          },
        });
    root.querySelectorAll("[data-copy]").forEach((b) => {
      b.onclick = () => { copyText(inviteLink(b.dataset.copy)); toast("链接已复制，发给他就行"); };
    });
    root.querySelectorAll("[data-copycode]").forEach((b) => {
      b.onclick = () => { copyText(b.dataset.copycode); toast("已复制 " + b.dataset.copycode); };
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

/**
 * 离职回执。做成能整段复制的纯文本，是因为它的下一站是交接单 / 工单 / 群里那条消息——
 * 一个只能看不能拿走的弹窗，等于逼人对着屏幕手抄一遍。
 */
function showReceipt(username, text) {
  modal({
    title: "已办理离职：" + username,
    body: `<div class="fd" style="font-size:13px">这张回执逐项写明关了什么、留了什么。<b>复制下来贴进交接单</b>，比事后回忆靠谱。</div>
      <pre class="ad-mono" style="margin-top:8px;padding:12px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--muted);white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.7;max-height:52vh;overflow:auto">${esc(text)}</pre>`,
    fields: [],
    ok: "复制并关闭",
    onOk: async () => { copyText(text); toast("回执已复制"); },
  });
}
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
/**
 * 邀请码拼成一条能点的链接。
 *
 * 以前「复制」复制的是那六位码本身。管理员把它粘到群里，收到的人得自己想明白：
 * 去哪个地址、点哪个「注册」、把这串字贴到哪个框——而自助注册按安全默认是关的，
 * 他打开首页压根看不到注册入口，多半直接回一句「点不动」。
 * 链接把这三步省掉：打开就是注册页，码已经填好了（工作台侧认 ?invite=）。
 *
 * 码本身仍然能单独复制——有人就是要发在工单里、念给对方听。
 */
function inviteLink(code) {
  return location.origin + "/?invite=" + encodeURIComponent(code);
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
/**
 * 这一页既是权限模型的说明书，也是它的操作台。四档角色、每一档能干什么，全部来自后端
 * 那张表（GET /api/admin/roles），不在这儿另抄一份——界面上写的和后端拦的必须是同一件事，
 * 不然「界面上藏一藏」就成了权限本身。
 */
PAGES.roles = {
  load: () => api("/api/admin/roles"),
  render: (d) => {
    const rank = (r) => d.ranks[r] || 0;
    const mine = rank(d.me.role);
    const meName = (ME || {}).username;
    // 服务端只回两样：管理层（审计员起，这张表本来就短）和提拔/转让的候选人（只要名字）。
    // 以前回的是整份花名册，3000 人时 1042 KB，为了画一张十来行的表
    const staff = d.staff;
    const canManage = (u) => !RO && u.username !== meName && rank(u.role) < mine;
    const why = (u) =>
      u.username === meName ? "这是你自己"
      : rank(u.role) > mine ? "比你高一档，你动不了"
      : rank(u.role) === mine ? "跟你同一档，同级动不了同级"
      : "";
    const rows = staff.map((u) => [
      `<div style="font-weight:500">${esc(u.nickname || u.username)}${u.username === meName ? " " + badge("你", "outline") : ""}</div><div class="fd ad-mono">${esc(u.username)}</div>`,
      badge(ROLE_LABEL[u.role] || u.role, u.role === "owner" ? "success" : "secondary"),
      esc(u.dept || "—"),
      `<span class="fd">${esc(ago(u.last_active))}</span>`,
      canManage(u)
        ? `<button class="ui-btn ui-btn--ghost ui-btn--xs" data-demote="${esc(u.username)}">降为成员</button>`
        : `<span class="fd">${esc(why(u))}</span>`,
    ]);
    const others = d.candidates.filter((u) => rank(u.role) < mine && u.username !== meName);
    const promotable = others.filter((u) => u.role === "member");
    const grants = (d.me.can_assign || []).filter((r) => r !== "member");

    return `<div class="ad-wrap">
      ${card(`${secT("两条规矩", "整套权限就这两条，下面那张表全是这两条推出来的。后端按它拦，不是界面上藏一藏。")}
        <div style="margin-top:14px">
          ${field("只能管比自己低的那一档", "同级之间谁也动不了谁——<b>管理员改不了另一个管理员</b>，停用、降级、删号、重置密码一样都做不到。以前不是这样：谁先点谁赢。", badge("核心", "secondary"))}
          ${field("授角色得够得着那个角色", "管理员能把成员提成审计员，但<b>发不出管理员</b>——那得超级管理员来。建号、发邀请码、部门模板走的是同一道闸，绕不过去。", badge("核心", "secondary"))}
        </div>`)}
      ${card(`${secT("四档角色", "从低到高。每一档多出来的能力都列在旁边。")}
        <div style="margin-top:14px">
          ${[...d.roles].reverse().map((r) => field(
            r.label + (r.role === d.me.role ? "（你）" : ""),
            (r.caps.length ? r.caps.map((c) => "· " + esc(d.caps[c] || c)).join("<br>") : "只能用工作台，进不来这个后台。"),
            badge(r.role === "owner" ? "每个组织一个" : r.role === "member" ? "默认" : r.role === "auditor" ? "只读" : "可写",
                  r.role === "owner" ? "success" : "outline")
          )).join("")}
        </div>
        <div class="ad-sec-d" style="margin-top:12px">超级管理员<b>不能增发、也不能罢免</b>，只能由现任<b>转让</b>。两个超管等于把「同级动不了同级」在最高那一档上重新打开：要么互相罢免（谁先点谁赢又回来了），要么谁也罢免不了谁（点错一次就永远拿不下来）。日常分权用管理员，要几个有几个。</div>
        ${MULTI ? `<div class="ad-sec-d" style="margin-top:8px">再往上还有一档跟这台机器有关的：<b>平台超级管理员</b>（默认组织的超管）。新建组织、改别的组织的套餐席位只有他能动，分公司的超管跑路了也由他指派接手的人。${OWNER ? badge("就是你", "success") : badge("不是你", "outline")}</div>` : ""}`)}
      ${cardT(
        headRow(
          secT("管理员和审计员", `共 ${staff.length} 人。${d.owner ? "超级管理员是「" + esc(d.owner) + "」。" : "<b>这个组织还没有超级管理员</b>，找平台超级管理员指派一个。"}`),
          `${RO || !d.me.can_transfer ? "" : `<button class="ui-btn ui-btn--outline ui-btn--sm" data-transfer>${ic("key")} 转让超级管理员</button>`}
           ${RO || !grants.length || !promotable.length ? "" : `<button class="ui-btn ui-btn--outline ui-btn--sm" data-promote>${ic("plus")} 提升成员</button>`}`
        ),
        table([{ t: "成员" }, { t: "角色" }, { t: "部门" }, { t: "最近活跃" }, { t: "" }], rows)
      )}
    </div>`;
  },
  bind: (root, d) => {
    const rank = (r) => d.ranks[r] || 0;
    const mine = rank(d.me.role);
    const meName = (ME || {}).username;
    const promotable = d.candidates.filter((u) => u.role === "member");
    const grants = (d.me.can_assign || []).filter((r) => r !== "member");
    const ROLE_HINT = { admin: "管理员 —— 能管成员、改设置；但改不了另一个管理员", auditor: "审计员 —— 能查账，改不动" };

    const p = root.querySelector("[data-promote]");
    if (p)
      p.onclick = () =>
        modal({
          title: "提升成员",
          fields: [
            { name: "username", label: "选一个人", type: "select",
              options: promotable.map((u) => ({ value: u.username, label: (u.nickname || u.username) + "（" + u.username + "）" })),
              // 名单有上限。截断了就得说——「下拉里找不到那个人」很容易被当成他不在这个组织里
              desc: d.candidates_capped ? `在职成员超过 ${promotable.length} 人，这里只列了前面这些。找不到人的话，先去<b>成员</b>页把他的角色改掉。` : "" },
            {
              name: "role", label: "提升为", type: "select", value: grants[grants.length - 1],
              // 下拉里出现的就是后端允许这个人授的那几个。管理员看不到「管理员」这一项，
              // 就算手改请求体，后端那道 assignProblem 照样拦
              options: grants.map((r) => ({ value: r, label: ROLE_HINT[r] || ROLE_LABEL[r] })),
            },
          ],
          ok: "提升",
          onOk: async (v) => {
            await post("/api/admin/members/" + encodeURIComponent(v.username), { role: v.role });
            toast("已提升为" + ROLE_LABEL[v.role]);
            route(true);
          },
        });

    const t = root.querySelector("[data-transfer]");
    if (t)
      t.onclick = () => {
        const to = d.candidates.filter((u) => u.username !== meName);
        if (!to.length) return toast("这个组织里还没有别人可以接手", true);
        modal({
          title: "转让超级管理员",
          body: `<div class="fd" style="margin-bottom:12px">交出去之后，<b>你会变成管理员</b>：还能管成员、改设置，但发不了管理员，也收不回这个位子——只有新的超管能再转回来。</div>`,
          fields: [
            { name: "username", label: "转给谁", type: "select",
              options: to.map((u) => ({ value: u.username, label: (u.nickname || u.username) + "（" + u.username + "·" + (ROLE_LABEL[u.role] || u.role) + "）" })),
              desc: d.candidates_capped ? "在职成员太多，这里只列了一部分。" : "" },
          ],
          ok: "确认转让",
          danger: true,
          onOk: async (v) => {
            await post("/api/admin/owner", { username: v.username });
            toast("超级管理员已转让给 " + v.username);
            route(true);
          },
        });
      };

    root.querySelectorAll("[data-demote]").forEach((b) => {
      const u = d.staff.find((x) => x.username === b.dataset.demote) || {};
      b.onclick = () =>
        confirmBox("把「" + b.dataset.demote + "」降为成员",
          "降完之后他<b>进不来这个后台</b>了，工作台照常用。" + (rank(u.role) >= rank("admin") ? "他手上的邀请码和部门模板不会跟着失效，需要的话去那两页各看一眼。" : ""),
          "降级", async () => {
            await post("/api/admin/members/" + encodeURIComponent(b.dataset.demote), { role: "member" });
            toast("已降为成员");
            route(true);
          });
    });
    void mine;
  },
};


/* ============ 付费 API 与额度 ============ */
/**
 * 为什么这一页要单独存在，而不是把额度塞进各自的设置页：
 *
 * 模型的 Key 配在「模型与 Key」，搜索的 Key 配在设置→搜索，生图的配在设置→媒体……
 * 管理员想回答一个再普通不过的问题——「这台服务器这个月在外部接口上花了多少、谁花的」——
 * 得翻四五个页面，而且每个页面都只告诉他「配了没有」，不告诉他「花了多少」。
 *
 * 这一页把**所有按次计费的接口**排成一列，每一行同时回答三件事：
 *   配没配 → 用了多少 → 限不限。
 * 三件事在同一行里，才能做出「这一路用得太凶，给它设个上限」这个判断。
 */
PAGES.apiquota = {
  load: () => api("/api/admin/api-quota"),
  render: (d) => {
    const caps = d.caps || [];
    const on = caps.filter((c) => c.quota.enabled).length;
    const today = caps.reduce((n, c) => n + c.today, 0);
    const month = caps.reduce((n, c) => n + c.month, 0);
    // 「开了闸门却没配 Key」不是错，但值得说一声：这一路根本没通，限额限了个空气
    const idle = caps.filter((c) => c.quota.enabled && !c.configured);

    const lim = (cap, k, ph) =>
      `<input class="ui-input ad-mono" type="number" min="0" placeholder="${ph}" style="width:110px"
        data-cap="${esc(cap.key)}" data-lim="${esc(k)}" value="${cap.quota[k] || ""}"${RO ? " disabled" : ""}>`;

    const capCard = (c) => {
      const q = c.quota;
      // 进度只在设了上限时才画。没设上限画一根永远填不满的条，等于告诉管理员「还早着呢」——
      // 而真相是这一路根本没有上限
      const bar = q.enabled && q.org_monthly
        ? `<div style="margin-top:10px">${progress((c.month / q.org_monthly) * 100)}
             <div class="fd" style="margin-top:4px">本月 ${num(c.month)} / ${num(q.org_monthly)} ${esc(c.unit)}</div></div>`
        : "";
      const provs = c.providers.length
        ? `<div class="fd" style="margin-top:8px">走的服务商：${c.providers.map((p) => `${esc(p.name)} ${num(p.n)}`).join(" · ")}</div>`
        : "";
      const top = c.top.length
        ? `<div class="fd" style="margin-top:4px">用得最多：${c.top.map((t) => `${esc(t.user)} ${num(t.n)}`).join(" · ")}</div>`
        : "";
      const state = c.configured
        ? badge(c.paid ? "已配置 · 按次计费" : "已就绪 · 不花钱", c.paid ? "secondary" : "outline")
        : badge("还没配", "outline");
      return cardT(
        headRow(
          secT(c.label, esc(c.why)),
          `${state}<span class="ad-mono fd">今天 ${num(c.today)} · 本月 ${num(c.month)} ${esc(c.unit)}</span>`
        ),
        `<div style="padding:0 20px 18px">
          ${bar}${provs}${top}
          <div class="ad-field" style="margin-top:12px">
            <div><div class="fl">开启额度闸门</div>
              <div class="fd">关着的时候照常记流水、不拦人。打开之后，撞上任何一道上限的调用会被当场挡下，
                模型收到的是一句说明白的话（撞的哪道闸、还剩多少、去哪儿改），它不会换个工具重试。</div></div>
            <div class="fc"><label class="ui-switch"><input type="checkbox" data-cap="${esc(c.key)}" data-lim="enabled"${
              q.enabled ? " checked" : ""}${RO ? " disabled" : ""}><i></i></label></div>
          </div>
          <div class="ad-field">
            <div><div class="fl">上限</div><div class="fd">留空或填 0 = 这一档不限。三道闸独立，撞上任何一道就挡。</div></div>
            <div class="fc ad-row" style="gap:8px;flex-wrap:wrap">
              ${lim(c, "user_daily", "每人每天")}${lim(c, "org_daily", "全组织每天")}${lim(c, "org_monthly", "全组织每月")}
            </div>
          </div>
          <div class="fd">依次是：每人每天 · 全组织每天 · 全组织每月（单位：${esc(c.unit)}）</div>
        </div>`
      );
    };

    return `<div class="ad-wrap">
      ${note("这一页管的是<b>按次计费的外部接口</b>——搜一次、生一张图、转一段音频。模型 token 不在这儿，"
        + "它按字数折算成积分，在「计量设置」和「成员用量」里。两本账分开记，是因为它们的单位根本不一样，"
        + "硬折成一个数就没法回答「这个月搜索到底花了多少次」。")}
      ${note("这儿是<b>次数闸</b>，另外还有一道<b>钱闸</b>：公司内部在界面上生图、生视频、转写，"
        + "跟中转站发出去的 Key <b>花的是同一笔预算</b>、走的是同一本账，在「API 中转站」那一页设。"
        + "<br>两道都得有：次数闸管「别把服务商的频率限制跑爆」，它对所有人一视同仁；"
        + "钱闸管「这个月的预算还剩多少」——200 张万相 plus 跟 200 张 flux 差了五十倍，只看次数的话两个长得一模一样。")}
      ${kpi([
        { label: "已开闸门", value: `${on} / ${caps.length}`, hint: "其余的只记账不拦人" },
        { label: "今天调用", value: num(today), hint: d.day },
        { label: "本月调用", value: num(month), hint: d.month },
        { label: "本月最贵的一路", value: esc((caps.filter((c) => c.paid).sort((a, b) => b.month - a.month)[0] || {}).label || "—"),
          hint: "按调用次数排，不是按钱" },
      ])}
      ${idle.length ? note(`这几路开了闸门，但还没配 Key，实际根本调不通：<b>${idle.map((c) => esc(c.label)).join("、")}</b>。`
        + `去「模型与 Key」或工作台的设置页配上，再回来限额才有意义。`, true) : ""}
      ${card(headRow(
        secT("一键设个合理额度", "按「一个十来人的团队正常用一个月」估的一组值，填进去并打开全部闸门。"
          + "填完还能逐项改——这只是个起点，不是规定。"),
        RO ? "" : `<button class="ui-btn ui-btn--outline ui-btn--sm" id="aq-suggest">填入建议值</button>`
      ))}
      ${caps.map(capCard).join("")}
      ${saveBar()}
    </div>`;
  },
  bind: (root, d) => {
    if (RO) return;
    const btn = root.querySelector("[data-save]");
    const tip = root.querySelector("[data-dirty]");
    const ctls = [...root.querySelectorAll("[data-cap]")];
    const readAll = () => {
      const out = {};
      for (const c of ctls) {
        const cap = (out[c.dataset.cap] = out[c.dataset.cap] || {});
        cap[c.dataset.lim] = c.type === "checkbox" ? c.checked : Math.max(0, +c.value || 0);
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
    const sug = root.querySelector("#aq-suggest");
    if (sug) sug.onclick = () => {
      // 只填表单、不直接落盘：管理员看得见填了什么，改两处再一起保存。
      // 点一下就静默生效的按钮，是这一页最不该有的东西——它管的是别人花钱的上限
      for (const c of ctls) {
        const v = (d.suggest || {})[c.dataset.cap];
        if (!v) continue;
        if (c.type === "checkbox") c.checked = !!v.enabled;
        else c.value = v[c.dataset.lim] || "";
      }
      check();
      toast("建议值已填入，确认后点保存");
    };
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await post("/api/admin/api-quota", { quota: readAll() });
        toast("已保存");
        route(true);
      } catch (e) {
        btn.disabled = false;
        toast(e.message, true);
      }
    };
  },
};

/* ============ API 中转站 ============ */
/**
 * 一页四件事：发 Key、看账、设上限、（平台管理员）改价目。
 *
 * 为什么挤在一页而不是拆成四页：管理员来这儿只有两个问题——「这个月花了多少」
 * 和「谁在花」。这两个问题的答案分别落在 Key 表、成员表和账单表上，
 * 它们必须是**同一时刻**的数：上限 100、已花 97、剩 3 这三格来自三次请求的话，
 * 三个数之间那个唯一会被核的关系（剩 = 上限 − 已花）就随时对不上。
 * 所以后端也是一个 GET 回全部（admin.js 里 /api/admin/relay 那段）。
 */
const yuan = (n) => {
  const v = Math.abs(+n || 0);
  if (v === 0) return "0";
  if (v < 0.01) return v.toFixed(4);
  if (v < 1000) return v.toFixed(2);
  return v.toFixed(0);
};
/** 「不限」和「0 元」在这一页上差着一整个语义，绝不能都显示成 0 */
const cap = (n) => (+n > 0 ? yuan(n) + " 元" : "不限");

/**
 * 「每个人单独的上限」那张表的筛选状态。跟这一页其余部分分开拉：那些数跟公司多少人没关系，
 * 只有这张表是按人头长的。以前是一趟全带回来——3000 人的组织一次 631 KB，其中 620 KB 是
 * 一张「跟随团队 · 本月 0 元」重复三千遍的表
 */
const RELAY_MEM_PAGE = 50;
let relayMQ = { q: "", offset: 0 };
PAGES.relay = {
  load: async () => {
    const [d, mb] = await Promise.all([
      api("/api/admin/relay"),
      api("/api/admin/relay/members?" + qs({ ...relayMQ, limit: RELAY_MEM_PAGE })),
    ]);
    // 翻到第 5 页的时候别人办了离职，服务端会把这一趟退回最后一页；把位置记下来，
    // 不然翻页条上写的还是第 5 页
    relayMQ.offset = mb.offset;
    return { ...d, mb };
  },
  render: (d) => {
    const keys = d.keys || [];
    const live = keys.filter((k) => k.enabled);
    const sp = d.spend || { by_key: [], by_user: [], by_model: [], by_cap: [], total: 0, calls: 0 };
    // 能力名的中文说法统一从后端拿（vkeys.CAP_CN）。前后端各维一份的话，
    // 哪天加了一路能力，这一页会静静地把它显示成一串英文 id。
    const CAPN = new Map((d.caps || []).map((c) => [c.key, c.label]));
    const capName = (k) => CAPN.get(k) || k || "对话";
    const orgLv = (d.levels || []).find((l) => l.level === "org") || null;
    const disc = d.budget.price_discount;
    // 「记了账但不知道多少钱」的那些：型号没登记价目。这一格必须单独显示——
    // 一张全是数字的账单里，看不出哪几行的 0 是真的 0、哪几行是「没算出来」
    const unknown = sp.by_model.reduce((n, m) => n + m.unknown, 0);
    const estimated = sp.by_model.reduce((n, m) => n + m.estimated, 0);

    const base = location.origin + "/v1";

    /* ---- 上面四格 ---- */
    const head = kpi([
      // 这一格的口径跟闸子（budget.spentOf）完全一致：**中转站 + 内部自己用**都算。
      // 只算中转那一半的话，它旁边站着的「组织上限」就是另一把尺子，
      // 管理员看到「还剩很多」而闸子已经快拦人了——同一屏上两个数互相矛盾，比少一个数更坏。
      { label: "本月已花", value: yuan(sp.total) + " 元",
        hint: `中转站 ${yuan(sp.relay)} 元 · 公司内部 ${yuan(sp.internal)} 元 · 共 ${num(sp.calls)} 次 · ${esc(d.month)}` },
      { label: "组织上限", value: cap(d.budget.org_yuan),
        hint: orgLv && orgLv.limit ? `还剩 ${yuan(orgLv.left)} 元` + (orgLv.blocked ? ` · 本月拦过 ${num(orgLv.blocked)} 次` : "") : "没设上限，花多少是多少" },
      { label: "在用的 Key", value: `${live.length} / ${keys.length}`, hint: keys.length > live.length ? `${keys.length - live.length} 把已停用` : "全部启用中" },
      { label: "人均默认上限", value: cap(d.budget.default_user_yuan), hint: disc !== 1 ? `记账按 ${(disc * 10).toFixed(1)} 折` : "没单独设过的人按这个走" },
    ]);

    /* ---- 怎么接 ---- */
    // 路由表写在这儿而不是丢给文档：管理员发完 Key 要把一句话发给业务方，
    // 而那句话里最常被问回来的就是「生图调哪个地址」。
    const ROUTES = [
      ["POST /v1/chat/completions", "对话（支持流式）"],
      ["POST /v1/embeddings", "向量化"],
      ["POST /v1/images/generations", "生图"],
      ["POST /v1/videos/generations", "生视频"],
      ["POST /v1/audio/speech", "语音合成（直接回音频字节）"],
      ["POST /v1/audio/transcriptions", "语音转写（multipart 上传）"],
      ["POST /v1/search", "联网搜索"],
      ["GET&nbsp; /v1/models", "这把 Key 能调的全部型号"],
      ["GET&nbsp; /v1/files/{id}", "取回生成的图 / 视频（留 24 小时）"],
    ];
    const how = card(`${secT("业务方怎么接", "把这两行填进他们现有的 OpenAI SDK 里就行，一个字的代码都不用改。")}
      <div class="ad-mono" style="margin-top:12px;background:var(--muted);border-radius:8px;padding:12px 14px;font-size:13px;line-height:2;word-break:break-all">
        base_url = <b>${esc(base)}</b><br>api_key&nbsp; = <b>${esc(d.prefix)}…</b>（下面发一把，明文只出现一次）
      </div>
      <div class="fd" style="margin-top:10px">这台机器对外是不是这个地址，取决于你的反代怎么配的；上面这行是按你现在访问后台的地址拼的。</div>
      <div style="margin-top:14px;display:grid;grid-template-columns:auto 1fr;gap:4px 14px;align-items:baseline">
        ${ROUTES.map(([r, t]) => `<code class="ad-mono">${r}</code><span class="fd">${esc(t)}</span>`).join("")}
      </div>
      <div class="fd" style="margin-top:10px">除了对话和向量化按 token 算，其余几路按量算（张 / 秒 / 千字符 / 分钟 / 次），
        走的是<b>同一套额度和同一本账</b>——一把 Key 把额度花在生视频上，对话那一路也一样会被拦。</div>`);

    /* ---- 渠道 ---- */
    const chRows = (d.channels || []).map((c) => [
      `<b>${esc(c.name)}</b><div class="fd">${esc(c.kind || "—")}</div>`,
      c.has_key ? badge("有 Key", "secondary") : badge("没填 Key", "outline"),
      c.models.length ? c.models.map((m) => `<code class="ad-mono">${esc(m)}</code>`).join(" ") : `<span class="fd">这条渠道下面一个型号都没挂</span>`,
    ]);
    const chan = cardT(
      headRow(secT("转得出去的渠道", "中转站认的是「型号挂在哪条渠道上」。没挂渠道的型号，业务方调过来只会收到一句「没有可用渠道」——"
        + "所以这张表把它们直说出来，而不是等对方来问。")),
      table([{ t: "渠道" }, { t: "状态" }, { t: "这条渠道下的型号" }], chRows) +
        ((d.orphans || []).length
          ? `<div style="padding:0 20px 18px">${note(`这些型号登记了但<b>没挂渠道</b>，中转站转不出去：`
              + d.orphans.map((m) => `<code>${esc(m)}</code>`).join("、")
              + `。去「模型与 Key」把它们归到一条渠道上。`, true)}</div>`
          : "")
    );

    /* ---- Key 表 ---- */
    const keyRow = (k) => {
      const pct = k.budget_yuan ? (k.spent_month / k.budget_yuan) * 100 : 0;
      const state = !k.enabled ? badge("已吊销", "outline")
        : k.expires_at && k.expires_at < iso(new Date()) ? badge("已过期", "destructive")
        : badge("在用", "secondary");
      return [
        `<b>${esc(k.name)}</b><div class="ad-mono fd">${esc(k.mask)}</div>`,
        state,
        k.user ? esc(k.user) : `<span class="fd">没挂人</span>`,
        `<div class="ad-mono">${yuan(k.spent_month)} / ${cap(k.budget_yuan)}</div>${
          k.budget_yuan ? `<div style="margin-top:4px;max-width:140px">${progress(pct)}</div>` : ""}`,
        `<div class="fd">${(k.caps || []).length ? (k.caps || []).map((c) => capName(c)).map(esc).join("、") : "七路能力全开"}</div>
         <div class="fd">${k.models.length ? k.models.map(esc).join("、") : "不限型号"}</div>
         <div class="fd">${k.ips.length ? "来源 " + k.ips.map(esc).join("、") : "不限来源"}${k.expires_at ? " · 到期 " + esc(k.expires_at) : ""}</div>`,
        `<span class="ad-mono">${num(k.calls)}</span><div class="fd">${k.last_used_at ? ago(k.last_used_at) : "从未"}</div>`,
        RO ? "" : `<div class="ad-row">
          <button class="ui-btn ui-btn--ghost ui-btn--sm" data-edit="${esc(k.id)}" title="改额度 / 型号 / 有效期">${ic("pencil")}</button>
          ${k.enabled
            ? `<button class="ui-btn ui-btn--ghost ui-btn--sm" data-revoke="${esc(k.id)}" title="吊销">${ic("lock")}</button>`
            : k.calls ? "" : `<button class="ui-btn ui-btn--ghost ui-btn--sm" data-del="${esc(k.id)}" title="删除">${ic("trash")}</button>`}
        </div>`,
      ];
    };
    const keyCard = cardT(
      headRow(
        secT("发出去的 Key", "每一把都能单独限额度、限型号、限来源 IP、限有效期。吊销之后上游那把真 Key 一个字节都不用换。"),
        RO ? "" : `<button class="ui-btn ui-btn--default ui-btn--sm" id="rl-new">${ic("plus")}发一把</button>`
      ),
      keys.length ? table(
        [{ t: "名字" }, { t: "状态" }, { t: "归属" }, { t: "本月 / 上限" }, { t: "限制" }, { t: "调用", right: true }, { t: "" }],
        keys.map(keyRow)
      ) : empty("还没发过 Key。发一把，把上面那两行给业务方就能接了")
    );

    /* ---- 账单 ---- */
    const spendTab = (title, rows, label) => cardT(
      headRow(secT(title, "")),
      rows.length ? table(
        [{ t: label }, { t: "调用", right: true }, { t: "输入 token", right: true }, { t: "输出 token", right: true }, { t: "本月花费", right: true }],
        rows.slice(0, 50).map((r) => [
          esc(r.key) + (r.unknown ? ` ${badge("有 " + r.unknown + " 次算不出钱", "outline")}` : ""),
          num(r.calls), big(r.prompt), big(r.completion), `<b class="ad-mono">${yuan(r.yuan)}</b>`,
        ])
      ) : empty("这个月还没有走中转站的调用")
    );
    const keyName = new Map(keys.map((k) => [k.id, k.name]));
    /**
     * 按能力分的那张单独列，而不是拼进上面三张：它的“量”每一行单位都不一样
     * （张 / 秒 / 千字符 / 分钟 / 次），token 那两列对它们来说永远是 0。
     * 按型号那张回答不了「钱是哪一路花的」——同一个型号名今天生图、明天生视频。
     */
    const capRows = (sp.by_cap || []).map((r) => [
      `<b>${esc(capName(r.key))}</b>` + (r.unknown ? ` ${badge("有 " + r.unknown + " 次算不出钱", "outline")}` : ""),
      num(r.calls),
      r.units ? `<span class="ad-mono">${esc(String(r.units))} ${esc(r.unit || "")}</span>` : `<span class="fd">按 token</span>`,
      `<b class="ad-mono">${yuan(r.yuan)}</b>`,
    ]);
    const capCard = cardT(
      headRow(secT("按能力", "公司买的不只是对话：搜索、生图、生视频、语音合成、语音转写——每一路一个单位、一份价。"
        + "最贵的那一路通常是生视频（1 条 5 秒的片子≈ 几百次对话），这张表就是拿来看这个的。")),
      capRows.length ? table(
        [{ t: "能力" }, { t: "调用", right: true }, { t: "用量", right: true }, { t: "本月花费", right: true }],
        capRows
      ) : empty("这个月还没有记到账的调用")
    );
    const billing = capCard
      + spendTab("按 Key", sp.by_key.map((r) => ({ ...r, key: keyName.get(r.key) || r.key })), "Key")
      + spendTab("按人", sp.by_user, "成员")
      + spendTab("按型号", sp.by_model, "型号");

    /* ---- 上限 ---- */
    const mb = d.mb || { rows: [], total: 0, matched: 0, capped: 0 };
    const memRows = mb.rows.map((m) => [
      `<b>${esc(m.nickname || m.username)}</b><div class="fd">${esc(m.username)}${m.dept ? " · " + esc(m.dept) : ""}</div>`,
      `<span class="ad-mono">${yuan(m.spent_month)} 元</span>`,
      m.budget_yuan ? `<span class="ad-mono">${yuan(m.budget_yuan)} 元</span>` : `<span class="fd">跟随团队（${cap(d.budget.default_user_yuan)}）</span>`,
      RO ? "" : `<button class="ui-btn ui-btn--ghost ui-btn--sm" data-mem="${esc(m.username)}" data-cur="${esc(m.budget_yuan || "")}">${ic("pencil")}</button>`,
    ]);
    const limits = card(`${secT("上限", "三档从小往大依次判：这把 Key 的 → 这个人的 → 整个组织的。撞上任何一档就当场拦下，"
      + "业务方收到的是一句说明白的 402（撞的哪档、上限多少、已用多少），而不是一个看不懂的错。"
      + "<br><b>员工在界面上的调用同样受这三档管</b>（没挂 Key 那一档自动跳过）——"
      + "有人拿内部工具批量生视频，跟一把外包 Key 失控是一样的后果，得用同一道闸拦。"
      + "次数层面的上限（一天最多搜多少次、生多少张）在「API 与额度」那一页。")}
      ${field("整个组织每月封顶", "0 = 不限。这是最后一道闸，谁都绕不过去。",
        `<input class="ui-input ad-mono" type="number" min="0" step="0.01" style="width:140px" data-b="org_yuan" value="${esc(d.budget.org_yuan || "")}" placeholder="不限"${RO ? " disabled" : ""}>`)}
      ${field("没单独设过的人，每人每月封顶", "0 = 不限。部门模板里填了 API 月预算的，按部门那个走，这一格只管剩下的人。",
        `<input class="ui-input ad-mono" type="number" min="0" step="0.01" style="width:140px" data-b="default_user_yuan" value="${esc(d.budget.default_user_yuan || "")}" placeholder="不限"${RO ? " disabled" : ""}>`)}
      ${field("跟上游谈下来的折扣", "0.8 = 八折，填 1 就是原价。<b>只改我们自己账本上的数，不改转发本身</b>——"
        + "上游照旧按原价扣我们的，这一格是让内部结算对得上实际付出去的钱。",
        `<input class="ui-input ad-mono" type="number" min="0.01" max="1" step="0.01" style="width:140px" data-b="price_discount" value="${esc(disc)}"${RO ? " disabled" : ""}>`)}
      ${RO ? note("你是<b>审计员</b>：这页能看，改不了。", true)
           : `<div class="ad-actions"><button class="ui-btn ui-btn--default ui-btn--sm" id="rl-save-budget">保存上限</button></div>`}`);
    // 人多的时候才出筛选条：三个人的团队顶一条筛选栏在头上，纯属添乱
    const memBar = mb.total < 8 ? "" : `<div class="ad-filter">
      <div class="ad-chips"><span class="ad-sub">${mb.matched !== mb.total ? `筛出 ${num(mb.matched)} / ${num(mb.total)} 人` : `共 ${num(mb.total)} 人`}${mb.capped ? `，${num(mb.capped)} 人设过单独上限` : ""}</span></div>
      <div class="ad-filter-r"><input class="ui-input ad-search" data-rq value="${esc(relayMQ.q)}" placeholder="搜姓名 / 账号 / 部门"></div>
    </div>`;
    const memCard = cardT(
      headRow(secT("每个人单独的上限", "设过单独上限的、本月花过钱的排在最前面，其余按进公司的先后。留空 = 跟随团队默认。"
        + "这本账跟「成员用量」那页的积分是两回事：那边算的是界面上用了几次，这边算的是拿 Key 调 API 花了多少钱。")),
      memBar + (memRows.length
        ? table([{ t: "成员" }, { t: "本月已花", right: false }, { t: "月上限" }, { t: "" }], memRows)
          + pager(relayMQ, mb.matched, RELAY_MEM_PAGE, "人")
        : empty(relayMQ.q ? "没有符合条件的成员" : "还没有成员"))
    );

    /* ---- 价目（平台管理员） ---- */
    let priceCard = "";
    if (d.prices) {
      const SRC = { builtin: ["内置", "outline"], admin: ["手填", "secondary"], channel: ["渠道自带", "secondary"] };
      priceCard = cardT(
        headRow(
          secT("价目表", `按<b>元 / 百万 token</b> 算——各家官网价目页印的就是这个形状，写成一样才比得了、抄错了也一眼看得出来。`
            + `内置那份是 ${esc(d.prices_as_of)} 抄的公开报价、按 1 美元 = ${esc(d.usd_cny)} 元折的，`
            + `只是个起点——你实际签的价八成不一样，手填的那份会盖住内置的。`
            + `<br>没登记价目的型号照样能转，只是那几笔记成 0 并标一句「算不出钱」，不会拦人。`),
          RO ? "" : `<button class="ui-btn ui-btn--outline ui-btn--sm" id="rl-price-new">${ic("plus")}加一个型号</button>`
        ),
        table(
          [{ t: "型号" }, { t: "输入", right: true }, { t: "缓存命中", right: true }, { t: "输出", right: true }, { t: "来自" }, { t: "" }],
          d.prices.map((p) => [
            `<code class="ad-mono">${esc(p.model)}</code>`,
            `<span class="ad-mono">${p.in == null ? "—" : yuan(p.in)}</span>`,
            `<span class="ad-mono">${p.cached_in == null ? "—" : yuan(p.cached_in)}</span>`,
            `<span class="ad-mono">${p.out == null ? "—" : yuan(p.out)}</span>`,
            badge(...(SRC[p.src] || ["内置", "outline"])),
            RO ? "" : `<div class="ad-row">
              <button class="ui-btn ui-btn--ghost ui-btn--sm" data-price="${esc(p.model)}" data-in="${esc(p.in == null ? "" : p.in)}" data-cin="${esc(p.cached_in == null ? "" : p.cached_in)}" data-out="${esc(p.out == null ? "" : p.out)}">${ic("pencil")}</button>
              ${p.src === "admin" ? `<button class="ui-btn ui-btn--ghost ui-btn--sm" data-price-del="${esc(p.model)}" title="删掉手填的，回到内置价">${ic("trash")}</button>` : ""}
            </div>`,
          ])
        )
      );
    }

    /* ---- 按量计价的那五路（平台管理员）---- */
    let unitCard = "";
    if (d.unit_prices) {
      const SRC = { builtin: ["内置", "outline"], admin: ["手填", "secondary"], channel: ["渠道自带", "secondary"] };
      unitCard = cardT(
        headRow(
          secT("按量计价：搜索 / 生图 / 生视频 / 语音",
            `这五路不按 token 收，按「几张」「几秒」「几千字符」「几分钟」「几次」收，`
            + `所以单列一张表——跟上面那张混在一起，「0.14 元/张」很容易被看成「0.14 元/百万 token」，`
            + `而这两个数差着百万倍。<br>`
            + `内置那份同样是 ${esc(d.prices_as_of)} 抄的公开报价，只是个起点；手填的会盖住内置的。`),
          RO ? "" : `<button class="ui-btn ui-btn--outline ui-btn--sm" id="rl-unit-new">${ic("plus")}加一个</button>`
        ),
        (d.unit_prices || []).map((g) => {
          const rows = (g.rows || []).map((p) => [
            `<code class="ad-mono">${esc(p.model)}</code>${p.note ? `<div class="fd">${esc(p.note)}</div>` : ""}`,
            `<span class="ad-mono">${yuan(p.price)} 元 / ${esc(g.unit)}</span>`,
            badge(...(SRC[p.src] || ["内置", "outline"])),
            RO ? "" : `<div class="ad-row">
              <button class="ui-btn ui-btn--ghost ui-btn--sm" data-uprice="${esc(p.model)}" data-ucap="${esc(g.cap)}" data-uval="${esc(p.price)}" data-unote="${esc(p.note || "")}">${ic("pencil")}</button>
              ${p.src === "admin" ? `<button class="ui-btn ui-btn--ghost ui-btn--sm" data-uprice-del="${esc(p.model)}" data-ucap="${esc(g.cap)}" title="删掉手填的，回到内置价">${ic("trash")}</button>` : ""}
            </div>`,
          ]);
          return `<div class="ad-card-h" style="border-top:1px solid var(--border)">${
            secT(`${g.cn}（元 / ${g.unit}）`, "")}</div>`
            + (rows.length ? table([{ t: "型号" }, { t: "单价", right: true }, { t: "来自" }, { t: "" }], rows)
                           : empty(`这一路还没登记过单价`));
        }).join("")
      );
    }

    /**
     * 催填单。这两行比上面两张价目表都重要：表里有什么是静态的，
     * 而这儿列的是「本月真调过、但查不到价」——每一条都是一笔真花了钱但记成 0 的账。
     * 不拦人（拦了业务方比少算一笔账惨得多），但得天天挂在这儿。
     */
    const nag = [];
    if ((d.prices_missing || []).length)
      nag.push(`这几个型号本月真调过，但<b>价目表里没有</b>，它们的账全记成了 0：`
        + d.prices_missing.map((m) => `<code>${esc(m)}</code>`).join("、"));
    if ((d.unit_missing || []).length)
      nag.push(`按量那几路里，这几个<b>没登记单价</b>：`
        + d.unit_missing.map((u) => `<code>${esc(u.model)}</code>（${esc(capName(u.cap))}，元/${esc(u.unit)}）`).join("、"));

    return `<div class="ad-wrap">
      ${note("中转站解决的是这么一件事：公司统一买了模型、搜索、生图、生视频、语音的额度，"
        + "现在小程序后台要接、数据组的脚本要接、外包也要接一点。"
        + "把上游那几把真 Key 发出去，就收不回来、也分不清谁花的钱。这一页发的是<b>虚拟 Key</b>——"
        + "各有各的额度、能力、型号、有效期和来源限制，随时能吊销，而上游那几把真 Key 一个字节都不用换。"
        + "<br><b>公司内部自己用也走同一笔预算</b>：下面那三档上限同时管着发出去的 Key 和员工在界面上的调用——"
        + "分两本账的话，「这个月花了多少」永远差一截，而差的那一截恰好是没人盯着的那一截。")}
      ${head}
      ${unknown || estimated ? note(`本月有 <b>${num(unknown)}</b> 次调用算不出钱（型号没登记价目），`
        + `<b>${num(estimated)}</b> 次的花费是估的（流式那一路上游没报 usage，按字数折的）。`
        + `上面那个「本月已花」不含前者。`, true) : ""}
      ${how}
      ${keyCard}
      ${chan}
      ${limits}
      ${memCard}
      ${billing}
      ${nag.length ? note(nag.join("<br>"), true) : ""}
      ${priceCard}
      ${unitCard}
    </div>`;
  },

  bind: (root, d) => {
    // 上限表的搜索和翻页是**只读**操作，审计员也该能用——下面那句 RO 早退是拦改东西的
    const goMem = (f) => { relayMQ = f; route(true); };
    const rq = root.querySelector("[data-rq]");
    if (rq) {
      // 防抖 250ms：搜的是整个组织，每个字发一趟，一个词打完就是六七趟
      let rt = 0;
      rq.oninput = () => { clearTimeout(rt); rt = setTimeout(() => goMem({ ...relayMQ, q: rq.value, offset: 0 }), 250); };
      rq.onkeydown = (e) => { if (e.key === "Enter") { clearTimeout(rt); goMem({ ...relayMQ, q: rq.value, offset: 0 }); } };
    }
    bindPager(root, relayMQ, RELAY_MEM_PAGE, goMem);
    if (RO) return;
    const reload = () => route(true);

    /* ---- 发一把 ---- */
    const KEY_FIELDS = (k) => [
      { name: "name", label: "给它起个名字", value: (k && k.name) || "", placeholder: "小程序后台",
        desc: "出事的时候你是靠这个名字认出「该吊销哪一把」的，所以写用途，别写「key1」" },
      { name: "user", label: "归到谁名下", type: "user", value: (k && k.user) || "", placeholder: "留空 = 不挂人",
        desc: "挂上人，账才算得清「谁花的」；而且<b>他离职的时候这把 Key 会跟着被吊销</b>——"
          + "躺在某个业务系统环境变量里的 Key，不会因为人走了就自己失效。" },
      { name: "budget_yuan", label: "这把 Key 每月最多花多少（元）", type: "number", value: (k && k.budget_yuan) || "",
        placeholder: "留空 = 不单独限", desc: "留空的话它仍然受这个人和整个组织那两档限制。" },
      { name: "expires_at", label: "到期日", type: "date", value: (k && k.expires_at) || "",
        desc: "留空 = 不过期。给外包的建议填上——做完自动作废，不用记得回来收。" },
      { name: "caps", label: "只允许走这几路能力", type: "checks", value: (k && k.caps) || [],
        options: (d.caps || []).map((c) => ({ value: c.key, label: c.label })),
        desc: "一个不勾 = 全开。跟型号白名单是两回事：发给外包做文案的那把，该限的不是「哪个型号」而是"
          + "<b>不准生视频</b>——视频是最贵的一路，而型号名一个月一变，拿型号白名单去拦能力，下个月上游改一个 id 就漏了。" },
      { name: "models", label: "只允许这几个型号", value: ((k && k.models) || []).join(", "),
        placeholder: "留空 = 不限，多个用逗号隔开", desc: "填了之后，调别的型号会被当场挡下。对话、生图、语音那几路都算。" },
      { name: "ips", label: "只允许这几个来源", value: ((k && k.ips) || []).join(", "),
        placeholder: "留空 = 不限，支持 1.2.3.4 和 1.2.3.0/24", desc: "服务器对服务器的调用建议填上：Key 泄漏之后，这一条就是最后一道门。" },
    ];
    const nn = (v) => String(v || "").trim();

    const newBtn = root.querySelector("#rl-new");
    if (newBtn) newBtn.onclick = () => modal({
      title: "发一把新 Key",
      fields: KEY_FIELDS(null),
      ok: "发出来",
      onOk: async (v) => {
        if (!nn(v.name)) throw new Error("给它起个名字——没名字的 Key，三个月后没人知道是谁在用");
        const out = await post("/api/admin/relay/keys", {
          name: nn(v.name), user: nn(v.user), budget_yuan: v.budget_yuan,
          expires_at: nn(v.expires_at), caps: nn(v.caps), models: nn(v.models), ips: nn(v.ips),
        });
        showSecret(out.secret, out.key);
      },
    });

    /**
     * 明文只在这一次出现。这个弹层刻意做得啰嗦：关掉之后**任何接口都拿不回来**，
     * 而人在「发完就关」的惯性下是不会读小字的——所以复制按钮就摆在正中间，
     * 关闭按钮写的是「我已经存好了」。
     */
    function showSecret(secret, key) {
      modal({
        title: "存好这一把，它不会再出现第二次",
        body: `<div class="fd" style="font-size:14px;color:var(--foreground);line-height:1.8">
            <b>${esc(key.name)}</b> 已经发出来了。下面这串明文<b>只在这一次显示</b>——
            库里存的是它的 sha256，之后任何接口、任何日志、任何导出都拿不回原文。
            丢了就回来重发一把（这是便宜操作），但没有「再看一次」。
          </div>
          <div class="ad-mono" id="rl-secret" style="margin-top:12px;background:var(--muted);border-radius:8px;padding:14px;font-size:13px;word-break:break-all;user-select:all">${esc(secret)}</div>
          <div class="ad-actions" style="margin-top:10px"><button class="ui-btn ui-btn--outline ui-btn--sm" id="rl-copy">${ic("copy")}复制</button></div>`,
        fields: [],
        ok: "我已经存好了",
        onOk: async () => { reload(); },
      });
      const btn = document.getElementById("rl-copy");
      if (btn) btn.onclick = async () => {
        try { await navigator.clipboard.writeText(secret); toast("已复制"); }
        catch { toast("复制不了，手动选中上面那串", true); }
      };
    }

    /* ---- 改 / 吊销 / 删 ---- */
    root.querySelectorAll("[data-edit]").forEach((b) => {
      b.onclick = () => {
        const k = (d.keys || []).find((x) => x.id === b.dataset.edit);
        if (!k) return;
        modal({
          title: "改「" + k.name + "」",
          body: `<div class="fd">改不到明文，也改不了它归哪个组织。</div>`,
          fields: KEY_FIELDS(k).concat([
            { name: "enabled", label: "还能用吗", type: "select", value: k.enabled ? "1" : "",
              options: [{ value: "1", label: "启用" }, { value: "", label: "停用" }] },
          ]),
          ok: "保存",
          onOk: async (v) => {
            await post("/api/admin/relay/keys/" + encodeURIComponent(k.id), {
              name: nn(v.name), user: nn(v.user), budget_yuan: v.budget_yuan,
              expires_at: nn(v.expires_at), caps: nn(v.caps), models: nn(v.models), ips: nn(v.ips), enabled: !!v.enabled,
            });
            toast("已保存");
            reload();
          },
        });
      };
    });
    root.querySelectorAll("[data-revoke]").forEach((b) => {
      b.onclick = () => {
        const k = (d.keys || []).find((x) => x.id === b.dataset.revoke);
        if (!k) return;
        confirmBox("吊销「" + k.name + "」", `吊销之后，<b>正在用它的程序下一次调用就会收到 401</b>——先去通知对接的人。<br>`
          + `这一行会留在表里（花过的 ${yuan(k.spent_month)} 元得查得到是谁花的），只是再也调不通了。`,
          "吊销", async () => {
            await post("/api/admin/relay/keys/" + encodeURIComponent(k.id), { revoke: true });
            toast("已吊销");
            reload();
          }, true);
      };
    });
    root.querySelectorAll("[data-del]").forEach((b) => {
      b.onclick = () => {
        const k = (d.keys || []).find((x) => x.id === b.dataset.del);
        if (!k) return;
        confirmBox("删掉「" + k.name + "」", "这把 Key 一次都没用过，删了不影响任何账。", "删除", async () => {
          await del("/api/admin/relay/keys/" + encodeURIComponent(k.id));
          toast("已删除");
          reload();
        }, true);
      };
    });

    /* ---- 上限 ---- */
    const saveB = root.querySelector("#rl-save-budget");
    if (saveB) saveB.onclick = async () => {
      const g = (k) => root.querySelector(`[data-b="${k}"]`).value;
      saveB.disabled = true;
      try {
        await post("/api/admin/relay/budget", {
          budget: { org_yuan: g("org_yuan"), default_user_yuan: g("default_user_yuan") },
          price_discount: g("price_discount"),
        });
        toast("已保存，下一次调用就按新上限判");
        reload();
      } catch (e) { saveB.disabled = false; toast(e.message, true); }
    };
    root.querySelectorAll("[data-mem]").forEach((b) => {
      b.onclick = () => modal({
        title: "改「" + b.dataset.mem + "」的 API 月预算",
        fields: [{ name: "budget_yuan", label: "每月最多花多少（元）", type: "number", value: b.dataset.cur,
          placeholder: "留空 = 跟随团队默认",
          desc: "留空或填 0 <b>不是「一分钱都不给」</b>，是「不单独设」——按部门模板、再按组织默认走。" }],
        ok: "保存",
        onOk: async (v) => { await post("/api/admin/relay/members/" + encodeURIComponent(b.dataset.mem), { budget_yuan: v.budget_yuan }); toast("已保存"); reload(); },
      });
    });

    /* ---- 价目 ---- */
    const PRICE_FIELDS = (m, i, ci, o) => [
      { name: "model", label: "型号名", value: m || "", placeholder: "gpt-4o-mini",
        desc: "按前缀匹配：填 <code>gpt-4o</code>，<code>gpt-4o-2026-05-01</code> 也认。" },
      { name: "in", label: "输入（元 / 百万 token）", type: "number", value: i == null ? "" : i },
      { name: "cached_in", label: "缓存命中的输入（元 / 百万 token）", type: "number", value: ci == null ? "" : ci,
        desc: "留空 = 命中也按输入价收。<b>不替供应商猜一个折扣</b>：猜低了账永远对不上，而对不上的方向是「我们以为便宜」。" },
      { name: "out", label: "输出（元 / 百万 token）", type: "number", value: o == null ? "" : o },
    ];
    const pNew = root.querySelector("#rl-price-new");
    if (pNew) pNew.onclick = () => modal({
      title: "加一个型号的价目",
      body: `<div class="fd">价目是<b>整台服务器一份</b>的，改了对所有组织的账都生效。</div>`,
      fields: PRICE_FIELDS("", "", "", ""),
      ok: "保存",
      onOk: async (v) => { await post("/api/admin/relay/prices", v); toast("已保存"); reload(); },
    });
    root.querySelectorAll("[data-price]").forEach((b) => {
      b.onclick = () => modal({
        title: "改「" + b.dataset.price + "」的价目",
        fields: PRICE_FIELDS(b.dataset.price, b.dataset.in, b.dataset.cin, b.dataset.out),
        ok: "保存",
        onOk: async (v) => { await post("/api/admin/relay/prices", v); toast("已保存"); reload(); },
      });
    });
    root.querySelectorAll("[data-price-del]").forEach((b) => {
      b.onclick = () => confirmBox("删掉「" + b.dataset.priceDel + "」的手填价目",
        "删掉之后这个型号回到内置价目（内置里没有的话，它的调用就记成「算不出钱」）。", "删除",
        async () => { await post("/api/admin/relay/prices", { model: b.dataset.priceDel, remove: true }); toast("已删除"); reload(); }, true);
    });

    /* ---- 按量单价 ---- */
    // 走另一条接口（/unit-prices），不是上面那条。两边的单位不一样，
    // 合成一条的话一个写错字段名的请求会静静地写进另一张表。
    const UNIT_FIELDS = (cap, m, price, note) => [
      { name: "cap", label: "哪一路", type: "select", value: cap || "image",
        options: (d.unit_prices || []).map((g) => ({ value: g.cap, label: `${g.cn}（元 / ${g.unit}）` })) },
      { name: "model", label: "型号名", value: m || "", placeholder: "wanx2.1-t2i-turbo",
        desc: "搜索那一路填的是<b>引擎名</b>（tavily / brave / jina），不是型号。" },
      { name: "price", label: "单价（元）", type: "number", value: price == null ? "" : price,
        desc: "单位看上面那一格选的是哪一路。填 0 是「确实不收钱」，跟「不知道多少钱」不是一回事。" },
      { name: "note", label: "备注", value: note || "", placeholder: "比如：按 720p 折算，分辨率一变就不准了",
        desc: "折算过的价请务必写一句依据。半年后看到一个 0.30，没人记得它是怎么来的。" },
    ];
    const uNew = root.querySelector("#rl-unit-new");
    if (uNew) uNew.onclick = () => modal({
      title: "加一个按量单价",
      body: `<div class="fd">价目是<b>整台服务器一份</b>的，改了对所有组织的账都生效。</div>`,
      fields: UNIT_FIELDS("", "", "", ""),
      ok: "保存",
      onOk: async (v) => { await post("/api/admin/relay/unit-prices", v); toast("已保存"); reload(); },
    });
    root.querySelectorAll("[data-uprice]").forEach((b) => {
      b.onclick = () => modal({
        title: "改「" + b.dataset.uprice + "」的单价",
        fields: UNIT_FIELDS(b.dataset.ucap, b.dataset.uprice, b.dataset.uval, b.dataset.unote),
        ok: "保存",
        onOk: async (v) => { await post("/api/admin/relay/unit-prices", v); toast("已保存"); reload(); },
      });
    });
    root.querySelectorAll("[data-uprice-del]").forEach((b) => {
      b.onclick = () => confirmBox("删掉「" + b.dataset.upriceDel + "」的手填单价",
        "删掉之后回到内置单价（内置里没有的话，它的调用就记成「算不出钱」）。", "删除",
        async () => { await post("/api/admin/relay/unit-prices", { cap: b.dataset.ucap, model: b.dataset.upriceDel, remove: true }); toast("已删除"); reload(); }, true);
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
/**
 * 操作审计。合规的人来看这张表，问的是「9 月 3 号谁动了额度」「这半年谁重置过密码」——
 * 所以时间范围、按操作人/动作筛、搜索、导出这四样是刚需，不是锦上添花。
 *
 * 导出给的是 CSV：开源版到这儿为止。商业版卖的是「导出的东西能当证据」——
 * 防篡改链、直推 SIEM、保留期策略，那是另一套东西，不在这个文件里。
 */
let auditF = { from: "", to: "", q: "", actor: "", action: "", offset: 0 };
const AUDIT_PAGE = 50;
/**
 * 审计那一页的副标题。以前写死「这个组织建起来到现在的全部管理动作」——
 * 而审计是有保留上限的，存满之后最老的会被挤掉，那句话就成了假话。
 * 假话出现在审计页尤其贵：看这张表的人正是拿它当证据的人。
 */
function auditScope(d) {
  const tail = "按时间倒序。";
  if (!d || !d.kept) return "这个组织还没有管理动作记录。" + tail;
  if (d.capped) return `最近 ${d.kept} 条（已到保留上限，更早的已被挤掉），` + tail;
  return `这个组织建起来到现在的全部 ${d.kept} 条管理动作，` + tail;
}
PAGES.audit = {
  load: () => api("/api/admin/audit?" + qs({ limit: AUDIT_PAGE, offset: auditF.offset, from: auditF.from, to: auditF.to, q: auditF.q, actor: auditF.actor, action: auditF.action })),
  render: (d) => {
    const rows = d.audit.map((a) => [
      `<span class="ad-mono">${esc(fmtTs(a.ts))}</span>`,
      esc(a.actor || "系统"),
      badge(a.action, "outline"),
      esc(a.target || "—"),
      `<span class="fd">${esc(a.detail || "")}</span>`,
    ]);
    const pick = (name, cur, list, all) =>
      `<select class="ui-input ui-select ad-pick" data-${name}>` +
      [`<option value="">${all}</option>`]
        .concat(list.map((x) => `<option value="${esc(x)}"${x === cur ? " selected" : ""}>${esc(x)}</option>`))
        .join("") +
      `</select>`;
    return `<div class="ad-wrap ad-wrap--wide">
      ${note("记的是<b>管理动作</b>：谁加了人、谁改了额度、谁动了安全开关。任务本身跑了什么在「用量明细」里。密码、密钥这类东西<b>不会</b>进这张表。")}
      ${d.capped ? note(`这个组织的审计已经存满 <b>${d.cap}</b> 条，再往里记会把最老的挤掉，现存最早的一条是 <b>${esc(fmtTs(d.since))}</b>。<br>要查更早的事，先按时间范围<b>导出存档</b>——挤掉之后没有第二个地方找得回来。`, "warn") : ""}
      ${cardT(
        headRow(
          secT("操作审计", auditScope(d)),
          `<button class="ui-btn ui-btn--outline ui-btn--sm" data-csv>${ic("download")} 导出${d.total > (d.audit || []).length ? "全部 " + d.total + " 条" : "本页"}</button>`
        ),
        `${filterBar(auditF, {
          placeholder: "搜操作人 / 对象 / 详情",
          extra: pick("actor", auditF.actor, d.actors || [], "全部操作人") + pick("action", auditF.action, d.actions || [], "全部动作"),
        })}
        ${table([{ t: "时间" }, { t: "操作人" }, { t: "动作" }, { t: "对象" }, { t: "详情" }], rows)}
        ${pager(auditF, d.total || 0, AUDIT_PAGE)}`
      )}
    </div>`;
  },
  bind: (root, d) => {
    const go = (f) => { auditF = f; route(true); };
    bindFilter(root, auditF, go);
    bindPager(root, auditF, AUDIT_PAGE, go);
    const a = root.querySelector("[data-actor]"), k = root.querySelector("[data-action]");
    if (a) a.onchange = () => go({ ...auditF, actor: a.value, offset: 0 });
    if (k) k.onchange = () => go({ ...auditF, action: k.value, offset: 0 });
    root.querySelector("[data-csv]").onclick = async (ev) => {
      const btn = ev.currentTarget;
      // 一次能取多少由后端封着（listAudit 的 limit 上限）；条数多就分几趟，
      // 别为了省事把上限调大——那是让后端一次把整本读进内存
      const CHUNK = 1000;
      const rows = [];
      btn.disabled = true;
      const label = btn.innerHTML;
      try {
        for (let off = 0; off < (d.total || 0); off += CHUNK) {
          btn.textContent = rows.length ? `导出中 ${rows.length}/${d.total}` : "导出中…";
          const part = await api("/api/admin/audit?" + qs({
            limit: CHUNK, offset: off,
            from: auditF.from, to: auditF.to, q: auditF.q, actor: auditF.actor, action: auditF.action,
          }));
          const got = (part && part.audit) || [];
          if (!got.length) break; // 后端没东西给了就停，免得条数对不上时空转
          for (const x of got) rows.push(x);
        }
        downloadCsv("操作审计", ["时间", "操作人", "动作", "对象", "详情"],
          rows.map((x) => [x.ts, x.actor || "", x.action || "", x.target || "", x.detail || ""]));
      } finally {
        btn.disabled = false;
        btn.innerHTML = label;
      }
    };
  },
};

/* ============ 模型与 Key ============ */
/**
 * 这页配的是**这台服务器**的模型渠道和密钥，不是某一个组织的——所以标了 platform: true，
 * 跟「组织管理」一个档，只有平台管理员看得见。
 *
 * 为什么后台要再放一处（工作台 → 设置 → 模型 里本来就能填）：一把 Key 都没填的时候，
 * 这台服务器一句话都发不出去；而在企业部署里，管这件事的人打开的是这个后台，
 * 他不一定会绕到工作台去。
 *
 * 两处的分工照「运维 / 选型」划：
 *   这页管运维——哪把 Key、默认走哪条、主渠道挂了换谁。一屏看完，一次存完。
 *   加渠道、加模型、挑型号还在工作台——那要现从渠道拉模型列表、要看每条的战绩，
 *   搬进后台表格只会两边都做不好。所以这页末尾留一句指过去，不复制第二套 CRUD。
 */
/** 跟工作台那边同一条判据：Ollama 这类本机服务不要 Key，别把它归进「还没填」等着人去填 */
function chanIdle(p) {
  if (p.kind === "ollama" || /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(String(p.base_url || ""))) return false;
  // has_key 是读接口给非平台管理员回的（真 Key 被掩成星号），只有它是可信的
  return p.has_key === false || !String(p.api_key || "").trim();
}
PAGES.models = {
  load: async () => {
    const [s, cat] = await Promise.all([
      api("/api/settings"),
      // 目录只拿来给类型中文名和「去拿 Key」的链接。拉不到就退回只显示 kind 本身，别把整页拖垮
      api("/api/model-catalog").catch(() => ({ kinds: [] })),
    ]);
    return { s, kinds: (cat && cat.kinds) || [] };
  },
  render: (d) => {
    const s = d.s;
    // 能不能改，看 /api/settings 自己回的 platform_owner——跟保存时后端用的是同一个判据，
    // 不会出现「界面画了输入框、一存就 403」
    const rw = !!s.platform_owner && !RO;
    const provs = s.providers || [];
    const models = s.models || [];
    const medias = s.media_models || [];
    const kindOf = (k) => d.kinds.find((x) => x.kind === k) || null;
    const kindLabel = (k) => (kindOf(k) || {}).label || k || "自定义";
    // 模型这一层的 Key 是渠道压平下来的（chat-models 每次规整都会写一遍），所以判据跟渠道同一条
    const modelIdle = (m) => chanIdle({ kind: "", base_url: m.base_url, has_key: m.has_key, api_key: m.api_key });

    // 同一个地址挂两条渠道是合法的——两个账号、两把 Key、各花各的额度，并成一条等于在
    // 不知情的情况下花别人的钱。但这两条的名字常常一模一样（都是从同一份目录里建的），
    // 列表上分不出谁是谁，填 Key 就会填到错的那一行。所以这里只做一件事：把「同地址」标出来。
    const baseKey = (p) => String(p.base_url || "").trim().replace(/\/+$/, "").toLowerCase();
    const baseCount = new Map();
    for (const p of provs) { const b = baseKey(p); if (b) baseCount.set(b, (baseCount.get(b) || 0) + 1); }
    const dupN = (p) => (baseKey(p) && baseCount.get(baseKey(p)) > 1 ? baseCount.get(baseKey(p)) - 1 : 0);

    const provRow = (p) => {
      const chat = models.filter((m) => m.channel === p.id).length;
      const media = medias.filter((m) => m.provider === p.id).length;
      const label = kindLabel(p.kind);
      // 预置渠道的名字本来就是这家的中文名，再把同一句话印一遍读起来就是同一个词写了两遍
      const sub = [String(p.name || "").trim() === String(label).trim() ? "" : label, p.base_url].filter(Boolean).join(" · ");
      const k = kindOf(p.kind);
      const link = k && k.key_url
        ? `<a class="ui-btn ui-btn--link" href="${esc(k.key_url)}" target="_blank" rel="noopener">去拿 Key</a>` : "";
      const cells = [
        `<div><div>${esc(p.name)}</div>${sub ? `<div class="fd ad-mono" style="margin-top:2px">${esc(sub)}</div>` : ""}${
          dupN(p) ? `<div class="fd" style="margin-top:2px">同地址还有 ${dupN(p)} 条，各自一把 Key、各花各的账</div>` : ""}</div>`,
        rw
          ? `<div class="ad-row"><input class="ui-input ad-key" data-pk="${esc(p.id)}" type="password" autocomplete="off"
               placeholder="${p.kind === "ollama" ? "本机跑的，不用填" : "粘贴这家服务商的 API Key"}"
               value="${esc(p.api_key || "")}" style="flex:1;min-width:180px">
             <button class="ui-btn ui-btn--ghost ui-btn--sm" type="button" data-peek="${esc(p.id)}">显示</button>${link}</div>`
          : `<span class="fd">${p.has_key ? "已填（原文只有平台管理员看得到）" : "还空着"}</span>`,
        `${chanIdle(p) ? badge("还没填 Key", "outline") : badge("已填 Key", "success")}
         <div class="fd" style="margin-top:4px">${chat} 个对话模型${media ? ` · ${media} 个媒体模型` : ""}</div>`,
      ];
      // 「改」连地址一起改：换了域名的私有部署、公司内网代理，都是改地址而不是重建一条。
      // 「删」是连坐的，所以放在最右边、走确认框，不做成一点就没。
      if (rw) cells.push(`<div class="ad-row"><button class="ui-btn ui-btn--ghost ui-btn--sm" type="button" data-pedit="${esc(p.id)}">改</button><button class="ui-btn ui-btn--ghost ui-btn--sm" type="button" data-pdel="${esc(p.id)}">删</button></div>`);
      return cells;
    };
    // 填好的排前面。这页是「来填 Key 的」，所以空着的照样全列出来——
    // 把它们收起来，这页就又没地方填 Key 了。
    const rows = [...provs.filter((p) => !chanIdle(p)), ...provs.filter((p) => chanIdle(p))].map(provRow);

    const opts = (cur, none) =>
      (none ? `<option value=""${cur ? "" : " selected"}>${esc(none)}</option>` : "") +
      models.map((m) => `<option value="${esc(m.name)}"${m.name === cur ? " selected" : ""}>${esc(m.name)}（${esc(m.model)}）${modelIdle(m) ? " · 还没填 Key" : ""}</option>`).join("");
    const cur = models.find((m) => m.name === s.active_model);
    const noKeyNow = cur && modelIdle(cur);

    return `<div class="ad-wrap">
      ${note("这几项配的是<b>整台服务器</b>，不是单个组织——一个部署一套 Key，所有组织的任务都花它。改完立刻生效，<b>已经在跑</b>的任务用的还是旧的那把。")}
      ${!models.length ? note("这台服务器<b>一个对话模型都还没有</b>，谁来了都发不出话。先去工作台 → 设置 → 模型 里加一条，再回来填 Key。", true)
        : noKeyNow ? note(`默认模型「<b>${esc(s.active_model)}</b>」所在的渠道<b>还没填 Key</b>，现在发任务会当场失败。在下面那张表里把它填上。`, true) : ""}

      ${cardT(headRow(secT("渠道与 Key", "一个渠道一把 Key，挂在它底下的对话模型和媒体模型都共用这一把——换 Key 只改这一处。目录里没有的（自建网关、内网代理、私有部署），点右上角自己加一条。"),
          rw ? `<button class="ui-btn ui-btn--outline ui-btn--sm" type="button" data-pnew>${ic("plus")} 新渠道</button>` : ""),
        table([{ t: "渠道" }, { t: "API Key" }, { t: "状态" }, ...(rw ? [{ t: "" }] : [])], rows))}

      ${!models.length ? "" : card(`${secT("默认走哪条")}
        <div style="margin-top:14px">
          ${field("默认模型", "成员没有单独指定的时候用它。每个人还可以在输入框右下角临时换一条，只影响他自己那一次。",
            `<select class="ui-input ui-select" data-sel="active_model"${rw ? "" : " disabled"} style="min-width:260px">${opts(s.active_model, "")}</select>`)}
          ${field("主渠道挂了换谁", "默认不换。<b>绝不静默降级</b>：只有你在这儿亲手选了一条，换道才会发生，而且会在对话里大声说出来——不然账单涨了都不知道是哪条在跑。",
            `<select class="ui-input ui-select" data-sel="failover_model"${rw ? "" : " disabled"} style="min-width:260px">${opts((s.agent || {}).failover_model || "", "不换道（默认）")}</select>`)}
        </div>`)}

      ${cardT(headRow(secT("这台服务器上的模型", "加模型、改型号、看每条的战绩在工作台 → 设置 → 模型。这儿只列出来核对。")),
        table([{ t: "名字" }, { t: "模型 id" }, { t: "挂在哪个渠道" }, { t: "状态" }],
          models.map((m) => {
            const p = provs.find((x) => x.id === m.channel);
            return [
              esc(m.name),
              `<span class="ad-mono">${esc(m.model)}</span>`,
              p ? esc(p.name) : `<span class="fd">（渠道已删）</span>`,
              [m.name === s.active_model ? badge("默认", "secondary") : "", modelIdle(m) ? badge("还没填 Key", "outline") : ""].filter(Boolean).join(" ") || "—",
            ];
          })))}

      ${rw ? saveBar() : note("这页要<b>平台管理员</b>（默认组织的管理员）才能改。Key 是整台服务器的账单凭证，不归单个组织管。", true)}
    </div>`;
  },
  bind: (root, d) => {
    // 填完 Key 想核一眼填的是不是那把。默认是 password：后台常常是开着投屏在讲的
    const keys = new Map([...root.querySelectorAll(".ad-key")].map((i) => [i.dataset.pk, i]));
    root.querySelectorAll("[data-peek]").forEach((b) => (b.onclick = () => {
      const i = keys.get(b.dataset.peek);
      if (!i) return;
      const hidden = i.type === "password";
      i.type = hidden ? "text" : "password";
      b.textContent = hidden ? "隐藏" : "显示";
    }));

    const btn = root.querySelector("[data-save]");
    const tip = root.querySelector("[data-dirty]");
    if (!btn) return; // 只读那一版根本没有保存条
    const sels = new Map([...root.querySelectorAll("[data-sel]")].map((x) => [x.dataset.sel, x]));
    const readAll = () => {
      // providers 是整表覆盖的：必须把没动过的那些原样送回去，只换 Key 那一格。
      // 只送改动的那几条 = 其余渠道当场消失，连带挂在它们底下的模型全断线
      const body = {
        providers: (d.s.providers || []).map((p) => ({ ...p, api_key: keys.has(p.id) ? keys.get(p.id).value.trim() : p.api_key })),
      };
      if (sels.has("active_model")) body.active_model = sels.get("active_model").value;
      if (sels.has("failover_model")) body.agent = { failover_model: sels.get("failover_model").value };
      return body;
    };
    const base = JSON.stringify(readAll());
    const check = () => {
      const dirty = JSON.stringify(readAll()) !== base;
      btn.disabled = !dirty;
      tip.style.display = dirty ? "" : "none";
    };
    [...keys.values(), ...sels.values()].forEach((c) => { c.addEventListener("input", check); c.addEventListener("change", check); });

    /* ---- 渠道的增 / 改 / 删 ----
     * 为什么这页也得能加渠道：预置目录只有十来家，自建网关（new-api / one-api）、公司内网代理、
     * 换了域名的私有部署都不在里面。企业部署里管 Key 的人打开的就是这个后台，
     * 让他为了加一条渠道再绕回工作台，等于这页只做了一半。
     *
     * 三个动作都拿 readAll() 当底稿——它读的是**屏幕上**那几个 Key 输入框，不是加载时的快照。
     * 图省事直接用 d.s.providers 的话，用户刚敲进去、还没点保存的那把 Key 会被这一趟悄悄抹掉。
     */
    const kindOpts = d.kinds.length
      ? d.kinds.map((k) => ({ value: k.kind, label: k.label }))
      : [{ value: "custom", label: "其它 OpenAI 兼容接口" }]; // 目录没拉到也得能建，别把人堵在这儿
    const provOf = (id) => (d.s.providers || []).find((x) => x.id === id);
    const provForm = (p) => {
      const m = modal({
        title: p ? `改渠道「${p.name}」` : "新渠道",
        fields: [
          { name: "kind", label: "类型", type: "select", options: kindOpts, value: (p && p.kind) || "custom",
            desc: "决定这条渠道说哪家的协议、默认地址填什么。自建网关和各种 OpenAI 兼容服务选最后两项。" },
          { name: "name", label: "名字", value: (p && p.name) || "", placeholder: "例如：公司内网网关",
            desc: "挂模型时按名字认，起个一眼分得出来的。" },
          { name: "base_url", label: "接口地址", value: (p && p.base_url) || "", placeholder: "https://…/v1",
            desc: "填到 <b>/v1</b> 这一层就行，后面的 /chat/completions 由程序自己接。Anthropic 官方走 SDK，不用填。" },
          { name: "api_key", label: "API Key", type: "password", value: (p && p.api_key) || "", placeholder: "本机服务（Ollama）留空",
            desc: "地址跟已有渠道一模一样、Key 又留空，保存时会被并进那一条——这是为了不让开箱向导重复建行。要单独一条就把 Key 填上。" },
        ],
        ok: p ? "保存" : "建好",
        onOk: async (v) => {
          const kind = String(v.kind || "").trim();
          const name = String(v.name || "").trim();
          const url = String(v.base_url || "").trim();
          if (!name) throw new Error("给渠道起个名字，挂模型时要按名字认");
          if (kind !== "anthropic" && !/^https?:\/\//i.test(url)) throw new Error("接口地址要填完整的 http(s) 地址");
          const body = readAll();
          const list = body.providers.slice();
          // id 留空是给服务端认的暗号：normalizeProviders 会照名字生成一个不重样的
          const entry = { id: p ? p.id : "", kind, name, base_url: url, api_key: String(v.api_key || "").trim() };
          const i = p ? list.findIndex((x) => x.id === p.id) : -1;
          if (i >= 0) list[i] = { ...list[i], ...entry }; else list.push(entry);
          body.providers = list;
          await post("/api/settings", body);
          toast(p ? "已保存，立刻生效" : "渠道建好了，去工作台 → 设置 → 模型 给它挂模型");
          route(true);
        },
      });
      // 选了类型就把官方地址填上。十来家的地址没人背得下来，让人去搜一遍纯属多余。
      // 只覆盖「目录里有官方地址」的那几家——自建网关和自定义这两项地址本来就得用户自己填，别把他填的清掉。
      const ks = m.querySelector("#mf-kind"), nb = m.querySelector("#mf-base_url"), nn = m.querySelector("#mf-name");
      ks.onchange = () => {
        const k = d.kinds.find((x) => x.kind === ks.value) || {};
        if (k.base_url) nb.value = k.base_url;
        if (!nn.value.trim()) nn.value = String(k.label || "").replace(/（.*/, "");
      };
    };

    const pnew = root.querySelector("[data-pnew]");
    if (pnew) pnew.onclick = () => provForm(null);
    root.querySelectorAll("[data-pedit]").forEach((b) => (b.onclick = () => {
      const p = provOf(b.dataset.pedit);
      if (!p) return;
      const live = keys.get(p.id); // 那一格可能刚改过还没存，表单里要显示他正在看的那把
      provForm({ ...p, api_key: live ? live.value : p.api_key });
    }));
    root.querySelectorAll("[data-pdel]").forEach((b) => (b.onclick = () => {
      const p = provOf(b.dataset.pdel);
      if (!p) return;
      // 删渠道是连坐的：挂在它下面的模型一起没。把数报清楚，别删完才发现画图不能用了
      const chat = (d.s.models || []).filter((m) => m.channel === p.id);
      const media = (d.s.media_models || []).filter((m) => m.provider === p.id);
      const hitsDefault = chat.some((m) => m.name === d.s.active_model);
      const lines = [chat.length + media.length
        ? `挂在它下面的 <b>${chat.length} 个对话模型</b>和 <b>${media.length} 个媒体模型</b>会一起删掉。`
        : "这条渠道下面没挂模型，删掉只影响它自己。"];
      if (hitsDefault) lines.push("<b>当前默认模型就在里面</b>，删完会自动换成列表里的第一个。");
      lines.push("这把 Key 也一并删除，之后要用得重新填一次。");
      confirmBox("删除渠道「" + p.name + "」", lines.join("<br>"), "删除", async () => {
        const body = readAll();
        body.providers = body.providers.filter((x) => x.id !== p.id);
        body.models = (d.s.models || []).filter((m) => m.channel !== p.id);
        body.media_models = (d.s.media_models || []).filter((m) => m.provider !== p.id);
        // 下拉框里选着的那条可能正好被删了。不改的话服务端会拒掉整次保存（active_model 不在列表里），
        // 一条都删不掉；一个模型都不剩时就干脆不带这个字段，让服务端保持原样
        if (!body.models.length) delete body.active_model;
        else if (!body.models.some((m) => m.name === body.active_model)) body.active_model = body.models[0].name;
        await post("/api/settings", body);
        toast("渠道已删除");
        route(true);
      }, true);
    }));

    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await post("/api/settings", readAll());
        toast("已保存，立刻生效");
        route(true);
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
      }
    };
  },
};

/* ============ 开放与集成 ============ */
/**
 * 这页只能是索引——渠道配的是整台服务器，入口在工作台，不在这儿。
 * 但「只是索引」不等于「只能是一张写着路怎么走的纸」：原来每行右边写的
 * 「工作台 → 设置 → 消息渠道」是**纯文字**，管理员看完得自己关掉后台、回工作台、
 * 在三层菜单里重新找一遍，中途忘了要点哪一项是常事。现在那一句是链接，
 * 点了直接把工作台开在那个面板上（工作台侧 `#go=` 深链负责落地）。
 */
PAGES.integration = {
  load: () => api("/api/admin/overview"),
  render: () => {
    // go 有值就是能跳的，没有就是还没做的功能——那种就别画成链接骗人点
    const row = (name, desc, where, go) =>
      field(
        name,
        desc,
        go
          ? `<a class="ad-go" href="/#go=${esc(go)}" target="_blank" rel="noopener">${esc(where)}${ic("arrow-up-right")}</a>`
          : `<span class="fd" style="text-align:right;max-width:200px">${esc(where)}</span>`
      );
    return `<div class="ad-wrap">
      ${note("下面这些渠道配的是<b>这台服务器</b>，不是单个组织——一个飞书机器人对应一个部署。所以入口在工作台的设置里，归平台管理员管，这页只做个索引。点右边的链接会在新标签页直接打开对应的面板。")}
      ${card(`${secT("机器人渠道", "接上之后，成员在聊天软件里 @ 一下就能发任务，产出直接回到会话里。")}
        <div style="margin-top:14px">
          ${row("飞书 / Lark", "支持扫码绑定，不用手填 App ID。", "去配消息渠道", "settings:im")}
          ${row("企业微信", "自建应用或群机器人 Webhook 二选一。", "去配消息渠道", "settings:im")}
          ${row("钉钉", "群机器人 Webhook。", "去配消息渠道", "settings:im")}
          ${row("QQ / 微信公众号", "需要对应平台的开发者资质。", "去配消息渠道", "settings:im")}
        </div>`)}
      ${card(`${secT("能力扩展")}
        <div style="margin-top:14px">
          ${row("MCP 服务器", "把外部系统的工具接进来给任务用。", "去接连接器", "hub:mcp")}
          ${row("技能", "把重复的活儿固化成可复用的流程。", "去看技能", "hub:skills")}
          ${row("专家", "给不同的活儿配不同的角色和工具。", "去看专家", "hub:experts")}
          ${row("定时任务", "让任务按点自己跑，产出推到聊天软件里。", "去排定时任务", "view:autom")}
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
/**
 * 十九个页面分六组，在 13 寸笔记本上一屏根本放不下——侧栏自己会滚，
 * 而「要滚」这件事只有那根细滚动条在提示。管理员找「每人每月发多少额度」在哪，
 * 得先猜它属于「订阅与用量」还是「企业设置」（答案是后者，叫「计量设置」），
 * 猜错就得上下翻两遍。所以加一个搜索框：打「额度」直接把相关的两页筛出来。
 *
 * 匹配面要宽——标题、那句副标题、分组名、路由 id 都算。用户记得住的往往不是
 * 我们起的页面名，而是他要干的那件事（「充值」「邀请码」「白名单」）。
 */
let navQ = "";
function navHit(it, grp, q) {
  return (it.title + " " + (it.sub || "") + " " + grp + " " + it.id).toLowerCase().includes(q);
}
function renderNav(current) {
  const q = navQ.trim().toLowerCase();
  let shown = 0;
  const html = NAV.map((g) => {
    const items = g.items.filter((it) => (!it.platform || PLATFORM) && (!it.owner || OWNER) && (!q || navHit(it, g.grp, q)));
    if (!items.length) return "";
    shown += items.length;
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
  $("ad-nav").innerHTML = shown
    ? html
    : `<div class="ad-nav-none">没有叫「${esc(navQ.trim())}」的页面。<br>试试「额度」「邀请」「白名单」这类词。</div>`;
  // 当前页在折叠的视野之外时把它滚进来——不然搜完一清空，人就不知道自己站在哪了
  const on = $("ad-nav").querySelector(".ad-nav-i.on");
  if (on && !q) on.scrollIntoView({ block: "nearest" });
}
/** 搜索框：输入即筛，回车进第一条，Esc 清空。挂一次，之后 renderNav 只管 innerHTML */
function bindNavSearch() {
  const box = $("ad-nav-q");
  if (!box) return;
  box.oninput = () => {
    navQ = box.value;
    renderNav(location.hash.replace(/^#\/?/, "").split("?")[0] || "home");
  };
  box.onkeydown = (e) => {
    if (e.key === "Escape") {
      box.value = "";
      box.oninput();
      box.blur();
    } else if (e.key === "Enter") {
      const first = $("ad-nav").querySelector(".ad-nav-i");
      if (first) {
        location.hash = first.getAttribute("href").slice(1);
        box.blur();
      }
    }
  };
  // 光标不在输入框里的时候，「/」直接跳到搜索——这是列表类界面的老习惯，不用教
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    e.preventDefault();
    box.focus();
    box.select();
  });
}
function navItem(id) {
  for (const g of NAV) for (const it of g.items) if (it.id === id) return it;
  return null;
}

let routeSeq = 0;
/**
 * 重渲染前记一下光标在哪。认的是 data-* 那个名字（data-q / data-mq / data-from…），
 * 不是 DOM 节点本身——节点马上就没了，名字才是同一个框在两次渲染之间唯一稳的东西。
 */
function focusSnap(body) {
  const el = document.activeElement;
  if (!el || !body.contains(el)) return null;
  if (!/^(INPUT|TEXTAREA)$/.test(el.tagName)) return null;
  const key = Object.keys(el.dataset || {})[0];
  if (!key) return null;
  return { sel: "[data-" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()) + "]",
           value: el.value, start: el.selectionStart, end: el.selectionEnd };
}
function focusRestore(body, keep) {
  if (!keep) return;
  // 这中间人要是去点了别处（比如左边导航），别把光标从他手里抢回来。
  // 整块换掉之后 activeElement 一定是 body，所以「还是 body」就等于「他没动过」
  if (document.activeElement && document.activeElement !== document.body) return;
  const el = body.querySelector(keep.sel);
  if (!el) return;
  el.focus();
  // 等数据的这几十毫秒里人可能又敲了几个字（敲进的是那个已经被摘下来的旧框）。
  // 以手上这份为准，别拿服务端回来的旧值把人刚打的字盖掉
  if (keep.value !== el.value) el.value = keep.value;
  try { el.setSelectionRange(keep.start, keep.end); } catch { /* number 之类的框不支持选区，无所谓 */ }
}

async function route(keepScroll) {
  const id = (location.hash.replace(/^#\/?/, "") || "home").split("?")[0];
  const it = navItem(id) && PAGES[id] ? navItem(id) : navItem("home");
  const pid = it.id;
  if ((it.platform && !PLATFORM) || (it.owner && !OWNER)) return (location.hash = "#/home");
  const seq = ++routeSeq;
  const body = $("ad-body");
  const scroll = keepScroll ? body.scrollTop : 0;

  // 重渲染是整块 innerHTML 换掉，正在打字的那个框会被连根扔掉——实测：在搜索框里
  // 打一个字，250ms 防抖一到、数据回来、页面重画，光标落回 body，接着敲的字全打进了空气里。
  // 于是「搜三个字」变成「打一个字、伸手去点框、再打一个字」。这里记下**现在**在哪个框里、
  // 光标在第几个字，画完再放回去
  const keep = focusSnap(body);

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
    focusRestore(body, keep);
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
    OWNER = !!d.platform_owner;
    MULTI = !!d.multi_tenant;
    RO = ME && ME.role === "auditor";
    document.title = `${d.org.name} · 企业管理后台`;
  } catch (e) {
    $("ad-body").innerHTML = gate(e);
    $("ad-sub").textContent = "进不来";
    return;
  }
  bindNavSearch();
  addEventListener("hashchange", () => route(false));
  await route(false);
}
boot();
