"use strict";
/**
 * 执行追踪（Langfuse）—— 这套东西所有的失败都是**静默的**，所以它非得有一套测试。
 *
 * 跑法：node test/trace.js
 * 全程不碰真的 Langfuse：本地起一个假的上报接口，自己收自己验。
 *
 * 为什么这个功能特别容易出事：它是旁路。地址填错一个字母、公私钥拿的是另一个项目的、
 * 自建那台端口没开、开关开了但钥匙只填了一半——所有这些情况下任务都照样跑完、
 * 界面上一切正常，唯一的症状是「Langfuse 上什么都没有」。用户会先怀疑自己填错了，
 * 找半天，最后放弃。所以下面每一条都往两个方向钉：该发的真发出去了（形状也对），
 * 不该发的一条都没发。
 *
 * 一破就出事的线，每条后面都跟一个反向对照：
 *
 *   1. 默认关着 = **零**网络请求。不是「发了但没人看」，是一个包都不出去
 *   2. 开了但钥匙没填全 = 也是零请求，但状态得跟「没开」区分开，不然用户永远不知道该填什么
 *   3. 上报的形状得是 Langfuse 认的那套：Basic 认证、{batch:[…]}、create/update 两段式
 *   4. 顶层 span 不许填 parentObservationId（那字段只认 observation 的 id，填 trace id 会挂成孤儿）
 *   5. 根节点的 body 里不许有 traceId / usage / level —— trace 不认这几样
 *   6. token 一个都没记到就整块不发：发一组 0 上去等于把「没记账」写成「没花钱」
 *   7. 工具报错在本项目里是**正常返回**，得靠 isError 标红，靠 catch 会满屏绿
 *   8. agent 和 server 必须共用同一本账，各造各的 → 界面永远 0、实际一直在发
 *   9. 设置里改完立刻生效，不用重启
 *  10. 对方挂了的时候队列有上限，内存不能跟着任务一起涨
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const tracing = require(path.join(ROOT, "trace"));
const { messagesOf, cleanHost, readCfg } = tracing._internals;

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });

/**
 * 一台假 Langfuse。只干三件事：把收到的请求原样记下来、按剧本决定回什么、随时能改剧本。
 * 有它才能验「形状对不对」——真 Langfuse 收下了也不会把它看到的 JSON 还给你。
 */
