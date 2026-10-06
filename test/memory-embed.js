// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 记忆向量只用设置里选定的嵌入模型：没选就按关键词召回，一个嵌入请求都不发。
 *
 *   node test/memory-embed.js
 *
 * 以前没选嵌入模型时，记忆会在聊天 / 媒体渠道里找认识的厂商，拿那把 Key 去调一个写死的嵌入型号。
 * 用户没点过头的型号在花他的钱，而且这些调用既不过额度闸也不进账本——设了限额也管不住。
 * 这套盯四件事，每件都数「假上游被打了几次」：
 *
 *   1. 没选：各种渠道都配着 Key，假上游一个嵌入请求都收不到；记忆照常按关键词召回。
 *      反向对照：同一份配置点名一条渠道，假上游立刻收到——证明上面那个 0 不是因为没接上。
 *   2. 点名的渠道没了 / 换成了算不了向量的类型：不去别处找一条顶上，按关键词走并说清去哪儿重选。
 *   3. 计量：次数闸、钱闸都管得住；没价目的远端型号在有限额时发出去之前就拦；回来按上游报的 token 记账。
 *   4. 升级提示：以前靠借来的 Key 算过向量的老用户，升上来会被告知改成了关键词召回、去哪儿选回来。
 *
 * 全程离线：假上游在 127.0.0.1 随机端口，Key 是 sk-test-…，临时家目录；
 * fetch 外面再套一层，往 127.0.0.1 以外发的一律当场拒掉并记下来。
 */

const HOME = require("./lib/own-home")("memory-embed");

const fs = require("fs");
const http = require("http");
const path = require("path");
const { mod } = require("./lib/mod");

process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";
delete process.env.OPENAI_API_KEY; // 通用环境变量不该让「没填 Key 的渠道」凭空有了 Key

// 往外发的一律拦下记账：闸门要是漏了，这里能看到，而且请求出不了这台机器
const outbound = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const href = String((url && url.url) || url);
  let host = "";
  try { host = new URL(href).hostname; } catch {}
  if (host !== "127.0.0.1") {
    outbound.push(href);
    return Promise.reject(new Error("测试离线，不许往外发：" + href));
  }
  return realFetch(url, init);
};

const llm = require(mod("llm"));
const memory = require(mod("memory"));
const quota = require(mod("quota"));
const usage = require(mod("usage-store"));
const migrate = require(mod("migrate"));
const { createEmbedder, probeEmbedding, embedCandidates, embedChannels } = llm;
const { deadEmbedChannels } = llm._internals;

