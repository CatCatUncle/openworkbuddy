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
      granted: '<span style="color:var(--wb-ok)">✅ 已授权</span>',
      denied: '<span style="color:var(--wb-err)">未授权</span>',
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
