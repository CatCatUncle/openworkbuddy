// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · Commercial use requires authorization: COMMERCIAL-LICENSE.md
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const notify = require("../src/core/obs/notify");
const delivery = require("../src/core/automation/schedule-delivery");
const { createScheduler } = require("../src/core/automation/scheduler");
const { mergeImPatch } = require("../src/im/im-config");

(async () => {
  const oldFetch = global.fetch, oldWarn = console.warn;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-feishu-test-"));
  const im = { feishu: { app_id: "cli_fixture", app_secret: "fixture-secret", notify_target: "ou_fixture01" } };
  const calls = [];
  let response = { code: 0, data: { message_id: "om_fixture" } };
  global.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => String(url).includes("tenant_access_token")
      ? { code: 0, tenant_access_token: "fixture-token" } : response };
  };
  console.warn = () => {};
  try {
    assert.equal(await notify.pushFeishu({}, "x"), false);
    assert.equal(calls.length, 0, "没有目标不猜收件人、不发请求");
    assert.equal(notify.anyPushReady({ im }), true);
    assert.equal(await notify.pushFeishu(im, "提醒"), true);
    assert.match(calls[1].url, /receive_id_type=open_id/);
    assert.equal(calls[1].body.receive_id, "ou_fixture01");
    assert.equal(JSON.parse(calls[1].body.content).text, "提醒");
    calls.length = 0;
    await notify.pushFeishu({ feishu: { ...im.feishu, notify_target: "oc_fixture01" } }, "群通知");
    assert.match(calls[1].url, /receive_id_type=chat_id/);
    await assert.rejects(notify.pushFeishu({ feishu: { ...im.feishu, notify_target: "bad" } }, "x"), /接收 ID/);
    const member = { feishu: { ...im.feishu } };
    mergeImPatch(member, { feishu: { notify_target: "" } }, { own: true });
    assert.equal(member.feishu.notify_target, "", "清空目标立即停止通知");
    assert.equal(member.feishu.app_secret, "fixture-secret");
    assert.throws(() => mergeImPatch(member, { feishu: { app_id: "changed", notify_target: "bad" } }), /接收 ID/);
    assert.equal(member.feishu.app_id, "cli_fixture", "拒绝非法目标时不改凭证");
    mergeImPatch(member, { feishu: { notify_target: "ou_member001" } }, { own: true });
    assert.equal(member.feishu.notify_target, "ou_member001", "成员也能保存自己的接收目标");

    response = { code: 99991672, msg: "fixture-permission-error" };
    const report = {};
    assert.deepEqual(await notify.pushBots({ im }, "x", { report }), []);
    assert.equal(report.failed[0].channel, "feishu");
    assert.match(report.failed[0].error, /99991672/);
    response = { code: 0, data: {} };
    const uncertain = {};
    await delivery.withDelivery(uncertain, async () => {
      await assert.rejects(notify.pushFeishu(im, "x"), /回执/);
      const n = calls.length;
      await assert.rejects(notify.pushFeishu(im, "x"), /未确认/);
      assert.equal(calls.length, n, "无回执不能盲目补发");
    });
    assert.equal(uncertain.feishu, "unknown");
    response = { code: 0, data: { message_id: "om_fixture" } };
    calls.length = 0;
    await delivery.withDelivery({}, async () => {
      await Promise.all([notify.pushFeishu(im, "x"), notify.pushFeishu(im, "x").catch(() => {})]);
      await notify.pushFeishu(im, "x");
    });
    assert.equal(calls.filter(c => c.url.includes("im/v1/messages")).length, 1, "并发及后续补送最多一条");
    calls.length = 0;
    await delivery.withDelivery({}, async () => {
      await delivery.runShell({ command: "lark-cli im +messages-send --text fixture" }, async () => ({ content: JSON.stringify({ ok: true, data: { message_id: "om_cli" } }) }));
      await notify.pushFeishu(im, "x");
    });
    assert.equal(calls.length, 0, "CLI 已送达，应用不重复发");
    const fakeFetch = global.fetch;
    const timeoutState = {};
    global.fetch = async (url, init) => {
      if (String(url).includes("im/v1/messages")) throw new Error("fixture timeout");
      return fakeFetch(url, init);
    };
    await delivery.withDelivery(timeoutState, async () => {
      await assert.rejects(notify.pushFeishu(im, "x"), /timeout/);
      await assert.rejects(notify.pushFeishu(im, "x"), /未确认/);
    });
    assert.equal(timeoutState.feishu, "unknown", "发送超时不当成明确未发送");
    global.fetch = fakeFetch;
    const source = fs.readFileSync(path.join(__dirname, "../public/js/app-03.js"), "utf8");
    const tail = source.slice(source.indexOf("const runCell = (r) => {"));
    const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const cell = new Function("esc", "escInline", `const bold = escInline; ${tail.slice(0, tail.indexOf("\n  };"))}\n  }; return runCell;`)(esc, esc);
    assert.match(cell({ result: "报告已保存", notification: { sent: [], failed: [], reason: "未配置可用通知通道或接收目标" } }), /通知未送达/);
    assert.match(cell({ result: "报告已保存", notification: { sent: ["feishu"], failed: [] } }), /通知已送达：飞书/);
    assert.match(cell({ result: "报告已保存", notification: { sent: [], failed: [], unconfirmed: ["feishu"] } }), /通知送达未确认/);
    const untrusted = cell({ label: "错误", notification: { sent: [], failed: [{ channel: "feishu", error: "<img src=x>" }] } });
    assert(!untrusted.includes("<img"), "通知错误转义后才展示，失败任务也能看到通知状态");

    let executions = 0, pushes = 0, failPush = true;
    const scheduler = createScheduler({ storePath: path.join(dir, "schedules.json"),
      runtime: { runTask: async () => { executions++; return { finalText: "报告已保存", stopped: "" }; } },
      onResult: async () => { pushes++; if (failPush) throw new Error("fixture notification error"); return { sent: ["feishu"], failed: [] }; },
    });
    scheduler.stop();
    try {
      const task = scheduler.add({ name: "fixture", cron: "0 8 * * *", task: "保存报告" });
      await scheduler.runOne(task.id, "手动");
      assert.equal(executions, 1); assert.equal(pushes, 1);
      assert.equal(scheduler.runs(1)[0].ok, true, "通知失败不改变执行结果");
      assert.match(scheduler.runs(1)[0].notification.reason, /未完成/);
      assert.equal(scheduler.get(task.id).last_push, undefined, "未送达不更新通知基线");
      failPush = false;
      await scheduler.runOne(task.id, "手动");
      assert.deepEqual(scheduler.runs(1)[0].notification.sent, ["feishu"]);
      assert.equal(scheduler.get(task.id).last_push, "报告已保存");
    } finally { scheduler.stop(); }
    const empty = createScheduler({ storePath: path.join(dir, "empty.json"),
      runtime: { runTask: async () => ({ finalText: "报告已保存", stopped: "" }) },
      onResult: async () => ({ sent: [], failed: [] }),
    });
    empty.stop();
    try {
      const task = empty.add({ name: "fixture-empty", cron: "0 8 * * *", task: "保存报告" });
      await empty.runOne(task.id, "手动");
      assert.match(empty.runs(1)[0].notification.reason, /未配置/);
      assert.equal(empty.get(task.id).last_push, undefined, "没有通道不冒充已送达");
    } finally { empty.stop(); }
    calls.length = 0;
    const direct = createScheduler({ storePath: path.join(dir, "direct.json"),
      runtime: { runTask: async () => {
        await delivery.runShell({ command: "lark-cli im +messages-send --text fixture" }, async () => ({ content: JSON.stringify({ ok: true, data: { message_id: "om_cli" } }) }));
        return { finalText: "提醒已发送", stopped: "" };
      } },
      onResult: async () => { const report = {}; await notify.pushBots({}, "x", { report }); return report; },
    });
    direct.stop();
    try {
      const task = direct.add({ name: "fixture-direct", cron: "0 8 * * *", task: "发送提醒" });
      await direct.runOne(task.id, "手动");
      assert.deepEqual(direct.runs(1)[0].notification.sent, ["feishu"], "直接发送已获回执，也计入送达结果");
      assert.equal(calls.length, 0, "直接发送成功后无补送请求");
    } finally { direct.stop(); }
    console.log("飞书通知回归通过（全部使用模拟接口，没有对外发送）");
  } finally {
    global.fetch = oldFetch; console.warn = oldWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
