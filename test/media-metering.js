// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 看图 / 媒体工具的计量：钱闸按真跑的型号估价，超额在发请求之前就拦。
 *
 *   node test/media-metering.js
 *
 * 盯三件事，每件都数「假上游被打了几次」——拿回执当证据等于自证：
 *
 *   1. 看图过额度闸：一次看图算 1 次「视觉模型看图」，每人每天的次数上限照样拦得住。
 *   2. AI 不填 model 时，价按默认那条配置的型号算，估出来大于 0——不是拿空串去估成 0。
 *   3. 预算不够：发出去之前就拦，假上游一个请求都没收到；点了不存在的型号同样一个都不发。
 *
 * 全程离线：假上游起在 127.0.0.1 的随机端口，Key 是 sk-test-…，临时家目录。
 */

const HOME = require("./lib/own-home")("media-metering");

const fs = require("fs");
const http = require("http");
const path = require("path");
const { mod } = require("./lib/mod");

// 假上游在本机，别让任何代理设置把这几个请求带出去
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";

const mm = require(mod("media-models"));
const quota = require(mod("quota"));
const pricing = require(mod("pricing"));
const usage = require(mod("usage-store"));
const tools = require(mod("tools"));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  ← " + String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 300) : "")); }
}
function eq(got, want, name) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same, name, same ? undefined : { got, want });
}

// 1×1 的透明 PNG：看图要一张真图，生图回的也是它
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const KEY = "sk-test-media-metering-0001";

const hits = { chat: 0, image: 0, other: 0 };
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const send = (j) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(j)); };
    if (req.method === "POST" && /\/chat\/completions$/.test(req.url)) {
      hits.chat++;
      return send({
        choices: [{ message: { role: "assistant", content: "图上写着 hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1200, completion_tokens: 30 },
      });
    }
    if (req.method === "POST" && /\/images\/generations$/.test(req.url)) {
      hits.image++;
      return send({ data: [{ b64_json: PNG_B64 }] });
    }
    hits.other++;
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "测试里没准备这个地址：" + req.url } }));
  });
});

const WS = path.join(HOME, "ws");
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(path.join(WS, "shot.png"), Buffer.from(PNG_B64, "base64"));

