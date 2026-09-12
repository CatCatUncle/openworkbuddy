"use strict";
/**
 * 执行追踪：把每一趟任务的全过程发到 Langfuse，好在浏览器里一层层展开看。
 *
 * 起因是一句很朴素的要求：「我要能看到每次执行的具体 trace」。界面上的过程区是给人看的，
 * 一行一句话；但真要排查「第 7 步为什么换了个参数又调一遍」「哪一次调用把 token 烧掉一半」，
 * 得看结构化的东西——哪次模型调用、喂进去的完整提示词是什么、吐出来什么、花了多少、
 * 底下挂着哪几个工具、哪个工具报了错。Langfuse 就是干这个的，自己能搭，也有托管版。
 *
 * 为什么不直接装 langfuse 那个 npm 包：本项目是**没有构建步骤**的纯 CommonJS，
 * 而且要打进 Electron 包里发给普通用户。为了一个默认关着的功能多拖一串依赖不划算——
 * 它的上报接口就是一个 POST，自己写反而更好控（超时、截断、出错怎么办全在自己手里）。
 *
 * 三条红线，写在最前面，因为这个模块最容易违反的就是这三条：
 *
 *   1. **追踪绝不能把任务搞挂。** 所有对外调用都在 try 里，网络错误只记账不上抛；
 *      关掉追踪时 trace() 返回一个什么都不做的空对象，而不是 null——调用方
 *      不用在每一处写 `tr && tr.span(...)`，漏一处就是别人正跑着的任务当场崩。
 *   2. **绝不在热路径上等网络。** 事件先进队列，攒够一批或者过两秒再发。
 *      任务的快慢跟 Langfuse 通不通没有半点关系。
 *   3. **绝不悄悄吞错。** 发失败了要留痕（计数 + 最后一条错误原因），设置页看得见。
 *      「一个 trace 都没有」和「发了但被对方拒了」是两件事，不能长一个样。
 *
 * 还有一条是关于隐私的，写进界面文案里而不只是写在这儿：打开之后，提示词原文、模型回复、
 * 工具参数都会发到用户填的那台 Langfuse 上。自己搭的就在自己机器里，用托管版就是发给别人。
 * 所以默认关着，得用户自己点开。
 */

const crypto = require("crypto");

// ── Langfuse 的上报接口（这一段是唯一跟 Langfuse 绑死的地方，将来换别的后端只用改这里）──
// POST {host}/api/public/ingestion，Basic 认证（公钥:私钥），body 是 { batch: [事件…] }。
// 事件形如 { id, type, timestamp, body }；type 用到这四种：
//   trace-create        一趟任务
//   span-create/update  一步非模型的活儿（工具调用、专家子任务、外部 CLI 引擎整趟）
//   generation-create/update  一次模型调用（带模型名和 token 账）
// create 是开工就发、update 是收工再发：任务跑到一半崩了，Langfuse 上照样看得见已经跑过的部分。
const INGEST_PATH = "/api/public/ingestion";

const FLUSH_MS = 2000;      // 攒批的时间窗：够短，跑着的任务在界面上点开 trace 就能看到进度
const MAX_BATCH = 30;       // 一次 POST 最多带多少条
const MAX_QUEUE = 600;      // 队列上限。对方挂了的时候，宁可丢老的也不能让内存跟着任务一起涨
const SEND_TIMEOUT_MS = 10000;
const CAP_TEXT = 8000;      // 单条输入/输出的字数上限
const CAP_MSG = 4000;       // 提示词里单条消息的字数上限
const CAP_MSGS = 80;        // 提示词最多带多少条消息（超了从中间挖，两头都要留）

const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

/** 截断并说清截了多少——不写这半句的话，trace 上看到的半截文本会被当成模型真的只说了这些 */
function capText(s, n) {
  const t = s == null ? "" : String(s);
  return t.length <= n ? t : t.slice(0, n) + `\n…（已截断，原文共 ${t.length} 字）`;
}

/**
 * 把本项目的历史结构摊成一串消息。
 *
 * 本项目的 history 有三种形状：普通的 {role, content}、助手的 {role:"assistant", text, toolCalls}、
 * 还有一条顶多条的 {role:"tool", results:[…]}。直接把原始结构丢上去，Langfuse 只会显示一坨
 * 折叠的 JSON；摊平成 [{role, content}] 才能像聊天记录一样读。
 */