function fakeLangfuse() {
  const hits = [];
  let reply = { status: 207, body: { successes: [], errors: [] } };
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let json = null;
      try { json = JSON.parse(raw); } catch {}
      hits.push({ url: req.url, method: req.method, auth: req.headers.authorization || "", ct: req.headers["content-type"] || "", json, raw });
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body || {}));
    });
  });
  return {
    hits,
    setReply(r) { reply = r; },
    listen() {
      return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));
    },
    close() { return new Promise((r) => srv.close(r)); },
    /** 所有批次里的所有事件摊平——断言「一共发了哪些事件」时用 */
    events() { return hits.flatMap((h) => ((h.json && h.json.batch) || [])); },
    reset() { hits.length = 0; },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const lf = fakeLangfuse();
  const HOST = await lf.listen();

  // ===================================================================
  console.log("\n【1】默认关着：不是「发了没人看」，是一个包都不出去");
  // ===================================================================
  {
    const config = {}; // 就是 config.example.json 里 enabled:false 的效果
    const t = tracing.createTracer(config);
    eq(t.enabled, false, "没配 langfuse 这一块时，追踪是关着的");

    const tr = t.trace({ name: "不该被记下来的任务" });
    eq(tr.enabled, false, "关着时 trace() 给的是空壳");
    eq(tr.url, "", "  └ 空壳没有 url（界面上那个链接也就不会出现）");
    // 空壳必须方法齐全：调用方整份 agent.js 里一处 `if (tr)` 都没写，漏一个方法就是当场崩
    const sp = tr.span({ name: "工具 write_file", input: { path: "a.md" } });
    const gen = sp.generation({ name: "第 1 步", model: "gpt-x", input: [{ role: "user", content: "hi" }] });
    gen.end({ output: "ok", usage: { prompt: 10, completion: 20 } });
    sp.end({ output: "写好了" });
    tr.end({ output: "全部完成", usage: { prompt: 10, completion: 20 } });
    ok(true, "  └ 空壳上 span/generation/end 一路链式调下来不炸（调用方不用判空）");

    eq(t.stats().queued, 0, "  └ 此刻队列就是空的：压根没往里塞，不是塞了等发送前再扔");
    await t.flush();
    eq(lf.hits.length, 0, "关着时一次网络请求都没有", lf.hits.map((h) => h.url));
    eq(t.stats().queued, 0, "  └ 发完一轮队列还是空的");
  }

  // ===================================================================
  console.log("\n【2】开了但钥匙没填全：也是零请求，但得跟「没开」区分开");
  // ===================================================================
  {
    lf.reset();
    const config = { langfuse: { enabled: true, host: HOST, public_key: "pk-lf-test", secret_key: "" } };
    const t = tracing.createTracer(config);
    eq(t.enabled, false, "少一把钥匙就不算就绪（宁可不发，也不能拿半套凭证去撞 401）");
    const s = t.stats();
    eq(s.enabled, true, "  └ 但账本上写着「开关是开的」");
    eq(s.missing_key, true, "  └ 而且单独标出「钥匙没填全」——这才是用户要改的那件事");
    eq(s.ready, false, "  └ ready=false");
    t.trace({ name: "任务" }).end({ output: "x" });
    await t.flush();
    eq(lf.hits.length, 0, "没就绪时零请求");

    // ★反向对照★ 把私钥补上，同一个 config 对象、同一个追踪器，立刻就发了
    config.langfuse.secret_key = "sk-lf-test";
    eq(t.enabled, true, "反向对照：把私钥补上，当场就绪（设置里改完不用重启）");
    eq(t.stats().missing_key, false, "  └ 「钥匙没填全」这条也跟着消失");
    t.trace({ name: "补上钥匙之后的任务" }).end({ output: "x" });
    await t.flush();
    ok(lf.hits.length > 0, "  └ 同一个追踪器实例这回真发出去了（读的是活的 config，不是启动时的快照）", lf.hits.length);
  }

  // ===================================================================
  console.log("\n【2·续】跑到一半关掉开关：手里已经拿着的 trace 也得立刻停");
  // ===================================================================
  // 这一节钉的是三道各自独立的闸。任务跑着的时候用户在设置页把开关一关，
  // agent 手里那个 trace 对象还活着，它后面每一步都还会往上报——所以
  // 「开 span 的时候」「往队列里塞的时候」「往外发的时候」都得再判一次。
  // 少任何一道，关掉之后都还会有东西发出去，而界面上显示的是「已关闭」。
  {
    lf.reset();
    const config = { langfuse: { enabled: true, host: HOST, public_key: "pk-lf-test", secret_key: "sk-lf-test" } };
    const t = tracing.createTracer(config);
    const tr = t.trace({ name: "跑到一半被关掉的任务" });
    eq(tr.enabled, true, "开着的时候拿到的是真家伙");
    eq(t.stats().queued, 1, "  └ trace-create 已经进了队列（还没到发送的点）");

    config.langfuse.enabled = false; // 用户这会儿在设置页把开关关了

    const sp = tr.span({ name: "工具 write_file", input: { path: "a.md" } });
    eq(sp.enabled, false, "★关掉之后，手里这个 trace 再开 span 拿到的是空壳★");
    sp.generation({ name: "第 2 步" }).end({ output: "x" });
    sp.end({ output: "x" });
    tr.end({ output: "跑完了" }); // 根节点的 end 是直接往队列塞的，这条钉的是塞之前那道闸
    eq(t.stats().queued, 1, "  └ 关掉之后一条新的都没再往队列里塞", t.stats().queued);

    await t.flush();
    eq(lf.hits.length, 0, "★关掉之前攒着的那条也不发了★（发送前还得再判一次）", lf.hits.map((h) => h.url));
    eq(t.stats().queued, 0, "  └ 队列清空，不会等下回开了再补发一堆旧的");
  }

  // ===================================================================
  console.log("\n【3】上报的形状：得是 Langfuse 认的那一套");
  // ===================================================================
  let ev3 = [];
  {
    lf.reset();
    const config = { langfuse: { enabled: true, host: HOST + "/", public_key: "pk-lf-test", secret_key: "sk-lf-test" } };
    const t = tracing.createTracer(config);
    const tr = t.trace({
      name: "写一份周报",
      userId: "catuncle",
      sessionId: "sess-42",
      input: [{ role: "user", content: "写一份周报" }],
      tags: ["craft", "zh"],
      metadata: { mode: "craft" },
    });
    ok(/^https?:\/\/127\.0\.0\.1:\d+\/trace\/[0-9a-f-]{36}$/.test(tr.url), "trace 的 url 当场就有（长任务里最想看的是跑到一半的时候）", tr.url);
    const gen = tr.generation({
      name: "第 1 步",
      model: "deepseek-chat",
      input: [{ role: "system", content: "你是助理" }, { role: "user", content: "写一份周报" }],
      modelParameters: { provider: "deepseek", tools: 12, mode: "craft" },
      metadata: { depth: 0, step: 1 },
    });
    gen.end({ output: "→ 调用 write_file({...})", usage: { prompt: 1200, completion: 80, cached: 900 } });
    const sp = tr.span({ name: "工具 write_file", input: { path: "周报.md" }, metadata: { depth: 0, tool: "write_file" } });
    const sub = sp.generation({ name: "专家的第 1 步", model: "deepseek-chat" });
    sub.end({ output: "子任务做完了", usage: { prompt: 10, completion: 5 } });
    sp.end({ output: "已写入 周报.md" });
    tr.end({ output: "周报写好了", usage: { prompt: 1210, completion: 85 }, metadata: { steps: 1 } });
    await t.flush();

    ok(lf.hits.length >= 1, "发出去了", lf.hits.length);
    const h = lf.hits[0];
    eq(h.method, "POST", "用的是 POST");
    eq(h.url, "/api/public/ingestion", "打的是 /api/public/ingestion");
    ok(/^application\/json/.test(h.ct), "Content-Type 是 json", h.ct);
    ok(/^Basic /.test(h.auth), "带的是 Basic 认证", h.auth.slice(0, 10));
    const decoded = Buffer.from(h.auth.replace(/^Basic /, ""), "base64").toString();
    eq(decoded, "pk-lf-test:sk-lf-test", "  └ 解出来正好是「公钥:私钥」");
    ok(h.json && Array.isArray(h.json.batch), "body 是 { batch: [...] }", Object.keys(h.json || {}));
    ok(h.json.batch.every((e) => e.id && e.type && e.timestamp && e.body), "  └ 每条事件都有 id / type / timestamp / body",
       h.json.batch.map((e) => Object.keys(e)));

    ev3 = lf.events();
    const types = ev3.map((e) => e.type);
    for (const want of ["trace-create", "generation-create", "generation-update", "span-create", "span-update"]) {
      ok(types.includes(want), "事件里有 " + want, types);
    }

    const traceEvs = ev3.filter((e) => e.type === "trace-create");
    eq(traceEvs.length, 2, "trace-create 发两遍：开工一条、收尾一条（任务跑到一半崩了也看得见已跑过的部分）", types);
    const head = traceEvs[0].body, tail = traceEvs[1].body;
    eq(head.id, tail.id, "  └ 两条是同一个 id（后一条是补充，不是新开一趟）");
    eq(head.name, "写一份周报", "  └ 名字是任务标题");
    eq(head.userId, "catuncle", "  └ 带上是谁跑的");
    eq(head.sessionId, "sess-42", "  └ 带上会话 id：同一个对话问十轮，在 Langfuse 上是一条会话线而不是十条散 trace");
    ok(Array.isArray(head.tags) && head.tags.includes("craft"), "  └ 标签带上了（按模式筛 trace 靠它）", head.tags);

    // ★这条最容易写错★ trace 的 body 跟 observation 不是一套字段
    for (const bad of ["traceId", "usage", "level", "statusMessage", "endTime"]) {
      ok(!(bad in tail), `根节点收尾时不带 ${bad}（trace 不认这个字段，多塞轻则被忽略、重则整条被拒收）`, Object.keys(tail));
    }
    eq(tail.output, "周报写好了", "  └ 它的收尾就是把最终产出补上去");
    eq(tail.metadata.tokens_in, 1210, "  └ token 账折进 metadata（trace 上没有 usage 这一说）");
    eq(tail.metadata.tokens_out, 85, "  └ 输出 token 同理");
    eq(tail.metadata.steps, 1, "  └ 原本的 metadata 没被覆盖掉");

    const genCreate = ev3.find((e) => e.type === "generation-create" && e.body.name === "第 1 步").body;
    eq(genCreate.model, "deepseek-chat", "模型名进 generation（Langfuse 的花销统计认这个字段）");
    eq(genCreate.modelParameters.provider, "deepseek", "  └ 渠道进 modelParameters");
    ok(Array.isArray(genCreate.input) && genCreate.input[0].role === "system", "  └ 输入是摊平的消息数组，不是一坨折叠 JSON", genCreate.input && genCreate.input[0]);
    eq(genCreate.traceId, head.id, "  └ 挂在这趟 trace 上");
    ok(!("parentObservationId" in genCreate), "★顶层 observation 不填 parentObservationId★——那字段只认 observation 的 id，填 trace id 会挂成孤儿",
       genCreate.parentObservationId);

    const spCreate = ev3.find((e) => e.type === "span-create").body;
    const subCreate = ev3.find((e) => e.type === "generation-create" && e.body.name === "专家的第 1 步").body;
    eq(subCreate.parentObservationId, spCreate.id, "嵌在 span 底下的那层，parentObservationId 指向的是那个 span（层级跟界面上看到的一样）");

    const genUpdate = ev3.find((e) => e.type === "generation-update" && e.body.id === genCreate.id).body;
    eq(genUpdate.usage.unit, "TOKENS", "token 账的单位写明 TOKENS");
    eq(genUpdate.usage.input, 1200, "  └ 输入");
    eq(genUpdate.usage.output, 80, "  └ 输出");
    eq(genUpdate.usage.total, 1280, "  └ 合计（Langfuse 不自己加）");
    eq(genUpdate.metadata.cached_tokens, 900, "  └ 命中缓存那部分单独记：这部分便宜约一个数量级，不写出来长任务看着像一笔巨款");
    ok(!!genUpdate.endTime, "  └ observation 的收尾有 endTime（耗时靠它算）");
  }

  // ===================================================================
  console.log("\n【4】token 一个都没记到：整块不发，不发一组 0");
  // ===================================================================
  {
    lf.reset();
    const config = { langfuse: { enabled: true, host: HOST, public_key: "pk", secret_key: "sk" } };
    const t = tracing.createTracer(config);
    const tr = t.trace({ name: "没记到账的任务" });
    tr.generation({ name: "第 1 步", model: "m" }).end({ output: "说了句话", usage: { prompt: 0, completion: 0 } });
    tr.generation({ name: "第 2 步", model: "m" }).end({ output: "也没记到", usage: undefined });
    await t.flush();
    const ups = lf.events().filter((e) => e.type === "generation-update");
    eq(ups.length, 2, "两步都收了尾");
    ok(ups.every((e) => !("usage" in e.body)), "都没记到账时整块 usage 不发——发一组 0 上去，看的人会以为这次真的没花钱", ups.map((e) => e.body.usage));
  }

  // ===================================================================
  console.log("\n【5】工具报错要标红，而且判据是 isError 不是 catch");
  // ===================================================================
  {
    lf.reset();
    const config = { langfuse: { enabled: true, host: HOST, public_key: "pk", secret_key: "sk" } };
    const t = tracing.createTracer(config);
    const tr = t.trace({ name: "有一步失败的任务" });
    tr.span({ name: "工具 read_file" }).end({ output: "读不到这个文件", error: "文件不存在：不存在.md" });
    tr.span({ name: "工具 write_file" }).end({ output: "写好了" });
    await t.flush();
    const sps = lf.events().filter((e) => e.type === "span-update").map((e) => e.body);
    const bad = sps.find((b) => b.level === "ERROR");
    ok(!!bad, "报错那步标成 ERROR", sps.map((b) => b.level));
    ok(/不存在\.md/.test(bad.statusMessage || ""), "  └ 原因写在 statusMessage 上，不用点进去猜", bad.statusMessage);
    const good = sps.find((b) => b.id !== (bad || {}).id);
    ok(!("level" in good), "  └ 成功那步不带 level（不是全都标一遍红）", good.level);

    // ★这条是判据本身★ 源码里这一步的红/绿必须由 isError 决定。
    // 本项目的工具报错是**正常返回**（模型要看见错才知道换条路），靠 try/catch 判的话
    // trace 上会满屏绿色，真正出问题的那几步一个都标不出来
    const src = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8");
    ok(/sp\.end\(\{[^}]*error:\s*r\.isError\s*\?/.test(src.replace(/\n/g, " ")),
       "★agent.js 里工具 span 的红绿是按 r.isError 判的，不是靠 catch★");
  }

  // ===================================================================
  console.log("\n【6】重复收尾只留一条");
  // ===================================================================
  {
    lf.reset();
    const config = { langfuse: { enabled: true, host: HOST, public_key: "pk", secret_key: "sk" } };
    const t = tracing.createTracer(config);
    const tr = t.trace({ name: "收尾路径有好几条的任务" });
    const sp = tr.span({ name: "工具 run_shell" });
    sp.end({ output: "正常结束" });
    sp.end({ error: "超时" });      // 正常结束、超时、抛异常三条路都会走到 end
    tr.end({ output: "完成" });
    tr.end({ output: "又收了一次" });
    await t.flush();
    eq(lf.events().filter((e) => e.type === "span-update").length, 1, "同一个 span 只收一次尾（不然 Langfuse 上留两条互相覆盖的记录）");
    eq(lf.events().filter((e) => e.type === "trace-create" && e.body.output).length, 1, "根节点也一样");
  }

  // ===================================================================
  console.log("\n【7】历史摊平：三种形状都得读得像聊天记录");
  // ===================================================================
  {
    const msgs = messagesOf("你是助理。", [
      { role: "user", content: "帮我查一下" },
      { role: "assistant", text: "我去搜", toolCalls: [{ id: "t1", name: "web_search", input: { query: "天气" } }] },
      { role: "tool", results: [{ name: "web_search", content: "晴", isError: false }, { name: "read_file", content: "没这个文件", isError: true }] },
      { role: "assistant", content: "查到了" },
    ]);
    eq(msgs[0].role, "system", "system 提示词在最前面");
    eq(msgs[1].content, "帮我查一下", "普通 {role,content} 原样带上");
    ok(/我去搜/.test(msgs[2].content) && /web_search\(/.test(msgs[2].content),
       "助手那条把「说了什么」和「要调哪几个工具」并在一起（只记正文的话，纯调工具的步在 trace 上是一片空白）", msgs[2].content);
    eq(msgs[3].role, "tool", "一条 tool 里的多个结果拆成多条");
    eq(msgs[3].name, "web_search", "  └ 带上是哪个工具");
    ok(/（这一步是报错返回的）/.test(msgs[4].content), "  └ 报错返回的那条明写出来（它长得跟成功返回一模一样）", msgs[4].content);
    eq(msgs.length, 6, "一共摊成 6 条", msgs.map((m) => m.role));

    // 太长就从中间挖，两头都留
    const long = Array.from({ length: 300 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "第 " + i + " 条" }));
    const cut = messagesOf("", long);
    eq(cut.length, 81, "300 条压到 81（80 条上限 + 中间那句说明）", cut.length);
    ok(/中间 \d+ 条消息略过/.test(cut[2].content), "  └ 挖掉的部分明写「略过了多少条」，不是悄悄没了", cut[2].content);
    eq(cut[0].content, "第 0 条", "  └ 开头留着（任务本身在这儿）");
    eq(cut[cut.length - 1].content, "第 299 条", "  └ 结尾留着（现场在这儿）");

    const capped = messagesOf("", [{ role: "user", content: "啊".repeat(9000) }]);
    ok(/已截断，原文共 9000 字/.test(capped[0].content), "单条太长会截断，并且说清截了多少", capped[0].content.slice(-30));
  }

  // ===================================================================
  console.log("\n【8】地址里粘进来的用户名密码得剥掉");
  // ===================================================================
  {
    eq(cleanHost("https://pk-abc:sk-secret@lf.example.com/"), "https://lf.example.com",
       "★地址里带 用户名:密码 的，剥干净再用★——不剥的话任何一条报错日志都会把私钥原样打到终端上");
    eq(cleanHost("http://localhost:3000///"), "http://localhost:3000", "尾巴上的斜杠削掉（不然拼出 //api/public/ingestion）");
    eq(cleanHost("https://lf.example.com/x?token=abc#frag"), "https://lf.example.com/x", "query 和 hash 一并去掉");
    eq(cleanHost("lf.example.com"), "", "不带协议的不算网址");
    eq(cleanHost("javascript:alert(1)"), "", "只认 http/https");
    eq(cleanHost(""), "", "空的就是空的");
    const c = readCfg({ langfuse: { enabled: true, host: "https://pk:sk@lf.local", public_key: "p", secret_key: "s" } });
    ok(!/sk/.test(c.host), "  └ readCfg 出来的 host 里已经没有凭证了", c.host);
  }

  // ===================================================================
  console.log("\n【9】agent 和 server 必须共用同一本账");
  // ===================================================================
  {
    lf.reset();
    const config = { langfuse: { enabled: true, host: HOST, public_key: "pk", secret_key: "sk" } };
    const a = tracing.getTracer(config);   // agent.js 拿的那个
    const b = tracing.getTracer(config);   // server.js 设置页拿的那个
    ok(a === b, "★同一个 config 对象拿到的是同一个追踪器★（按对象认，不是按内容认）");
    a.trace({ name: "任务" }).end({ output: "x" });
    await a.flush();
    ok(b.stats().sent > 0, "  └ 所以设置页看到的「发出去多少条」是真账本", b.stats());

    // ★反向对照★ 各造各的就是两本账：界面上永远 0，实际一直在发。
    // 这个 bug 一旦犯了，用户只会看到「开着但一条都没发」，然后去查网络、查钥匙、查防火墙
    const c1 = tracing.createTracer(config);
    const c2 = tracing.createTracer(config);
    c1.trace({ name: "任务" }).end({ output: "x" });
    await c1.flush();
    eq(c2.stats().sent, 0, "反向对照：各造各的，第二本账上永远是 0（界面显示 0、实际一直在发）");
  }

  // ===================================================================
  console.log("\n【10】对方挂了：队列有上限，内存不跟着任务一起涨");
  // ===================================================================
  {
    const config = { langfuse: { enabled: true, host: "http://127.0.0.1:1", public_key: "pk", secret_key: "sk" } };
    const t = tracing.createTracer(config);
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(" "));
    try {
      for (let i = 0; i < 900; i++) t.trace({ name: "任务 " + i });
      await t.flush(); // 等在飞的那一批落地，不然它既不在队里也还没记进失败数
      const s = t.stats();
      ok(s.queued <= 600, "队列封在 600 条以内（塞了 900 条）", s.queued);
      ok(s.dropped > 0, "  └ 丢掉的条数如实记账，不是悄悄扔", s.dropped);
      eq(s.queued + s.dropped + s.failed, 900, "  └ 900 条件件有着落：还在队里的 + 丢掉的 + 发失败的，加起来一条不差", s);
      eq(warns.filter((w) => /上报积压/.test(w)).length, 1, "  └ 只喊一次，不把终端刷满", warns.length);
    } finally { console.warn = origWarn; }
  }

  // ===================================================================
  console.log("\n【11】发失败了要留痕：「一条都没发」和「发了被拒」不是一回事");
  // ===================================================================
  {
    // 连不上
    const t1 = tracing.createTracer({ langfuse: { enabled: true, host: "http://127.0.0.1:1", public_key: "pk", secret_key: "sk" } });
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      t1.trace({ name: "任务" }).end({ output: "x" });
      await t1.flush();
    } finally { console.warn = origWarn; }
    const s1 = t1.stats();
    ok(s1.failed > 0, "连不上时记下失败条数", s1);
    ok(!!s1.last_error, "  └ 最后一条失败原因留着（设置页能看见）", s1.last_error);
    eq(s1.sent, 0, "  └ 而且没谎报「已发出」");

    // 连上了，但被对方拒收（字段超长、id 撞车之类）
    lf.reset();
    lf.setReply({ status: 207, body: { successes: [], errors: [{ id: "x", message: "trace body 里有它不认的字段" }] } });
    const t2 = tracing.createTracer({ langfuse: { enabled: true, host: HOST, public_key: "pk", secret_key: "sk" } });
    t2.trace({ name: "任务" }).end({ output: "x" });
    await t2.flush();
    const s2 = t2.stats();
    ok(s2.rejected > 0, "被拒收的条数单独记（HTTP 207 是「部分成功」，不是成功）", s2);
    ok(/拒收/.test(s2.last_error), "  └ 报给用户的话里说清是「被拒收」不是「没连上」", s2.last_error);
    lf.setReply({ status: 207, body: { successes: [], errors: [] } });
  }

  // ===================================================================
  console.log("\n【12】设置页那颗「测一下」：当场要答案");
  // ===================================================================
  {
    lf.reset();
    const t = tracing.createTracer({ langfuse: { enabled: true, host: HOST, public_key: "pk", secret_key: "sk" } });
    const r1 = await t.probe();
    eq(r1.ok, true, "通了就说通了");
    ok(/\/trace\/[0-9a-f-]{36}$/.test(r1.url || ""), "  └ 而且给一条能点开的链接：用户自己去那边看见了才算真通", r1.url);
    eq(lf.hits.length, 1, "  └ 探针是当场发的，不进队列等两秒");

    lf.setReply({ status: 401, body: { message: "Unauthorized" } });
    const r2 = await t.probe();
    eq(r2.ok, false, "钥匙不对就说不对");
    ok(/401/.test(r2.detail), "  └ 带上状态码：401 的意思是钥匙填反了或者拿的是另一个项目的", r2.detail);
    lf.setReply({ status: 207, body: { successes: [], errors: [] } });

    const r3 = await t.probe({ host: HOST, public_key: "pk", secret_key: "" });
    eq(r3.ok, false, "钥匙没填全，话说在前头（不用真发一趟才知道）");
    ok(/公钥和私钥/.test(r3.detail), "  └ 说的是缺什么，不是一句「失败」", r3.detail);

    // ★这条是隐私红线★ 地址填错**不许**悄悄退回官方 cloud.langfuse.com。
    // 自建的人少打一个 https://，那就等于把提示词原文、工具参数全发给了另一家公司，
    // 而界面上一切正常——他永远不会知道。留空才是「我就要用官方托管版」
    const r4 = await t.probe({ host: "lf.example.com", public_key: "pk", secret_key: "sk" });
    eq(r4.ok, false, "★地址填错当场拦下，绝不退回官方 cloud★（自建的人少打一个 https:// 就把提示词发给别人了）");
    ok(/http/.test(r4.detail), "  └ 并且告诉他该怎么填", r4.detail);
    eq(lf.hits.length, 2, "  └ 而且一个包都没往外发（这一轮只有前面那两次探针）", lf.hits.length);
    const cfgBad = readCfg({ langfuse: { enabled: true, host: "lf.example.com", public_key: "p", secret_key: "s" } });
    eq(cfgBad.ready, false, "  └ 填错地址时整个追踪不就绪");
    eq(cfgBad.badHost, true, "  └ 而且单独标出「地址填错了」，不然用户只看到 ready=false 会跑去查钥匙");
    eq(readCfg({ langfuse: { enabled: true, host: "", public_key: "p", secret_key: "s" } }).host, "https://cloud.langfuse.com",
       "★反向对照★：地址栏**留空**才是「用官方托管版」——留空和填错是两件事");

    // 用草稿值测：设置页那颗按钮是「先测再存」，不能逼用户先存错的再来试
    lf.reset();
    const t2 = tracing.createTracer({ langfuse: { enabled: false } });
    const r5 = await t2.probe({ host: HOST, public_key: "pk-draft", secret_key: "sk-draft" });
    eq(r5.ok, true, "开关还关着也能测（草稿值直接拿去发）");
    eq(Buffer.from(lf.hits[0].auth.replace(/^Basic /, ""), "base64").toString(), "pk-draft:sk-draft",
       "  └ 用的是草稿里那对钥匙，不是存盘里的");
  }

  // ===================================================================
  console.log("\n【13】真跑一趟任务：层级、工具、报错，一条不少");
  // ===================================================================
  {
    const { createAgentRuntime } = require(path.join(ROOT, "agent"));
    const { McpManager } = require(path.join(ROOT, "mcp"));
    const { setWorkspaceDir } = require(path.join(ROOT, "tools"));
    const WS = setWorkspaceDir(fs.mkdtempSync(path.join(os.tmpdir(), "owb-trace-ws-")));

    // 剧本：读一个不存在的文件（工具报错）→ 写一个文件（成功）→ 收工
    const makeLLM = () => {
      let step = 0;
      return {
        provider: "mock",
        model: "scripted",
        async chat() {
          step++;
          if (step === 1) {
            return { text: "先看看有没有旧稿。", usage: { prompt: 100, completion: 20 },
              toolCalls: [{ id: "t1", name: "read_file", input: { path: "根本不存在.md" } }], stopReason: "tool_use" };
          }
          if (step === 2) {
            return { text: "没有，我新写一份。", usage: { prompt: 200, completion: 30 },
              toolCalls: [{ id: "t2", name: "write_file", input: { path: "周报.md", content: "# 周报\n干完了。" } }], stopReason: "tool_use" };
          }
          return { text: "周报写好了。", usage: { prompt: 300, completion: 10 }, toolCalls: [], stopReason: "end" };
        },
      };
    };
    const baseCfg = () => ({ agent: { max_steps: 6, tool_timeout_ms: 30000 } });

    // ── ★反向对照先跑★ 关着的时候，一个包都不出去、一个事件都不发 ──
    lf.reset();
    {
      const config = baseCfg(); // 没有 langfuse 这一块
      const events = [];
      await createAgentRuntime({ config, llm: makeLLM(), mcpManager: new McpManager(), experts: [] })
        .runTask({ history: [{ role: "user", content: "写一份周报" }], emit: (ev) => events.push(ev), taskLabel: "写一份周报", sessionId: "s1" });
      await wait(200);
      eq(lf.hits.length, 0, "反向对照：追踪关着跑完整趟任务，网络请求 0 次", lf.hits.length);
      eq(events.filter((e) => e.type === "trace").length, 0, "  └ 也不会给前端发 trace 事件（界面上不会多出一个点不开的链接）");
      ok(events.some((e) => e.type === "tool_result"), "  └ 但任务本身照跑（工具结果都在）");
    }

    // ── 打开追踪，同一趟任务再跑一遍 ──
    lf.reset();
    const config = { ...baseCfg(), langfuse: { enabled: true, host: HOST, public_key: "pk", secret_key: "sk" } };
    const events = [];
    const out = await createAgentRuntime({ config, llm: makeLLM(), mcpManager: new McpManager(), experts: [] })
      .runTask({ history: [{ role: "user", content: "写一份周报" }], emit: (ev) => events.push(ev),
        taskLabel: "写一份周报", sessionId: "sess-abc", user: { username: "catuncle" }, lang: "zh" });
    eq(out.finalText, "周报写好了。", "任务本身跑完了（追踪没把它搞挂）");
    await wait(300);

    const trEv = events.find((e) => e.type === "trace");
    ok(!!trEv, "给前端发了 trace 事件——「我要能看到每次执行的具体 trace」就是靠它在回复下面挂链接", events.map((e) => e.type).slice(0, 8));
    ok(/\/trace\/[0-9a-f-]{36}$/.test((trEv || {}).url || ""), "  └ 带的是一条能点开的地址", trEv && trEv.url);
    eq((trEv || {}).depth, 0, "  └ 只在顶层发一次（专家子任务不会各挂一个链接）");

    const evs = lf.events();
    const root = evs.find((e) => e.type === "trace-create").body;
    eq(root.name, "写一份周报", "trace 的名字就是任务标题");
    eq(root.sessionId, "sess-abc", "  └ 会话 id 传到底了（server.js 那头是从 SSE 请求里带进来的）");
    eq(root.userId, "catuncle", "  └ 谁跑的也带上了");
    ok(Array.isArray(root.tags) && root.tags.includes("zh"), "  └ 语言/模式进标签", root.tags);

    const gens = evs.filter((e) => e.type === "generation-create").map((e) => e.body);
    ok(gens.length >= 3, "三次模型调用各自一条 generation", gens.map((g) => g.name));
    ok(gens.every((g) => g.traceId === root.id), "  └ 全挂在这趟 trace 底下", gens.map((g) => g.traceId === root.id));
    const g1 = gens.find((g) => g.name === "第 1 步");
    ok(Array.isArray(g1.input) && g1.input.some((m) => m.role === "system"), "  └ 完整提示词（含 system）进去了：排查「它为什么这么干」全靠这个", (g1.input || []).map((m) => m.role));
    const g1u = evs.find((e) => e.type === "generation-update" && e.body.id === g1.id).body;
    eq(g1u.usage.input, 100, "  └ 这一步的 token 账对得上");
    ok(/read_file/.test(g1u.output), "  └ 纯调工具的那步，输出里写了它要调什么（不然 trace 上是一片空白）", g1u.output);

    const sps = evs.filter((e) => e.type === "span-create").map((e) => e.body);
    const rf = sps.find((s) => s.name === "工具 read_file");
    const wf = sps.find((s) => s.name === "工具 write_file");
    ok(!!rf && !!wf, "两次工具调用各自一条 span", sps.map((s) => s.name));
    eq(rf.input.path, "根本不存在.md", "  └ span 上带着工具的真实参数");
    const rfu = evs.find((e) => e.type === "span-update" && e.body.id === rf.id).body;
    const wfu = evs.find((e) => e.type === "span-update" && e.body.id === wf.id).body;
    eq(rfu.level, "ERROR", "★读不到文件那步标红了★——这是本项目里最容易漏的一条：工具报错是正常返回，不抛异常");
    ok(!("level" in wfu), "  └ 写文件那步没标红", wfu.level);
    ok(/周报\.md/.test(wfu.output || ""), "  └ 成功那步的结果也带上了", (wfu.output || "").slice(0, 40));

    const tail = evs.filter((e) => e.type === "trace-create").pop().body;
    eq(tail.output, "周报写好了。", "根节点收尾带上最终回复");
    eq(tail.metadata.tokens_in, 600, "  └ 整趟的 token 账（三步加起来）", tail.metadata);
    eq(tail.metadata.steps, 3, "  └ 一共几次模型调用");

    fs.rmSync(WS, { recursive: true, force: true });
  }

  // ===================================================================
  console.log("\n【14】配置与设置页的接线");
  // ===================================================================
  {
    const ex = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
    ok(!!ex.langfuse, "config.example.json 里有 langfuse 这一块（配置白名单和默认值都靠它）");
    eq(ex.langfuse.enabled, false, "★默认关着★——打开就等于把提示词原文发到用户填的那台机器上，得他自己点");
    eq(ex.langfuse.public_key, "", "公钥默认空");
    eq(ex.langfuse.secret_key, "", "私钥默认空");
    ok(/Docker|自己/.test(ex.langfuse._说明 || ""), "  └ 说明里讲清「自建就在自己机器里、填官方 cloud 就是发给别人」", (ex.langfuse._说明 || "").slice(0, 40));

    const srv = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    ok(/isPlatformOwner\(req\)\s*\?\s*\(config\.langfuse\s*\|\|\s*\{\}\)\.secret_key/.test(srv),
       "★私钥只给平台管理员看原文★，别人拿到的是星号（成员账号能看到设置页）");
    ok(/has_secret/.test(srv), "  └ 另给一个 has_secret 布尔，界面才分得清「没填」和「填了但打了码」");
    ok(/\/api\/trace\/test/.test(srv), "有「测一下能不能通」这个接口");
    ok(/platform_only/.test(srv.slice(srv.indexOf("/api/trace/test") - 600, srv.indexOf("/api/trace/test") + 900)),
       "  └ 而且它是平台管理员专属（能测就能拿它当探针往外发请求）");
    ok(/"trace"/.test(srv.slice(srv.indexOf("recordingEmit"), srv.indexOf("recordingEmit") + 2200)),
       "trace 事件进存盘清单：退出再进来，那条链接还在");

    const a02 = fs.readFileSync(path.join(ROOT, "public", "js", "app-02.js"), "utf8");
    ok(/"trace"/.test(a02.slice(a02.indexOf("function makeRecCounter"), a02.indexOf("function makeRecCounter") + 900)),
       "★前端那份计数清单也跟着加了★——两边不一致，断流重连算出来的续流点就是错的");
    const a01 = fs.readFileSync(path.join(ROOT, "public", "js", "app-01.js"), "utf8");
    ok(/turn\._trace/.test(a01), "前端把 trace 地址挂在这一轮上");
    ok(/\^https\?:/.test(a01.slice(a01.indexOf('ev.type === "trace"'), a01.indexOf('ev.type === "trace"') + 300)),
       "  └ 并且只认 http/https 开头的地址（这条 URL 不经过 esc，直接进 href）");
    const a05 = fs.readFileSync(path.join(ROOT, "public", "js", "app-05.js"), "utf8");
    ok(/PLATFORM_ONLY_CATS[\s\S]{0,200}"trace"/.test(a05), "设置页那一栏是平台管理员专属");
    ok(/\/api\/trace\/test/.test(a05), "  └ 界面上那颗「测一下」真的连到了接口");
    ok(/st\.bad_host/.test(a05), "  └ 账本那块单独说「地址不像网址」，不跟「钥匙没填全」混成一句（不然用户去翻错的地方）");
    ok(a05.indexOf("st.bad_host") < a05.indexOf('"开着，但钥匙没填全'),
       "  └ 而且这一条排在钥匙那条前面：地址错的时候 ready 也是 false，顺序反了就永远显示不出来");
  }

  await lf.close();
  console.log("\n================================");
  console.log(`通过 ${pass} 条，失败 ${fail} 条`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n测试本身炸了：", (e && e.stack) || e);
  process.exit(1);
});
