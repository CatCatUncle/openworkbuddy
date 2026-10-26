// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · Commercial use requires authorization: COMMERCIAL-LICENSE.md
"use strict";
/** 每次定时任务独立记发送回执：换应用/机器人不能把同一结果再发一次。 */
const { AsyncLocalStorage } = require("async_hooks");
const security = require("../safety/security");
const { headOf } = require("../safety/cmd-risk");
const scope = new AsyncLocalStorage();

function withDelivery(state, fn) { return state ? scope.run(state, fn) : fn(); }
function current() { return scope.getStore(); }

function sendCount(command) {
  return security.commandSegments(command).filter((seg) => {
    const head = headOf(seg).replace(/["']/g, "").split(/[\\/]/).pop();
    return /^lark-cli(?:\.cmd|\.exe)?$/i.test(head || "") && /\bim\s+\+messages-send\b/.test(seg)
      && !/(?:^|\s)--(?:help|dry-run)(?:\s|$)/.test(seg);
  }).length;
}

function receipt(result) {
  for (const text of String(result && result.content || "").split(/(?:^|\n)(?:stdout|stderr):\n/)) {
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    let j;
    try { j = JSON.parse(text.slice(start, end + 1)); } catch { continue; }
    const data = j && j.data || {};
    if (j && j.ok === true && (j.message_id || data.message_id || data.message && data.message.message_id)) return "sent";
    // 明确的校验/认证失败或平台业务拒绝没有发成；断连、超时和无回执不能据此重发。
    if (j && j.ok === false && j.error && (/^(validation|auth|authentication|config|argument|invalid_argument)$/.test(j.error.type || "")
      || j.error.type === "api" && Number(j.error.code) > 0)) return "idle";
  }
  return "unknown";
}

async function runShell(input, run) {
  const state = current();
  if (!state) return run();
  const count = sendCount(input.command);
  if (!count) return run();
  if (count !== 1 || input.background) return { content: "定时任务的飞书消息须单条前台发送，以便核对送达回执；不要批量换机器人发送。", isError: true };
  if (state.feishu && state.feishu !== "idle") {
    return { content: state.feishu === "sent"
      ? "本次定时任务已有飞书发送成功回执，不再重复发送，也不要切换应用或机器人重发。"
      : "本次定时任务已有飞书发送在途或结果不明，请先核对原消息，不要切换应用或机器人重发。", isError: true };
  }
  state.feishu = "pending";
  try {
    const result = await run();
    state.feishu = receipt(result);
    return result;
  } catch (e) { state.feishu = "unknown"; throw e; }
}

const NOTE = "发送结果只使用用户指定的一个应用/机器人和一个收件目标。若有 send_feishu_message，优先通过它调用本机 lark-cli，由应用访问钥匙串；不要在命令沙箱中重试或降低钥匙串保护。收到 message_id 等成功回执后立即停止发送，不切换 profile、身份或机器人重复发送。只有缺参数、未登录这类明确未发出的错误才修正重试；超时、断连或没有回执时先核对原消息，不能当作失败重发。";
module.exports = { current, withDelivery, runShell, sendCount, receipt, NOTE };