function messagesOf(system, history) {
  const out = [];
  if (system) out.push({ role: "system", content: capText(system, CAP_MSG) });
  for (const e of Array.isArray(history) ? history : []) {
    if (!e) continue;
    if (e.role === "tool") {
      for (const r of e.results || []) {
        out.push({
          role: "tool",
          name: r && r.name,
          content: capText(r && r.content, CAP_MSG) + (r && r.isError ? "\n（这一步是报错返回的）" : ""),
        });
      }
      continue;
    }
    if (e.role === "assistant") {
      const calls = (e.toolCalls || []).map((t) => `${t.name}(${capText(JSON.stringify(t.input || {}), 500)})`);
      out.push({
        role: "assistant",
        content: capText(e.text != null ? e.text : e.content, CAP_MSG) + (calls.length ? `\n→ 调用工具：${calls.join("；")}` : ""),
      });
      continue;
    }
    out.push({ role: e.role || "user", content: capText(e.content, CAP_MSG) });
  }
  // 太长就从中间挖：开头那几条是任务本身，最后那几条是现场，中间的过程可以省
  if (out.length > CAP_MSGS) {
    const cut = out.length - CAP_MSGS;
    out.splice(2, cut, { role: "system", content: `（中间 ${cut} 条消息略过，完整历史在本机会话文件里）` });
  }
  return out;
}

/**
 * 地址清洗：把 https://公钥:私钥@host 这种连用户名密码一起粘进来的地址剥干净。
 * 不剥的话，任何一条报错日志都会把私钥原样打到终端上。
 */
function cleanHost(raw) {
  const s = String(raw || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return "";
    u.username = "";
    u.password = "";
    u.hash = "";
    u.search = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/** 读当前配置。读的是活的 config 对象，所以设置里改完立刻生效，不用重启 */
function readCfg(config) {
  const c = (config && config.langfuse) || {};
  // 地址栏留空 = 用官方托管版；地址栏**填错** = 什么都不发。
  // 这两件事绝不能混为一谈：自建的人把 host 少打一个 https:// 就悄悄退回官方 cloud，
  // 等于把他的提示词原文、工具参数全发给了另一家公司，而界面上一切正常
  const raw = String(c.host == null ? "" : c.host).trim();
  const host = raw ? cleanHost(raw) : "https://cloud.langfuse.com";
  const badHost = !!raw && !host;
  const pk = String(c.public_key || "").trim();
  const sk = String(c.secret_key || "").trim();
  const on = c.enabled === true;
  return {
    enabled: on,
    host,
    publicKey: pk,
    secretKey: sk,
    // 开了但没填全 = 用户以为在记，其实一条都没发。这个状态得单独认出来报给他
    ready: on && !!host && !!pk && !!sk,
    missing: on && (!pk || !sk),
    badHost,
  };
}

/** 关掉追踪时给出去的空壳。方法齐全、全都不干活，链式调用随便写 */
const OFF = {
  id: "",
  traceId: "",
  url: "",
  enabled: false,
  span() { return OFF; },
  generation() { return OFF; },
  end() {},
};

async function post(cfg, batch) {
  const resp = await fetch(cfg.host + INGEST_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64"),
    },
    body: JSON.stringify({ batch }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const text = await resp.text().catch(() => "");
  if (!resp.ok && resp.status !== 207) {
    // 401/403 最常见（Key 填反了、填的是另一个项目的），把状态码带出去，用户一眼知道该改什么
    throw new Error(`HTTP ${resp.status}${text ? "：" + text.slice(0, 200) : ""}`);
  }
  // 207 = 部分成功。整批没被拒，但里面某几条 Langfuse 不认（字段超长、id 撞车之类）
  let rejected = 0;
  let why = "";
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j.errors) && j.errors.length) {
      rejected = j.errors.length;
      why = String(j.errors[0].message || j.errors[0].error || "").slice(0, 200);
    }
  } catch {}
  return { rejected, why };
}