let pass = 0, fail = 0, finished = false;
process.on("exit", (code) => {
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`);
  process.exitCode = 1;
});
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  ← " + String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 300) : "")); }
}
function eq(got, want, name) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same, name, same ? undefined : { got, want });
}

const KEY = "sk-test-memory-embed-0001";
const seen = []; // 假上游收到的每一个嵌入请求
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let j = {};
    try { j = JSON.parse(body); } catch {}
    const input = Array.isArray(j.input) ? j.input : [j.input];
    seen.push({ path: req.url, auth: req.headers.authorization || "", model: j.model, input });
    if (req.method !== "POST" || !/\/embeddings$/.test(req.url)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "测试里没准备这个地址：" + req.url } }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: input.map((t, i) => ({ index: i, embedding: [String(t).length % 7, 1, i] })),
      model: j.model,
      usage: { prompt_tokens: 37 * input.length, total_tokens: 37 * input.length },
    }));
  });
});

/** 跟 admin.js 挂到请求上的 actor 同一个形状 */
function actor(orgId, yuan, limits) {
  return {
    org: orgId, user: "xm",
    quota: quota.quotaTable({ api_quota: limits || {} }),
    budget: { orgId, org: { budget: { org_yuan: yuan } }, user: { username: "xm" } },
    price: { config: {} },
  };
}

/** 抓 console.warn：该说的话说没说，同一句刷没刷屏 */
async function quiet(fn) {
  const said = [];
  const w0 = console.warn;
  console.warn = (...a) => said.push(a.join(" "));
  try { return { out: await fn(), said }; } finally { console.warn = w0; }
}

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;

  // 一台「什么都配了」的机器：通义 / OpenAI / 本机 Ollama 的聊天渠道、带 Key 的自建网关、
  // 视频那一栏还单独填着通义的 Key。以前这里每一条都会被拿去算向量
  const cfg = {
    providers: [
      { id: "p-fake", name: "自建网关", kind: "openai", base_url: base, api_key: KEY },
      { id: "p-ds", name: "DeepSeek", kind: "deepseek", base_url: "https://api.deepseek.com/v1", api_key: "sk-test-deepseek" },
    ],
    models: [
      { name: "通义", model: "qwen-max", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", api_key: "sk-test-dashscope" },
      { name: "OpenAI", model: "gpt-4o", base_url: "https://api.openai.com/v1", api_key: "sk-test-openai" },
      { name: "本机", model: "qwen3:8b", base_url: "http://localhost:11434/v1" },
      { name: "网关", model: "gpt-4o-mini", channel: "p-fake" },
    ],
    media: {
      video: { base_url: "https://dashscope.aliyuncs.com/api/v1", api_key: "sk-test-video", model: "wan2.2-t2v-plus" },
      vision: { base_url: base, api_key: KEY, model: "gpt-4o" },
    },
  };

  console.log("\n【1】没选嵌入模型：不借任何渠道的 Key，记忆照常按关键词召回");
  {
    eq(embedCandidates(cfg), [], "候选是空的：聊天 / 媒体渠道一条都不拿来算向量");
    const { out: emb, said } = await quiet(() => createEmbedder(cfg));
    eq(emb, null, "没选就是 null，记忆按关键词走");
    eq(said, [], "没选不是毛病，不刷告警");

    memory.setEmbedder(emb);
    memory.add({ text: "周报只要三段：进展、问题、下周计划", user: "甲" });
    memory.add({ text: "报销走飞书审批，发票抬头写公司全称", user: "甲" });
    memory.add({ text: "交付时只报路径，别替我打开文件", user: "甲" });
    await memory.ensureVectors();
    const block = await memory.promptBlock("甲", "帮我写这周的周报");
    ok(/周报只要三段/.test(block), "关键词召回照常：问周报，周报那条进了提示词", block.slice(0, 200));
    const vs = memory.vectorStatus();
    ok(vs.enabled === false && vs.have === 0 && vs.total === 3, "记忆面板如实说向量检索没开、一条向量都没算", vs);
    eq(seen.length, 0, "★假上游一个嵌入请求都没收到★");
    eq(outbound, [], "★也没往通义 / OpenAI / 别处发过一个请求★");
  }

  console.log("\n【1b】反向对照：同一份配置点名一条渠道，假上游立刻收到（上面那个 0 不是因为没接上）");
  {
    const c2 = { ...cfg, embedding: { provider: "p-fake", model: "text-embedding-3-small" } };
    const cands = embedCandidates(c2);
    ok(cands.length === 1 && cands[0].base_url === base && cands[0].model === "text-embedding-3-small",
      "只有点名的那一条，地址取自渠道表", cands.map((c) => ({ ...c, api_key: c.api_key ? "(有)" : "" })));
    const emb = createEmbedder(c2);
    memory.setEmbedder(emb);
    await memory.ensureVectors();
    ok(seen.length >= 1 && seen.every((x) => x.auth === "Bearer " + KEY && x.model === "text-embedding-3-small"),
      "用的是那条渠道自己的 Key、点名的型号", seen.map((x) => ({ auth: x.auth.slice(0, 16), model: x.model })));
    const vs = memory.vectorStatus();
    ok(vs.enabled && vs.have === 3 && /自建网关/.test(vs.source), "三条都算好了向量，面板说出走的是哪条渠道", vs);
    eq(outbound, [], "别的渠道照旧一个请求都没碰");
    memory.setEmbedder(null);
  }

  console.log("\n【2】点名的渠道没了 / 算不了向量：不去别处找一条顶上");
  {
    const n0 = seen.length;
    const gone = await quiet(() => createEmbedder({ ...cfg, embedding: { provider: "p-deleted", model: "text-embedding-3-small" } }));
    eq(gone.out, null, "选的渠道被删了：null，按关键词走");
    ok(gone.said.some((s) => /p-deleted/.test(s) && /设置 → 记忆/.test(s)), "说清是哪条、去哪儿重选", gone.said);
    const again = await quiet(() => createEmbedder({ ...cfg, embedding: { provider: "p-deleted", model: "text-embedding-3-small" } }));
    eq(again.said, [], "同一句不重复刷（存设置、走引导都会重建一次）");

    const chatOnly = await quiet(() => createEmbedder({ ...cfg, embedding: { provider: "p-ds", model: "text-embedding-3-small" } }));
    eq(chatOnly.out, null, "点名的是只聊天的 DeepSeek：null，不拿它的 Key 去试");
    ok(chatOnly.said.some((s) => /算不了向量/.test(s)), "说清它算不了向量", chatOnly.said);

    const chs = embedChannels(cfg);
    eq(chs.map((c) => c.id), ["p-fake"], "设置页能挑的渠道里没有只聊天的那条");
    ok(!JSON.stringify(chs).includes(KEY) && chs.every((c) => !("api_key" in c)), "给设置页的渠道清单里没有 Key", chs);

    // 渠道上没填 Key、但按渠道点名的环境变量设了：跟对话那边同一个取法
    process.env.OPENWORKBUDDY_KEY_P_ENV = "sk-test-from-env";
    const envCfg = { providers: [{ id: "p-env", name: "环境变量渠道", kind: "custom", base_url: base }], embedding: { provider: "p-env", model: "bge-m3" } };
    const r = await createEmbedder(envCfg)(["一句话"]);
    delete process.env.OPENWORKBUDDY_KEY_P_ENV;
    ok(r && r.length === 1 && seen.at(-1).auth === "Bearer sk-test-from-env", "渠道 Key 走按渠道点名的环境变量", seen.at(-1));

    // 单独填一组地址 / Key / 型号的老写法照常
    const own = await createEmbedder({ embedding: { base_url: base + "/", api_key: "sk-test-own", model: "bge-m3" } })(["再一句"]);
    ok(own && seen.at(-1).auth === "Bearer sk-test-own" && seen.at(-1).model === "bge-m3", "单独填的那组照常用", seen.at(-1));
    eq(seen.length - n0, 2, "这一段只有上面两次真打了上游");
    eq(outbound, [], "没往外发");
  }

  console.log("\n【3】计量：次数闸、钱闸管得住，回来按上游报的 token 记账");
  {
    deadEmbedChannels.clear();
    const c3 = { ...cfg, embedding: { provider: "p-fake", model: "text-embedding-3-small" } };
    const emb = createEmbedder(c3);
    const who = actor("o-emb", 0, { embedding: { enabled: true, user_daily: 1 } });
    const n0 = seen.length;
    const v1 = await quota.withActor(who, () => emb(["第一句"]));
    ok(Array.isArray(v1) && v1.length === 1, "第一次：算出了向量", v1);
    eq(seen.length - n0, 1, "假上游被打了 1 次");
    const rows = quota._internals.loadAll().usage.filter((e) => e.org === "o-emb" && e.cap === "embedding");
    ok(rows.length === 1 && rows[0].n === 1 && rows[0].model === "text-embedding-3-small", "额度流水记了 1 次记忆向量，型号是真去的那个", rows);
    const money = usage.read({}).filter((e) => e.org === "o-emb" && e.cap === "embedding");
    ok(money.length === 1 && money[0].prompt === 37 && money[0].cost > 0 && !money[0].cost_unknown,
      "主账按上游回的 37 个 token 结算，有价目就算出钱", money);
    const sum = quota.summary("o-emb", who.quota).caps.find((x) => x.key === "embedding");
    ok(sum && sum.today === 1 && sum.label === "记忆向量", "后台额度页上有「记忆向量」这一路，今天 1 次", sum);

    const blocked = await quiet(() => quota.withActor(who, () => emb(["第二句"])));
    eq(blocked.out, null, "第二次撞上每人每天 1 次：这一趟不算向量（记忆按关键词召回）");
    eq(seen.length - n0, 1, "★被拦的那次一个请求都没发★");
    ok(blocked.said.some((s) => /关键词/.test(s) && /记忆向量/.test(s)), "说了这次为什么没算", blocked.said);
    ok(!emb.isDead(), "被额度拦下不算渠道坏了：换个人、换一天还能用");
    const other = await quota.withActor(actor("o-emb2", 0, {}), () => emb(["别的组织"]));
    ok(Array.isArray(other) && seen.length - n0 === 2, "同一个 embedder 换个没限额的组织照常算", seen.length - n0);

    // 没价目的远端型号：头上有预算的人，发出去之前就拦（地址是 .invalid，真漏了也被外层 fetch 拦下记账）
    const far = { embedding: { base_url: "https://embed.example.invalid/v1", api_key: "sk-test-far", model: "acme-embed-unpriced" } };
    const rich = actor("o-unpriced", 100, {});
    const r = await quiet(() => quota.withActor(rich, () => createEmbedder(far)(["一句"])));
    eq(r.out, null, "有预算 + 没价目：这一趟不算向量");
    ok(r.said.some((s) => /价目/.test(s)), "说清是缺价目，不是渠道挂了", r.said);
    const p = await quota.withActor(rich, () => probeEmbedding(far.embedding));
    ok(p.ok === false && /价目/.test(p.error), "设置页「测一下」也过同一道闸", p);
    eq(outbound, [], "★没价目的那两次一个请求都没往外发★");

    // 钱闸按真结果结算：预算 0.000001 元，估价一过就拦
    const poor = actor("o-poor", 0.000001, {});
    const n1 = seen.length;
    const pr = await quiet(() => quota.withActor(poor, () => createEmbedder(c3)([("很长的一段话").repeat(200)])));
    eq(pr.out, null, "预算不够：这一趟不算向量");
    eq(seen.length, n1, "★预算不够的那次一个请求都没发★");
  }

  console.log("\n【4】升级提示：以前靠借来的 Key 算过向量的老用户，要被告知");
  {
    const ws = path.join(HOME, "ws-upgrade");
    fs.mkdirSync(ws, { recursive: true });
    const notes = migrate.runMigrations(ws, path.join(HOME, "mig-a.json"), { version: "9.9.9", priorUse: true, embedOff: true });
    const n = notes.find((x) => x.id === "embed-explicit-v1");
    ok(n && /关键词/.test(n.note) && /设置 → 记忆/.test(n.note), "老用户升上来：说改成了关键词召回、去哪儿选回来", notes);
    ok(n && n.note.length <= 45, "提示一句话说完", n && n.note.length);
    const twice = migrate.runMigrations(ws, path.join(HOME, "mig-a.json"), { version: "9.9.10", priorUse: true, embedOff: true });
    ok(!twice.some((x) => x.id === "embed-explicit-v1"), "只说一次，下次升级不再说");

    const ws2 = path.join(HOME, "ws-explicit");
    fs.mkdirSync(ws2, { recursive: true });
    const quietNotes = migrate.runMigrations(ws2, path.join(HOME, "mig-b.json"), { version: "9.9.9", priorUse: true, embedOff: false });
    ok(!quietNotes.some((x) => x.id === "embed-explicit-v1"), "反向对照：本来就选了嵌入模型（或从没算过向量）的不打扰", quietNotes);

    const ws3 = path.join(HOME, "ws-fresh");
    fs.mkdirSync(ws3, { recursive: true });
    const fresh = migrate.runMigrations(ws3, path.join(HOME, "mig-c.json"), { version: "9.9.9", priorUse: false, embedOff: true });
    ok(!fresh.some((x) => x.id === "embed-explicit-v1"), "全新装不说");
  }

  console.log("\n【5】接线：服务端只认显式的那一条");
  {
    const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    ok(/embedOff/.test(src) && /runMigrations\([\s\S]{0,200}embedOff/.test(src), "启动时把「老用户靠借来的向量」递给升级提示");
    const llmSrc = fs.readFileSync(mod("llm"), "utf8");
    const body = llmSrc.slice(llmSrc.indexOf("function embedCandidates("), llmSrc.indexOf("function embedChannelDead("));
    ok(body.length > 0 && !/config\.models|config\.media|\.media\b/.test(body), "embedCandidates 里不再翻聊天 / 媒体渠道", body.slice(0, 120));
  }
}

main()
  .catch((e) => { fail++; console.log("  ✗ 跑崩了：" + ((e && e.stack) || e)); })
  .finally(() => {
    server.close();
    globalThis.fetch = realFetch;
    finished = true;
    console.log(`\n${fail ? "有挂的" : "全部通过"}：${pass} 过 / ${fail} 挂`);
    process.exitCode = fail ? 1 : 0;
    // 记忆模块的命中计数是防抖写盘，别让它拖着进程
    setTimeout(() => process.exit(process.exitCode), 50).unref();
  });
