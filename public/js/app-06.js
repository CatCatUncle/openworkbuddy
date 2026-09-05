function renderSecurityPane(pane, s) {
  const sec = s.security || {};
  const joinLines = (a) => esc((a || []).join("\n"));
  const chk = (id, on, label, desc) => `
    <label style="display:flex;align-items:flex-start;gap:8px;margin:7px 0;cursor:pointer;font-size: 14px">
      <input type="checkbox" id="${id}" ${on ? "checked" : ""} style="width:auto;margin:3px 0 0">
      <span><b>${label}</b><span style="color:var(--wb-text-3)"> — ${desc}</span></span>
    </label>`;
  const listCol = (title, id, val, rows) => `
    <div style="flex:1;min-width:0"><div style="font-size: 13px;color:var(--wb-text-2);margin:6px 0 4px">${title}</div>
    <textarea id="${id}" rows="${rows || 4}" style="width:100%;font-size: 13px;font-family:Consolas,monospace;resize:vertical">${val}</textarea></div>`;
  pane.innerHTML = `
    <div class="card-item">
      <div class="t">🎚️ 权限档位</div>
      <div class="d">决定 AI 动手前问不问你。改文件、跑命令都按这个档来；文件黑名单在任何档位下都拦得住。输入框下方的「🛡️」下拉也能随时切。</div>
      <div id="sec-modes" style="display:flex;flex-direction:column;gap:6px;margin-top:8px"></div>
      <div style="margin-top:8px;font-size: 13px;color:var(--wb-text-3)">
        本次运行期间记住的批准：<span id="sec-sess-allow">（无）</span>
        <a href="#" class="link" id="sec-sess-clear">清掉</a>
      </div>
    </div>
    <div class="card-item">
      <div class="t">🛡️ 数据安全</div>
      ${chk("sec-gateway", sec.gateway !== false, "安全网关", "总开关：命令审批与文件/网络黑白名单的硬拦截由它启用，关闭后只记审计不拦截")}
      ${chk("sec-delprot", sec.delete_protect !== false, "删除保护", "rm 类删除命令必须在界面上批准后才执行")}
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size: 14px;margin:7px 0">
        批量删除审批阈值 <input id="sec-batch" type="number" min="1" style="width:70px;margin:0" value="${esc(String(sec.batch_delete_threshold ?? 50))}"> 个文件 ·
        审批等待上限 <input id="sec-aptimeout" type="number" min="10" style="width:70px;margin:0" value="${esc(String(sec.approval_timeout_s ?? 120))}"> 秒（超时按拒绝）
      </div>
      <div style="font-size: 13px;color:var(--wb-text-3)">传输加密：前后端走本机回环地址通信不经公网；对外仅按你配置的通道（飞书/企微/钉钉官方 HTTPS API）传输。</div>
    </div>
    <div class="card-item">
      <div class="t">📁 沙箱安全 · 文件</div>
      <div class="d">工作目录内默认可读写；黑名单永远拦截；工作目录之外只有白名单目录可访问。每行一条，支持 ~ 与 &lt;app&gt;（应用目录）。</div>
      <div style="display:flex;gap:10px">
        ${listCol("白名单（workspace 外可访问）", "sec-fwl", joinLines(sec.file_whitelist))}
        ${listCol("黑名单（永远拦截）", "sec-fbl", joinLines(sec.file_blacklist))}
      </div>
    </div>
    <div class="card-item">
      <div class="t">⌨️ 沙箱安全 · 命令</div>
      <div class="d">run_shell 的命令按前缀逐段核对：放行名单直接执行；询问名单挂起，输入框上方弹出审批条等你批准。每行一个命令前缀。</div>
      <div style="display:flex;gap:10px">
        ${listCol("放行名单（直接执行）", "sec-cal", joinLines(sec.cmd_allow))}
        ${listCol("询问名单（需批准）", "sec-cak", joinLines(sec.cmd_ask))}
      </div>
    </div>
    <div class="card-item">
      <div class="t">🌐 沙箱安全 · 网络</div>
      <div class="d">fetch_url 抓取的域名规则（自动含子域名）。黑名单拦截；白名单非空时只允许名单内域名。每行一个域名。</div>
      <div style="display:flex;gap:10px">
        ${listCol("白名单（非空=只允许这些）", "sec-uwl", joinLines(sec.url_whitelist), 3)}
        ${listCol("黑名单（拦截）", "sec-ubl", joinLines(sec.url_blacklist), 3)}
      </div>
    </div>
    <div class="card-item">
      <div class="t">⚙️ 内置运行时</div>
      ${chk("sec-node", sec.runtime_node !== false, "Node.js（run_node）", "关闭后 AI 不能执行 Node 代码")}
      ${chk("sec-py", sec.runtime_python !== false, "Python（run_shell 里的 python/pip）", "关闭后 python/pip 命令直接拒绝")}
    </div>
    <div class="card-item">
      <div class="t">🖥️ 系统授权（macOS）</div>
      <div id="sec-sys" style="font-size: 14px;color:var(--wb-text-3)">检测中…</div>
    </div>
    <div class="card-item">
      <div class="t">📋 审计中心 <span style="float:right;font-weight:400;font-size: 13px"><a href="#" class="link" id="audit-all">查看全部</a> · <a class="link" href="/api/security/audit/export" download>导出日志</a> · <a href="#" class="link danger" id="audit-clear">清空记录</a></span></div>
      <div id="audit-list" style="max-height:260px;overflow:auto;font-size: 13px;margin-top:6px"></div>
    </div>
    <button class="btn-brand" id="sec-save">保存</button><span class="ok-msg" id="sec-msg"></span>`;

  const linesOf = (sel) => pane.querySelector(sel).value.split(/\n/).map(x => x.trim()).filter(Boolean);
  pane.querySelector("#sec-save").onclick = () => saveSettings({
    security: {
      gateway: pane.querySelector("#sec-gateway").checked,
      delete_protect: pane.querySelector("#sec-delprot").checked,
      batch_delete_threshold: +pane.querySelector("#sec-batch").value || 50,
      approval_timeout_s: +pane.querySelector("#sec-aptimeout").value || 120,
      file_whitelist: linesOf("#sec-fwl"),
      file_blacklist: linesOf("#sec-fbl"),
      cmd_allow: linesOf("#sec-cal"),
      cmd_ask: linesOf("#sec-cak"),
      url_whitelist: linesOf("#sec-uwl"),
      url_blacklist: linesOf("#sec-ubl"),
      runtime_node: pane.querySelector("#sec-node").checked,
      runtime_python: pane.querySelector("#sec-py").checked,
    },
  }, pane.querySelector("#sec-msg"));

  // ---- 权限档位 ----
  async function renderModes() {
    const d = await fetch("/api/security/modes").then(r => r.json()).catch(() => null);
    const box = pane.querySelector("#sec-modes");
    if (!d || !box) return;
    box.innerHTML = Object.entries(d.modes).map(([k, m]) => `
      <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size: 14px">
        <input type="radio" name="permmode" value="${esc(k)}" ${k === d.current ? "checked" : ""} style="width:auto;margin:3px 0 0">
        <span><b>${esc(m.label)}</b><span style="color:var(--wb-text-3)"> — ${esc(m.desc)}</span></span>
      </label>`).join("");
    box.querySelectorAll("input[name=permmode]").forEach(r => r.onchange = async () => {
      await setPermMode(r.value);
      renderSessAllow();
    });
  }
  async function renderSessAllow() {
    const d = await fetch("/api/security/approvals").then(r => r.json()).catch(() => null);
    const el = pane.querySelector("#sec-sess-allow");
    if (!el) return;
    const list = (d && d.session_allow) || [];
    el.textContent = list.length ? list.join("、") : "（无）";
  }
  renderModes();
  renderSessAllow();
  pane.querySelector("#sec-sess-clear").onclick = async (e) => {
    e.preventDefault();
    await fetch("/api/security/session-allow/clear", { method: "POST" });
    renderSessAllow();
    toast("已清掉本次运行期间记住的批准");
  };

  // ---- 审计 ----
  let auditLimit = 15;
  async function renderAudit() {
    const list = await fetch("/api/security/audit?limit=" + auditLimit).then(r => r.json()).catch(() => []);
    const box = pane.querySelector("#audit-list");
    if (!box) return;
    box.innerHTML = (Array.isArray(list) && list.length)
      ? list.map(e => `<div style="padding:4px 0;border-bottom:1px solid var(--wb-border)"><span style="color:var(--wb-text-3)">${esc(String(e.ts || "").replace("T", " ").slice(5, 19))}</span> <b>[${esc(e.type)}]</b> ${esc(e.text)} <span style="color:${/拦截|拒绝/.test(e.action) ? "var(--wb-err)" : "var(--wb-ok)"}">${esc(e.action)}</span></div>`).join("")
      : '<div style="color:var(--wb-text-3);padding:6px 0">还没有记录。AI 执行命令 / 联网访问时会自动记录在这里。</div>';
  }
  renderAudit();
  pane.querySelector("#audit-all").onclick = (e) => { e.preventDefault(); auditLimit = 1000; renderAudit(); };
  pane.querySelector("#audit-clear").onclick = async (e) => {
    e.preventDefault();
    if (!confirm("清空全部审计记录？")) return;
    await fetch("/api/security/audit/clear", { method: "POST" });
    renderAudit();
  };

  // ---- 系统授权 ----
  let autoState = null; // 自动化探测会触发系统弹窗，只在用户点「检测/授权」时查
  async function renderSys() {
    const el = pane.querySelector("#sec-sys");
    if (!el) return;
    const d = await fetch("/api/security/system").then(r => r.json()).catch(() => null);
    if (!d) { el.textContent = "读取失败"; return; }
    const txt = {
      granted: '<span style="color:var(--wb-ok-text)">✅ 已授权</span>',
      denied: '<span style="color:var(--wb-err-text)">未授权</span>',
      unknown: '<span style="color:var(--wb-text-3)">无法检测</span>',
      unchecked: '<span style="color:var(--wb-text-3)">未检测</span>',
    };
    const row = (name, key, st, extra) =>
      `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--wb-border)"><span style="flex:1;color:var(--wb-text)"><b>${name}</b></span>${txt[st] || esc(String(st))}${extra || ""}<a href="#" class="link" data-pane="${key}">去授权</a></div>`;
    el.innerHTML =
      row("完全磁盘访问权限", "fulldisk", d.fulldisk) +
      row("辅助功能", "accessibility", d.accessibility) +
      row("自动化（Apple Events）", "automation", autoState || d.automation, ' <a href="#" class="link" id="sec-autochk">检测/授权</a>') +
      (d.desktop ? "" : '<div style="font-size: 13px;color:var(--wb-text-3);margin-top:6px">当前是 Web 模式：授权对象是启动本服务的终端；「辅助功能」状态仅桌面版（npm run app）能查询。</div>');
    el.querySelectorAll("[data-pane]").forEach(a => a.onclick = (ev) => {
      ev.preventDefault();
      fetch("/api/security/system/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pane: a.dataset.pane }) });
    });
    const ac = el.querySelector("#sec-autochk");
    if (ac) ac.onclick = async (ev) => {
      ev.preventDefault();
      ac.textContent = "检测中…（可能弹出系统授权框）";
      const r = await fetch("/api/security/system/check-automation", { method: "POST" }).then(x => x.json()).catch(() => ({}));
      autoState = r.automation || "unknown";
      renderSys();
    };
  }
  renderSys();
}

// ================= 快捷键面板 =================
function renderShortcutsPane(pane, s) {
  const cur = { ...(s.shortcuts || {}) };
  pane.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <input id="sc-search" placeholder="搜索快捷键" style="flex:1;margin:0">
      <button class="btn-brand" id="sc-reset" style="white-space:nowrap">全部恢复默认</button>
    </div>
    <div class="d" style="margin-bottom:4px">共 ${SHORTCUT_DEFS.length} 条 · 点击右侧按键，然后直接按下新组合键即可改绑（Esc 取消）。「唤起/隐藏主窗口」是系统级快捷键，仅桌面版生效。</div>
    <div id="sc-list"></div><span class="ok-msg" id="sc-msg" style="display:block;margin-top:8px"></span>`;
  const draw = (filter) => {
    pane.querySelector("#sc-list").innerHTML = SHORTCUT_DEFS
      .filter(([id, label]) => !filter || label.includes(filter) || id.includes(filter.toLowerCase()))
      .map(([id, label, def, fixed, isGlobal]) => {
        const acc = cur[id] || def;
        const changed = cur[id] && canonAccel(cur[id]) !== canonAccel(def);
        return `<div style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--wb-border);font-size: 14px">
          <span style="flex:1">${esc(label)}${isGlobal ? ' <span style="font-size: 12px;color:var(--wb-text-3)">系统级</span>' : ""}${changed ? ` <a href="#" class="link" style="font-size: 12px" data-restore="${id}">恢复默认</a>` : ""}</span>
          ${fixed
            ? `<span style="color:var(--wb-text-3);font-size: 12px">固定</span><kbd class="sc-kbd">${esc(accelDisplay(acc))}</kbd>`
            : `<kbd class="sc-kbd sc-edit" data-id="${id}" title="点击后按下新组合键">${esc(accelDisplay(acc))}</kbd>`}
        </div>`;
      }).join("") || '<div style="color:var(--wb-text-3);padding:10px 4px;font-size: 14px">没有匹配的快捷键</div>';
    bindRows();
  };
  const save = () => saveSettings({ shortcuts: cur }, pane.querySelector("#sc-msg"))
    .then(() => draw(pane.querySelector("#sc-search").value.trim()));
  function bindRows() {
    pane.querySelectorAll("[data-restore]").forEach(a => a.onclick = (e) => { e.preventDefault(); delete cur[a.dataset.restore]; save(); });
    pane.querySelectorAll(".sc-edit").forEach(k => k.onclick = () => {
      if (window.__scRebinding) return;
      window.__scRebinding = true;
      k.textContent = "按下新组合键…";
      k.classList.add("armed");
      const cleanup = () => { document.removeEventListener("keydown", onKey, true); window.__scRebinding = false; };
      const onKey = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) { cleanup(); draw(pane.querySelector("#sc-search").value.trim()); return; }
        const acc = accelFromEvent(e);
        if (!acc) return; // 只按了修饰键，继续等主键
        const canon = canonAccel(acc);
        const clash = SHORTCUT_DEFS.find(([id2, , def2]) => id2 !== k.dataset.id && canonAccel(cur[id2] || def2) === canon);
        if (clash) { k.textContent = `与「${clash[1]}」冲突，换一个`; return; }
        cur[k.dataset.id] = canon;
        cleanup();
        save();
      };
      document.addEventListener("keydown", onKey, true);
    });
  }
  pane.querySelector("#sc-search").oninput = (e) => draw(e.target.value.trim());
  pane.querySelector("#sc-reset").onclick = () => {
    if (!confirm("全部恢复默认快捷键？")) return;
    for (const key of Object.keys(cur)) delete cur[key];
    save();
  };
  draw("");
}

// ================= 自进化：信号 → 提案 → 人审 → 复盘打分 =================
// 这一屏是整条链上唯一有人的一环。提案永远不会自己生效——闸门只负责毙掉明显不该上的，
// 剩下的必须有人点「采纳」。所以这里要把证据摆够：治什么、凭几次、原话长啥样、生效后哪个数该降。
const EV_ACT = { prompt: ["提示词能治", "var(--wb-ok)"], config: ["得改配置/换渠道", "var(--wb-warn)"], code: ["得改代码", "var(--wb-err)"] };

async function renderEvolvePane(pane) {
  pane.innerHTML = '<div class="card-item"><div class="d">读取中…</div></div>';
  const [st, sg] = await Promise.all([
    fetch("/api/evolve/state").then(r => r.json()).catch(() => ({})),
    fetch("/api/evolve/signals").then(r => r.json()).catch(() => ({})),
  ]);
  const caps = st.caps || { rules: 12, window: 14, minEvidence: 3 };
  const rules = st.rules || [];
  const scored = st.scored || [];
  const pending = (st.proposals || []).filter(p => p.status === "pending");
  const decided = (st.proposals || []).filter(p => p.status !== "pending").slice(0, 8);
  const runs = st.runs || [];
  const auto = st.auto || {};
  const signals = sg.signals || [];

  const actTag = (a) => { const [txt, color] = EV_ACT[a] || ["说不好", "var(--wb-text-3)"]; return `<span style="color:${color};font-size: 13px">${txt}</span>`; };
  const sigRows = signals.length ? signals.slice(0, 12).map(s => `
    <div style="display:flex;align-items:baseline;gap:8px;padding:5px 0;border-bottom:1px solid var(--wb-border);font-size: 13px">
      <span style="flex:1;min-width:0;color:var(--wb-text)">${esc(s.label)}</span>
      <span style="color:var(--wb-text-2)">${s.count} 次 · 每回合 ${s.rate}</span>
      ${actTag(s.actionable)}
    </div>`).join("")
    : '<div style="color:var(--wb-text-3);font-size: 14px">这段时间没数出毛病来——要么真没出错，要么样本太少。</div>';

  const propCards = pending.length ? pending.map(p => `
    <div class="card-item" data-prop="${esc(p.id)}" style="border-left:3px solid var(--wb-brand)">
      <div class="t">${p.kind === "retire_rule" ? "下架" : "新增"}：${esc(p.title || p.rule || "")}</div>
      <div class="d">${esc(p.why || "")}</div>
      ${p.rule ? `<div style="margin-top:8px;padding:8px 10px;background:var(--wb-code-bg);color:var(--wb-code-text);border-radius:8px;font-size: 13px;white-space:pre-wrap">${esc(p.rule)}</div>` : ""}
      ${p.verify ? `<div style="margin-top:6px;font-size: 13px;color:var(--wb-text-2)">✅ 验收：${esc(p.verify)}</div>` : ""}
      ${p.signalSnapshot ? `<div style="margin-top:4px;font-size: 13px;color:var(--wb-text-3)">证据：${esc(p.signalSnapshot.label)} · ${p.signalSnapshot.count} 次 · 每回合 ${p.signalSnapshot.rate}</div>` : ""}
      ${(p.evidence || []).length ? `<details style="margin-top:4px"><summary style="cursor:pointer;font-size: 13px;color:var(--wb-text-3)">看现场原话（${p.evidence.length} 条）</summary>
        ${p.evidence.map(e => `<div style="font-size: 13px;color:var(--wb-text-2);margin:5px 0 0;padding-left:8px;border-left:2px solid var(--wb-border)"><b>${esc(e.task || "")}</b><br>${esc(e.excerpt || "")}</div>`).join("")}</details>` : ""}
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn-brand" data-act="accept" style="height:30px;padding:0 14px;font-size: 13px">采纳，写进提示词</button>
        <input data-reason placeholder="驳回理由（会喂回给模型当负样本）" style="flex:1;min-width:160px;height:30px;font-size: 13px;margin:0">
        <button class="btn-plain" data-act="reject" style="height:30px;padding:0 12px;font-size: 13px">驳回</button>
      </div>
    </div>`).join("")
    : '<div class="card-item"><div class="d">没有待审的提案。点上面「跑一轮复盘」让它看看最近摔在哪儿。</div></div>';

  const scoreOf = (id) => scored.find(x => x.id === id);
  const ruleRows = rules.length ? rules.map(r => {
    const sc = scoreOf(r.id);
    const color = sc && sc.verdict === "有效" ? "var(--wb-ok)" : sc && sc.verdict === "没起作用" ? "var(--wb-err)" : "var(--wb-text-3)";
    return `<div style="padding:8px 0;border-bottom:1px solid var(--wb-border)">
      <div style="font-size: 14px;color:var(--wb-text);white-space:pre-wrap">${esc(r.text)}</div>
      <div style="margin-top:4px;font-size: 13px;color:var(--wb-text-3)">
        ${esc((r.meta.at || "").slice(0, 10))} 起 · <span style="color:${color}">${esc(sc ? sc.verdict : "还没打分")}</span>${sc && sc.why ? " · " + esc(sc.why) : ""}
        · <a href="#" class="link danger" data-retire="${esc(r.id)}">下架</a>
      </div></div>`;
  }).join("") : '<div style="color:var(--wb-text-3);font-size: 14px">还没有生效的规则。规则来自被你采纳的提案，不会自己长出来。</div>';

  pane.innerHTML = `
    <div class="card-item">
      <div class="t">🔁 它自己怎么变好的</div>
      <div class="d">你在每条回复下点的 👍👎 会落盘；加上任务里真实的失败（工具报错、超时、被打断返工）一起数成「信号」。
      复盘时模型只看这些数字提**最小**改动，能不能上由你点头——<b>提案永远不会自动生效</b>。
      规则最多 ${caps.rules} 条、每条 ≤ ${caps.ruleChars || 400} 字，满了必须换下一条才能加，避免措辞越堆越厚而数字不动。
      一条规则至少要有 ${caps.minEvidence} 次证据才准提。</div>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn-brand" id="ev-run" style="height:30px;padding:0 14px;font-size: 13px">跑一轮复盘</button>
        <span style="font-size: 13px;color:var(--wb-text-3)">统计最近 <input id="ev-days" type="number" min="1" max="365" value="${caps.window}" style="width:56px;height:26px;margin:0;font-size: 13px"> 天 · 会调一次模型，花钱</span>
        <span class="ok-msg" id="ev-msg"></span>
      </div>
      <div style="margin-top:6px;font-size: 13px;color:var(--wb-text-3)">规则预算：已用 ${rules.length}/${caps.rules} 条</div>
      <label style="display:flex;align-items:center;gap:6px;font-size: 13px;color:var(--wb-text-2);margin-top:10px;cursor:pointer">
        <input type="checkbox" id="ev-auto" style="width:auto;margin:0" ${auto.auto ? "checked" : ""}>
        每天 <input id="ev-hour" type="number" min="0" max="23" value="${auto.hour === undefined ? 3 : auto.hour}" style="width:48px;height:24px;margin:0;font-size: 13px"> 点自动跑一轮
        <span style="color:var(--wb-text-3)">（默认关，因为每次都要调一次模型花钱；跑出来的提案仍然要你点头才生效）</span>
      </label>
      ${runs.length ? `<div style="margin-top:6px;font-size: 13px;color:var(--wb-text-3)">上次：${esc((runs[0].at || "").slice(0, 16).replace("T", " "))} · ${esc(runs[0].trigger || "")} · ${runs[0].ok ? `${runs[0].turns} 个回合，新提案 ${runs[0].added} 条` : `<span style="color:var(--wb-err-text)">没跑成：${esc(runs[0].error || "")}</span>`}</div>` : ""}
    </div>
    <div class="card-item">
      <div class="t">📊 最近 ${sg.days || caps.window} 天的信号（${sg.turns || 0} 个助手回合）</div>
      <div class="d" style="margin-bottom:6px">按次数排。只有标「提示词能治」的才允许变成规则——改代码/换渠道的毛病，加多少句提示词都没用。</div>
      ${sigRows}
    </div>
    <div class="t" style="margin:16px 0 8px;font-weight:600">📥 待你裁决（${pending.length}）</div>
    ${propCards}
    <div class="card-item">
      <div class="t">📌 已生效的规则（${rules.length}/${caps.rules}）</div>
      <div class="d" style="margin-bottom:4px">这些原样拼进每次任务的系统提示词，排在记忆前面。打分看的是「基线出现率 → 现在的出现率」，没降就该下架。</div>
      ${ruleRows}
    </div>
    ${decided.length ? `<div class="card-item"><div class="t">🗂️ 审过的（近 ${decided.length} 条）</div>${decided.map(p => `<div style="padding:4px 0;font-size: 13px;color:var(--wb-text-2);border-bottom:1px solid var(--wb-border)"><b>${p.status === "applied" ? "已采纳" : p.status === "rejected" ? "已驳回" : "被闸门拦下"}</b> · ${esc(p.title || p.rule || "")}${p.reason ? " · " + esc(p.reason) : ""}${p.gate ? " · " + esc(p.gate) : ""}</div>`).join("")}</div>` : ""}`;

  const msg = pane.querySelector("#ev-msg");
  const saveAuto = () => saveSettings({ evolve: { auto: pane.querySelector("#ev-auto").checked, hour: +pane.querySelector("#ev-hour").value || 0 } }, msg);
  pane.querySelector("#ev-auto").onchange = saveAuto;
  pane.querySelector("#ev-hour").onchange = saveAuto;
  pane.querySelector("#ev-run").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; msg.textContent = "在数信号、让模型提改动…（可能要几十秒）";
    const r = await fetch("/api/evolve/review", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: +pane.querySelector("#ev-days").value || undefined }),
    }).then(r => r.json()).catch(() => ({ error: "网络错误" }));
    btn.disabled = false;
    if (r.error) { msg.textContent = "没跑成：" + r.error; return; }
    toast(`复盘完了：${r.turns} 个回合，新提案 ${(r.added || []).length} 条${(r.gated || []).length ? `，被闸门拦下 ${(r.gated || []).length} 条` : ""}`);
    (r.notes || []).forEach(n => console.log("[自进化]", n));
    renderEvolvePane(pane);
  };
  pane.querySelectorAll("[data-prop]").forEach(card => {
    const id = card.dataset.prop;
    const decide = async (decision) => {
      const r = await fetch("/api/evolve/proposal/" + encodeURIComponent(id), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reason: (card.querySelector("[data-reason]").value || "").trim() }),
      }).then(r => r.json()).catch(() => ({ error: "网络错误" }));
      toast(r.error ? "没成：" + r.error : decision === "accept" ? "已采纳，下次任务就带上了" : "已驳回，下轮不会再提");
      renderEvolvePane(pane);
    };
    card.querySelector("[data-act=accept]").onclick = () => decide("accept");
    card.querySelector("[data-act=reject]").onclick = () => decide("reject");
  });
  pane.querySelectorAll("[data-retire]").forEach(a => a.onclick = async (e) => {
    e.preventDefault();
    const r = await fetch("/api/evolve/rule/" + encodeURIComponent(a.dataset.retire) + "/retire", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ why: "在设置里人工下架" }),
    }).then(r => r.json()).catch(() => ({ error: "网络错误" }));
    toast(r.error ? "没成：" + r.error : "已下架，提示词里不再带它");
    renderEvolvePane(pane);
  });
}

function renderAboutPane(pane) {
  pane.innerHTML = `
    <div class="card-item">
      <div class="t">OpenWorkBuddy</div>
      <div class="d">开源复刻的 AI Agent 办公工作台。功能：Agent 自主执行 · Ask/Plan/Craft 模式 · 技能系统 · MCP 连接器 · 专家团多智能体 · 定时自动化 · 飞书/企业微信/Webhook 远程指挥 · 多模型可插拔 · 会话持久化与回放 · 文件上传 · 工作空间切换。</div>
    </div>
    <div class="card-item">
      <div class="t">运行方式</div>
      <div class="d">桌面版：npm run app（或桌面快捷方式）· Web 版：npm start 后浏览器打开 localhost:3800 · 测试：npm test</div>
    </div>
    <div class="card-item">
      <div class="t">💬 帮助与反馈</div>
      <div class="d">快速上手：输入框里 <b>@</b> 引用工作空间文件、<b>/</b> 调用技能；侧栏「技能库 / 专家团 / 定时任务」都支持增删改热生效；手机远程用 设置→助理设置 绑定飞书或企业微信。<br>
      遇到问题：先看 设置→安全中心→审计中心 是不是被安全闸拦了；LLM 报 503 是上游服务繁忙（已内置自动重试，连续失败可到 设置→模型 换渠道）。<br>
      反馈：本地部署版没有云端客服，问题与建议直接发给维护它的 AI 助理（就是让我改），改完重启即生效。</div>
    </div>`;
}