function createTracer(config) {
  const ctx = {
    queue: [],
    timer: null,
    flushing: null,
    sent: 0,
    dropped: 0,
    failed: 0,
    rejected: 0,
    lastError: "",
    lastOkAt: 0,
    warned: false,
  };
  const cfgNow = () => readCfg(config);

  function schedule() {
    if (ctx.queue.length >= MAX_BATCH) { flush(); return; }
    if (ctx.timer) return;
    ctx.timer = setTimeout(() => { ctx.timer = null; flush(); }, FLUSH_MS);
    // 不能让这个定时器拖着进程不退出：wb 命令行跑完一句就该退，不该为了攒批多挂两秒
    if (ctx.timer.unref) ctx.timer.unref();
  }

  function push(type, body) {
    const cfg = cfgNow();
    if (!cfg.ready) return;
    if (ctx.queue.length >= MAX_QUEUE) {
      ctx.queue.shift();
      ctx.dropped++;
      if (!ctx.warned) {
        ctx.warned = true; // 只喊一次，别把终端刷满
        console.warn(`[追踪] 上报积压超过 ${MAX_QUEUE} 条，开始丢弃最早的事件（Langfuse 那边可能连不上）`);
      }
    }
    ctx.queue.push({ id: uid(), timestamp: nowIso(), type, body });
    schedule();
  }

  /**
   * 把队列发空。失败重试一次就放手——追踪是旁路，不能为了发日志把任务拖着。
   * 但放手不等于装没发生：计数和最后一条错误都留着，设置页「测一下」那里看得见。
   */
  async function flush() {
    if (ctx.flushing) return ctx.flushing;
    ctx.flushing = (async () => {
      while (ctx.queue.length) {
        const cfg = cfgNow();
        if (!cfg.ready) { ctx.queue.length = 0; return; } // 中途被关掉了，攒着的也别发了
        const batch = ctx.queue.splice(0, MAX_BATCH);
        let err = null;
        for (let tryNo = 0; tryNo < 2; tryNo++) {
          try {
            const r = await post(cfg, batch);
            ctx.sent += batch.length - r.rejected;
            ctx.rejected += r.rejected;
            ctx.lastOkAt = Date.now();
            if (r.rejected) ctx.lastError = `有 ${r.rejected} 条被 Langfuse 拒收：${r.why}`;
            else ctx.lastError = "";
            err = null;
            break;
          } catch (e) {
            err = e;
            if (tryNo === 0) await new Promise((r) => setTimeout(r, 500)); // 抖一下重来，网络毛刺不值得丢数据
          }
        }
        if (err) {
          ctx.failed += batch.length;
          ctx.lastError = String((err && err.message) || err).slice(0, 300);
          console.warn(`[追踪] ${batch.length} 条没发出去：${ctx.lastError}`);
          return; // 这一趟就到这儿，剩下的留在队列里等下一次；对方要是真挂了，上面的上限会兜住
        }
      }
    })().finally(() => { ctx.flushing = null; });
    return ctx.flushing;
  }

  const urlOf = (traceId) => {
    const cfg = cfgNow();
    return cfg.ready && traceId ? `${cfg.host}/trace/${traceId}` : "";
  };

  /** 一个观测节点（trace 根 / span / generation 共用同一副外壳，调用方只管 .span/.generation/.end） */
  function node({ id, traceId, kind }) {
    let ended = false;
    const self = {
      id,
      traceId,
      enabled: true,
      get url() { return urlOf(traceId); },
      span(o) { return obs("span", traceId, id, o); },
      generation(o) { return obs("generation", traceId, id, o); },
      end(o) {
        if (ended) return; // 收尾路径有好几条（正常结束、超时、抛异常），重复 end 会在 Langfuse 上留两条互相覆盖的记录
        ended = true;
        if (kind === "trace") {
          // 根节点认的字段跟 observation 不是一套：没有 endTime，也没有 traceId / usage / level。
          // 多塞字段轻则被忽略、重则整条被拒收，所以这儿另拼一份，token 账和出没出错折进 metadata
          push("trace-create", { id, ...traceBodyOf(o) });
        } else {
          push(kind + "-update", { id, traceId, endTime: nowIso(), ...bodyOf(o) });
        }
      },
    };
    return self;
  }

  /** end() 时补上去的那几样：产出、token 账、错没错 */
  function bodyOf(o = {}) {
    const b = {};
    if (o.output !== undefined) b.output = typeof o.output === "string" ? capText(o.output, CAP_TEXT) : o.output;
    if (o.metadata) b.metadata = o.metadata;
    // token 账：一个都没记到就整块不发。发一组 0 上去，看的人会以为这次调用真的没花钱——
    // 那是把「没记账」写成了「没花钱」，比不显示更糟
    const u = o.usage;
    if (u && (u.prompt || u.completion)) {
      b.usage = { input: u.prompt || 0, output: u.completion || 0, total: (u.prompt || 0) + (u.completion || 0), unit: "TOKENS" };
      if (u.cached) b.metadata = { ...(b.metadata || {}), cached_tokens: u.cached };
    }
    if (o.error) {
      b.level = "ERROR";
      b.statusMessage = capText(o.error, 500);
    } else if (o.level) {
      b.level = o.level;
    }
    return b;
  }

  /** 根节点收尾时补的那几样。trace 只认 output / metadata / tags，其余一律折进 metadata */
  function traceBodyOf(o = {}) {
    const b = {};
    if (o.output !== undefined) b.output = typeof o.output === "string" ? capText(o.output, CAP_TEXT) : o.output;
    const m = { ...(o.metadata || {}) };
    const u = o.usage;
    if (u && (u.prompt || u.completion)) {
      m.tokens_in = u.prompt || 0;
      m.tokens_out = u.completion || 0;
      if (u.cached) m.tokens_cached = u.cached;
    }
    if (o.error) m.error = capText(o.error, 500);
    if (Object.keys(m).length) b.metadata = m;
    return b;
  }

  function obs(kind, traceId, parentId, o = {}) {
    if (!cfgNow().ready) return OFF;
    const id = uid();
    const body = {
      id,
      traceId,
      parentObservationId: parentId && parentId !== traceId ? parentId : undefined,
      name: String((o && o.name) || kind),
      startTime: nowIso(),
    };
    if (o.input !== undefined) body.input = typeof o.input === "string" ? capText(o.input, CAP_TEXT) : o.input;
    if (o.metadata) body.metadata = o.metadata;
    if (kind === "generation") {
      if (o.model) body.model = String(o.model);
      if (o.modelParameters) body.modelParameters = o.modelParameters;
    }
    push(kind + "-create", body);
    return node({ id, traceId, kind });
  }

  return {
    /** 这台机器现在到底在不在记 */
    get enabled() { return cfgNow().ready; },
    config: cfgNow,
    urlOf,
    messagesOf,
    /**
     * 开一趟任务的 trace。关着的时候返回空壳，调用方不用判空。
     * 立刻发一条 trace-create，界面上那个「看 trace」的链接当场就能点开——
     * 不然用户得等任务跑完才看得到，长任务里最想看的恰恰是跑到一半的时候。
     */
    trace(o = {}) {
      if (!cfgNow().ready) return OFF;
      const id = uid();
      push("trace-create", {
        id,
        name: String(o.name || "task").slice(0, 200),
        userId: o.userId ? String(o.userId).slice(0, 120) : undefined,
        sessionId: o.sessionId ? String(o.sessionId).slice(0, 120) : undefined,
        input: typeof o.input === "string" ? capText(o.input, CAP_TEXT) : o.input,
        metadata: o.metadata,
        tags: Array.isArray(o.tags) ? o.tags.filter(Boolean).map((t) => String(t).slice(0, 40)).slice(0, 10) : undefined,
        timestamp: nowIso(),
      });
      return node({ id, traceId: id, kind: "trace" });
    },
    /** 发一条探针上去并**当场等结果**，专给设置页那颗「测一下」用：能不能通，现在就要知道 */
    async probe(override) {
      const cfg = override ? readCfg({ langfuse: { ...override, enabled: true } }) : cfgNow();
      if (!cfg.host) return { ok: false, detail: "地址不像个网址，得是 http:// 或 https:// 开头" };
      if (!cfg.publicKey || !cfg.secretKey) return { ok: false, detail: "公钥和私钥都要填（Langfuse 项目设置里生成一对）" };
      const id = uid();
      try {
        const r = await post(cfg, [{
          id: uid(),
          timestamp: nowIso(),
          type: "trace-create",
          body: {
            id,
            name: "OpenWorkBuddy 连通性自检",
            timestamp: nowIso(),
            input: "这是 OpenWorkBuddy 设置页点「测一下」发出来的探针，看到它就说明通了。",
            metadata: { source: "openworkbuddy", kind: "probe" },
            tags: ["openworkbuddy", "probe"],
          },
        }]);
        if (r.rejected) return { ok: false, detail: `连上了，但这条被拒收：${r.why}` };
        return { ok: true, detail: "通了", url: `${cfg.host}/trace/${id}`, id };
      } catch (e) {
        return { ok: false, detail: String((e && e.message) || e).slice(0, 300) };
      }
    },
    /** 上报账本：发出去多少、丢了多少、最后一次为什么失败 */
    stats() {
      const cfg = cfgNow();
      return {
        enabled: cfg.enabled,
        ready: cfg.ready,
        missing_key: cfg.missing,
        bad_host: cfg.badHost,
        host: cfg.host,
        queued: ctx.queue.length,
        sent: ctx.sent,
        rejected: ctx.rejected,
        failed: ctx.failed,
        dropped: ctx.dropped,
        last_error: ctx.lastError,
        last_ok_at: ctx.lastOkAt || 0,
      };
    },
    flush,
  };
}

/**
 * 按 config 对象取同一个追踪器。
 *
 * agent.js 要往上发事件，server.js 要在设置页显示「发出去多少条、最后一次为什么失败」——
 * 各造各的就会是两本账：界面上永远 0，实际一直在发。config 对象在本项目里是**同一个引用**
 * （设置保存走的是就地改字段，不是整个换掉），所以拿它当钥匙正好，顺带连热改配置一起解决。
 */
const _byConfig = new WeakMap();
function getTracer(config) {
  const k = config && typeof config === "object" ? config : module;
  let t = _byConfig.get(k);
  if (!t) { t = createTracer(config); _byConfig.set(k, t); }
  return t;
}

module.exports = { createTracer, getTracer, noop: OFF, _internals: { messagesOf, capText, cleanHost, readCfg, OFF } };
