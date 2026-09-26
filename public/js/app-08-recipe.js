/* ============================================================================
 * app-08-recipe.js —— 内容配方的开头表单卡
 *   makeRecipeFormCard(ev, turnSid, submit, ctx)
 *     ask_user 事件带了 fields（配方表单）时，makeAskCard 转到这里画一张多项表单。
 *     跟普通提问卡同一个壳（.ask-card、data-ask-id、card._mark），ask_answer 定格走的是同一条路。
 *
 * 为什么单独一张卡、不拆成几道提问：宣传片要定时长、画幅、画面、声音、封面、平台，
 * 一道一道问，人答到第三道就走开了，任务卡在第四道上。一张表一次交，交完就不再打断。
 * 交回去的是一行 JSON（{form, values}），服务端 recipes.parseAnswer 按字段规格再收一遍，
 * 前端这里只管摆和收，不做「这台机器能不能用」的判断——那是服务端开表单时标好的 disabled。
 * ========================================================================== */

/** 表单卡上「都按默认」交回去的那句，跟命令行两个按钮里的第一个一字不差，服务端认的就是它 */
const RECIPE_GO_DEFAULT = "按默认开工";

function makeRecipeFormCard(ev, turnSid, submit, ctx) {
  const fields = (Array.isArray(ev.fields) ? ev.fields : []).filter((f) => f && f.name);
  const notes = (Array.isArray(ev.notes) ? ev.notes : []).map(String).filter(Boolean);
  const replaying = !!((ctx && ctx.replaying) || (typeof isReplaying !== "undefined" && isReplaying));
  const optsOf = (f) => (Array.isArray(f.options) ? f.options : []);
  const pick = (v) => (Array.isArray(v) ? v.map(String) : v == null ? "" : String(v));
  // 当前值和默认值各一份：默认值要留着给「都按默认」和超时后的摘要用
  const defaults = {};
  for (const f of fields) defaults[f.name] = f.type === "multi" ? [].concat(pick(f.default) || []).filter(Boolean) : pick(f.default);
  const vals = JSON.parse(JSON.stringify(defaults));

  const card = document.createElement("div");
  card.className = "ask-card ask-form";
  card.dataset.askId = ev.ask_id || "";
  if (ev.form) card.dataset.form = ev.form;
  const meta = (ev.estimate ? `<span class="rf-est">预估生成费：${esc(ev.estimate)}</span>` : "") +
    (ev.estimate && ev.limits_note ? `<span class="rf-dot">·</span>` : "") +
    (ev.limits_note ? `<span class="rf-lim">${esc(ev.limits_note)}</span>` : "");
  card.innerHTML =
    `<div class="ask-hd"><span class="ask-ic">${ic("clipboard-list")}</span><span class="ask-lb">${
      ev.expert ? `专家「${esc(ev.expert)}」开工前想定几件事` : "开工前定几件事"
    }</span><span class="ask-timer"></span></div>` +
    `<div class="ask-q">${esc(ev.title || ev.question || "")}</div>` +
    (ev.blurb ? `<div class="rf-blurb">${esc(ev.blurb)}</div>` : "") +
    (meta ? `<div class="rf-meta rf-top">${ic("hand-coins")}${meta}</div>` : "") +
    (notes.length ? `<ul class="rf-notes">${notes.map((n) => `<li>${ic("info")}<span>${esc(n)}</span></li>`).join("")}</ul>` : "") +
    `<div class="rf-fields"></div>` +
    `<div class="rf-acts"><button type="button" class="rf-go">${ic("circle-check")}<span>按这样开工</span></button>` +
    `<button type="button" class="rf-def">都按默认</button><span class="rf-err" role="status"></span></div>` +
    `<div class="ask-ans"></div>`;

  const box = card.querySelector(".rf-fields");
  const errEl = card.querySelector(".rf-err");
  const say = (t) => { errEl.textContent = t || ""; };

  // 一项一行：标签在左，选项在右。用不了的选项照样摆出来、标灰、写明去哪儿补——
  // 藏起来的话，用户永远不知道「AI 生成画面」是可以有的
  for (const f of fields) {
    const row = document.createElement("div");
    row.className = "rf-row";
    row.dataset.field = f.name;
    row.innerHTML = `<div class="rf-lb">${esc(f.label || f.name)}${f.required ? `<span class="rf-req">必填</span>` : ""}</div><div class="rf-ctl"></div>`;
    const ctl = row.querySelector(".rf-ctl");

    if (f.type === "text") {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "rf-text";
      inp.maxLength = Math.max(1, Math.min(500, Number(f.max) || 200));
      inp.placeholder = f.hint || "";
      inp.value = vals[f.name] || "";
      inp.oninput = () => { vals[f.name] = inp.value; say(""); };
      inp.onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); go(); } };
      ctl.appendChild(inp);
      // 品牌档案里的产品摆成一排，点一下填进去，不用再敲一遍
      const sug = (Array.isArray(f.suggest) ? f.suggest : []).map(String).filter(Boolean).slice(0, 8);
      if (sug.length) {
        const s = document.createElement("div");
        s.className = "rf-suggest";
        for (const name of sug) {
          const b = document.createElement("button");
          b.type = "button"; b.className = "rf-chip";
          b.textContent = name;
          b.onclick = () => { inp.value = name; vals[f.name] = name; say(""); };
          s.appendChild(b);
        }
        ctl.appendChild(s);
      }
    } else {
      const multi = f.type === "multi";
      const seg = document.createElement("div");
      seg.className = multi ? "rf-chips" : "rf-seg";
      const paint = () => {
        for (const b of seg.children) {
          const on = multi ? vals[f.name].includes(b.dataset.v) : vals[f.name] === b.dataset.v;
          b.classList.toggle("on", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        }
      };
      for (const o of optsOf(f)) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = multi ? "rf-chip" : "rf-opt";
        b.dataset.v = String(o.v);
        const sub = o.disabled ? o.reason : o.d;
        b.innerHTML = `<span class="lb">${esc(o.l || o.v)}</span>${sub && !multi ? `<span class="dt">${esc(sub)}</span>` : ""}`;
        if (o.disabled) {
          b.disabled = true;
          b.classList.add("off");
          if (o.reason) b.title = o.reason;
        }
        b.onclick = () => {
          if (b.disabled) return;
          const v = b.dataset.v;
          say("");
          // 默认是「这次不做」的单选（只剩花钱的那条）：点上了还能再点一下退回不做
          if (!multi) vals[f.name] = vals[f.name] === v && defaults[f.name] === "" ? "" : v;
          else if (vals[f.name].includes(v)) {
            // 至少留一个：一个画幅都不选，这一项就没法做了
            if (vals[f.name].length <= Math.max(1, Number(f.min) || 1)) { say(`${f.label || f.name}至少留一个`); return; }
            vals[f.name] = vals[f.name].filter((x) => x !== v);
          } else vals[f.name] = optsOf(f).map((x) => String(x.v)).filter((x) => x === v || vals[f.name].includes(x));
          paint();
        };
        seg.appendChild(b);
      }
      ctl.appendChild(seg);
      // 多选的标灰项没地方挂小字，原因单独写一行
      const offs = multi ? optsOf(f).filter((o) => o.disabled && o.reason) : [];
      if (offs.length) {
        const why = document.createElement("div");
        why.className = "rf-why";
        why.textContent = offs.map((o) => `${o.l}：${o.reason}`).join("；");
        ctl.appendChild(why);
      }
      paint();
    }
    box.appendChild(row);
  }

  const timerEl = card.querySelector(".ask-timer");
  let tick = null;
  const stopTick = () => { if (tick) { clearInterval(tick); tick = null; } timerEl.textContent = ""; };

  // 一项一行的摘要：服务端给了 summary 就用它（那是按字段规格收过一遍的），没给就按这张卡自己的值拼
  const labelOf = (f, v) => { const o = optsOf(f).find((x) => String(x.v) === String(v)); return o ? o.l : String(v); };
  // 一行拆成 [标签, 值] 两半、各占一个文字节点：「（没选）」「这次不做」「（没填）」跟标签挤在
  // 同一个节点里的话，英文界面按整句查词查不到，这三句就一直是中文
  // 第三格 typed：这个值是用户自己敲的字。它得挂 translate="no"——界面翻译按整个节点查词，
  // 有人在「主打卖点」里就填了「默认」两个字，英文界面会把它换成 Default。只有兜底那三句和选项名该翻
  const typed = (f, v) => !!f && f.type !== "multi" && f.type !== "select" && v !== "（没填）";
  const localSummary = (values) => fields.map((f) => {
    const v = values[f.name];
    if (f.type === "multi") return [f.label, Array.isArray(v) && v.length ? v.map((x) => labelOf(f, x)).join("、") : "（没选）"];
    if (f.type === "select") return [f.label, v ? labelOf(f, v) : "这次不做"];
    const t = String(v || "").trim() || "（没填）";
    return [f.label, t, typed(f, t)];
  });
  // 服务端的摘要是拼好的「标签：值」（recipes.summary），照同一个冒号拆回两半；按标签认回是哪一项，才知道值是不是敲的
  const byLabel = new Map(fields.map((f) => [String(f.label), f]));
  const splitLine = (l) => {
    const s = String(l), i = s.indexOf("：");
    if (i <= 0) return [s];
    const k = s.slice(0, i), v = s.slice(i + 1);
    return [k, v, typed(byLabel.get(k), v)];
  };
  const lineHtml = ([k, v, own]) => (v === undefined ? `<div>${esc(k)}</div>` : `<div><span class="rf-k">${esc(k)}</span>：<span class="rf-v"${own ? ' translate="no"' : ""}>${esc(v)}</span></div>`);
  const valuesOf = (answer) => {
    const s = String(answer == null ? "" : answer).trim();
    if (s.startsWith("{")) {
      try {
        const o = JSON.parse(s);
        const given = o && typeof o.values === "object" ? o.values : o;
        return { ...defaults, ...(given || {}) };
      } catch { /* 不是 JSON 就是一句补充，按默认摆 */ }
    }
    return { ...defaults };
  };

  const hide = (sel) => { const el = card.querySelector(sel); if (el) el.hidden = true; };
  const markAnswered = (answer, timeout, summary, estimate) => {
    // 交表的回执多半比服务端的 ask_answer 先到：先按本卡的值定格，带着摘要和重算预估的那次再画一遍，
    // 不然顶上那份按默认值算的预估一直挂着，跟交上去的选择对不上
    const richer = (Array.isArray(summary) && summary.length > 0) || !!estimate;
    if (card._answered && !richer) return;
    card._answered = true;
    card.classList.add("done");
    stopTick();
    // 表单收起来只留结论。直接设 hidden，不指望样式表：样式晚到一步，也不能留一张还能点的表
    for (const sel of [".rf-fields", ".rf-acts", ".rf-notes", ".rf-blurb"]) hide(sel);
    const s = String(answer == null ? "" : answer).trim();
    const free = !timeout && s && !s.startsWith("{") && s !== RECIPE_GO_DEFAULT;
    card.querySelector(".ask-lb").textContent = timeout ? "没人填，按默认开工" : "开工前的几件事定好了";
    const lines = Array.isArray(summary) && summary.length ? summary.map(splitLine) : localSummary(valuesOf(answer));
    const est = estimate ? `<div class="rf-meta">${ic("hand-coins")}<span>预估生成费：${esc(estimate)}</span></div>` : "";
    card.querySelector(".ask-ans").innerHTML =
      `<span class="ic">${ic(timeout ? "clock" : "circle-check")}</span>` +
      `<div class="rf-sum">${free ? `<div>你补充了：<b translate="no">${esc(s.slice(0, 200))}</b></div>` : ""}` +
      `${lines.map(lineHtml).join("")}${est}</div>`;
    // 按交上去的值重算过的预估写在摘要里了；顶上那份是按默认值算的，留着会跟它打架
    if (estimate) for (const sel of [".rf-top .rf-est", ".rf-top .rf-dot"]) hide(sel);
  };
  card._mark = markAnswered;

  const send = async (answer) => {
    if (card.classList.contains("done") || card.classList.contains("sending")) return;
    card.classList.add("sending"); // 送出到收到回执之间再点一次不许重复发
    const resp = await (submit ? submit(answer) : fetch("/api/chat/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: turnSid, askId: ev.ask_id, answer }),
    })).catch(() => null);
    card.classList.remove("sending");
    if (resp && resp.ok) markAnswered(answer, false);
    else {
      const j = resp && resp.json ? await resp.json().catch(() => null) : null;
      // 只说查得到的：服务端说了原因（任务结束了、题过期了）就照它说，没说就不替人猜
      const why = (j && j.error) || (!resp ? "没送出去：连不上服务器，再点一次" : `没送出去${resp.status ? `（HTTP ${resp.status}）` : ""}，再点一次`);
      if (typeof toast === "function") toast(why);
      else say(why);
    }
  };
  const go = () => {
    const values = {};
    for (const f of fields) values[f.name] = f.type === "text" ? String(vals[f.name] || "").trim() : vals[f.name];
    send(JSON.stringify({ form: ev.form || "", values }));
  };
  card.querySelector(".rf-go").onclick = go;
  card.querySelector(".rf-def").onclick = () => send(RECIPE_GO_DEFAULT);

  if (replaying) {
    // 历史回放里表单早就过期了：不倒计时、不让点；后面跟着的 ask_answer 照样会把结论画上来
    card.classList.add("done");
    for (const sel of [".rf-fields", ".rf-acts"]) hide(sel);
    card.querySelector(".ask-ans").innerHTML = `<span class="ic">·</span>这是历史记录里的表单`;
  } else if (Number(ev.timeout_ms) > 0) {
    const dead = Date.now() + Number(ev.timeout_ms);
    const paint = () => {
      const left = Math.max(0, Math.round((dead - Date.now()) / 1000));
      if (!left) { stopTick(); timerEl.textContent = "已超时"; timerEl.classList.add("hot"); return; }
      timerEl.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} 后按默认开工`;
      timerEl.classList.toggle("hot", left <= 30);
    };
    paint();
    tick = setInterval(paint, 1000);
  }
  return card;
}