/** 跟 admin.js 挂到请求上的 actor 同一个形状。price.config 故意不带媒体配置：价只能靠工具这边挑出来的型号 */
function actor(orgId, yuan, limits) {
  return {
    org: orgId, user: "xm",
    quota: quota.quotaTable({ api_quota: limits || {} }),
    budget: { orgId, org: { budget: { org_yuan: yuan } }, user: { username: "xm" } },
    price: { config: {} },
  };
}

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const c = {
    media: {
      vision: { base_url: base, api_key: KEY, model: "gpt-4o" },
      image: { base_url: base, api_key: KEY, model: "dall-e-3" },
    },
  };
  mm.normalize(c);
  const media = mm.resolve(c);
  const call = (who, name, input) => quota.withActor(who, () =>
    tools.withWorkspace(WS, () => tools.executeTool(name, input, { media, security: { gateway: false }, baseDir: "任务_计量" })));
  const ledger = (orgId, cap) => quota._internals.loadAll().usage.filter((e) => e.org === orgId && e.cap === cap);

  console.log("\n【1】看图过额度闸：一次算 1 次，次数上限拦得住");
  {
    const who = actor("o-look", 0, { vision: { enabled: true, user_daily: 1 } });
    const r = await call(who, "look_at_image", { path: "shot.png", question: "图上写的什么" });
    eq(r.isError, false, "第一次：看成了", r.content);
    eq(hits.chat, 1, "假上游被打了 1 次");
    const rows = ledger("o-look", "vision");
    ok(rows.length === 1 && rows[0].n === 1 && rows[0].model === "gpt-4o", "额度流水里记了 1 次看图，型号是真去的那个", rows);
    const sum = quota.summary("o-look", who.quota).caps.find((x) => x.key === "vision");
    ok(sum && sum.today === 1 && sum.month === 1, "后台那张表上「视觉模型看图」今天 1 次", sum);
    const money = usage.read({}).filter((e) => e.org === "o-look" && e.cap === "vision");
    ok(money.length === 1 && money[0].prompt === 1200 && money[0].completion === 30 && money[0].cost > 0,
      "主账按上游回的 token 数结算，钱大于 0", money);

    const r2 = await call(who, "look_at_image", { path: "shot.png", question: "再看一眼" });
    ok(r2.isError && /视觉模型看图/.test(r2.content), "第二次撞上每人每天 1 次：拦下，说清是哪一路", r2.content);
    eq(hits.chat, 1, "★被拦的那次一个请求都没发★");
  }

  console.log("\n【2】看图预算不够：发出去之前就拦");
  {
    const before = hits.chat;
    const who = actor("o-look-poor", 0.0001);
    const r = await call(who, "look_at_image", { path: "shot.png", question: "图上写的什么" });
    ok(r.isError && /上限/.test(r.content) && /视觉模型看图/.test(r.content), "预算只剩零头：拦下，说清撞的是预算", r.content);
    eq(hits.chat - before, 0, "★假上游收到 0 个请求★");
    eq(ledger("o-look-poor", "vision").length, 0, "没看成就不记次数");
  }

  console.log("\n【3】生图不填 model：按默认那条的型号估价，估出来大于 0");
  {
    const want = pricing.costOfUnits({ cap: "image", model: "dall-e-3", units: 1 }, {});
    ok(!want.unknown && want.yuan > 0, "前提：dall-e-3 有内置单价", want);

    const before = hits.image;
    const poor = actor("o-img-poor", 0.01);
    const r = await call(poor, "generate_image", { prompt: "一只猫" });
    const m = /这一趟还要 ¥?([\d.]+)/.exec(r.content || "");
    ok(r.isError && /生成图片/.test(r.content), "预算 0.01 元：拦下，说清是生图这一路", r.content);
    ok(m && +m[1] > 0 && Math.abs(+m[1] - want.yuan) < 0.01,
      `估的是默认那条 dall-e-3 的价（约 ${want.yuan} 元），不是 0`, r.content);
    eq(hits.image - before, 0, "★预算不够：假上游收到 0 个请求★");

    const rich = actor("o-img-rich", 100);
    const r2 = await call(rich, "generate_image", { prompt: "一只猫" });
    eq(r2.isError, false, "反向对照：预算够，同一趟照常出图", r2.content);
    eq(hits.image - before, 1, "这次假上游被打了 1 次");
    const money = usage.read({}).filter((e) => e.org === "o-img-rich" && e.cap === "image");
    ok(money.length === 1 && money[0].model === "dall-e-3" && Math.abs(money[0].cost - want.yuan) < 1e-6,
      "记账也按 dall-e-3 记，钱跟估的一样", money);
  }

  console.log("\n【4】点了不存在的型号：直接回那句「现在能用的是」，一个请求都不发");
  {
    const before = hits.image;
    const who = actor("o-img-typo", 100);
    const r = await call(who, "generate_image", { prompt: "一只猫", model: "不存在的型号" });
    ok(r.isError && /不存在的型号/.test(r.content) && /dall-e-3/.test(r.content), "回的是挑型号那句原话，列出能用的", r.content);
    eq(hits.image - before, 0, "★假上游收到 0 个请求★");
    eq(ledger("o-img-typo", "image").length, 0, "不占次数");
  }

  eq(hits.other, 0, "假上游没收到任何没准备的地址");
}

main()
  .catch((e) => { fail++; console.log("  ✗ 套件自己炸了：" + (e && e.stack || e)); })
  .finally(() => {
    server.close();
    console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
    process.exitCode = fail ? 1 : 0;
  });
