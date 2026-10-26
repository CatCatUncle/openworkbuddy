// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const path = require("path");
const { execFile } = require("child_process");
const which = require("../../platform/which");
const { buildChildEnv } = require("../../platform/child-env");
const delivery = require("../automation/schedule-delivery");

const DEF = {
  name: "send_feishu_message",
  description: "用本机已绑定的 lark-cli 机器人给用户明确指定的飞书用户或会话发送一条消息。发送前须有用户授权的目标和内容；在应用进程访问钥匙串，不修改凭据存储或沙箱。按 message_id 判断送达，超时不得重发或切换机器人。",
  input_schema: { type: "object", properties: {
    recipient: { type: "string", description: "当前 lark-cli 应用下的 ou_ 用户 ID 或 oc_ 会话 ID，不猜测" },
    text: { type: "string", description: "发送正文，支持 Markdown，最多 20000 字" },
  }, required: ["recipient", "text"], additionalProperties: false },
};
function binary() { return which.findIn(which.augmentedPath().split(path.delimiter), "lark-cli"); }
function invoke(bin, args, options) {
  return new Promise(resolve => execFile(bin, args, { ...options, windowsHide: true }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
}
async function send(input, { signal, cwd, bin = binary(), run = invoke } = {}) {
  const to = String(input.recipient || ""), text = String(input.text || "").trim();
  if (!/^(?:ou|oc)_[A-Za-z0-9]{8,128}$/.test(to) || !text || text.length > 20000) return { content: "需要有效的飞书接收 ID 和 1–20000 字的发送正文。", isError: true };
  if (/!\[[^\]]*\]\s*\(|<img\b/i.test(text)) return { content: "此通道只发送文字和链接，不自动下载正文里的图片；请移除图片引用后发送。", isError: true };
  if (!bin) return { content: "本机未安装 lark-cli，消息没有发送。", isError: true };
  return delivery.runShell({ command: "lark-cli im +messages-send" }, async () => {
    const args = ["im", "+messages-send", "--as", "bot", to.startsWith("ou_") ? "--user-id" : "--chat-id", to, "--markdown", text];
    const out = await run(bin, args, { signal, cwd, timeout: 30000, maxBuffer: 1024 * 1024,
      env: buildChildEnv({ PATH: which.augmentedPath(), LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" }), windowsHide: true });
    const raw = [out.stdout, out.stderr].filter(Boolean).join("\n");
    let value;
    try { value = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch {}
    const id = value?.data?.message_id || value?.data?.message?.message_id || value?.message_id;
    if (value?.ok === true && id) return { content: JSON.stringify({ ok: true, data: { message_id: id } }), isError: false };
    const code = Number(value?.error?.code);
    // 不回传原始 stdout/stderr，其中可能夹带本机路径或认证材料。
    const type = value?.error?.type;
    const safe = ["auth", "authentication", "validation", "config", "argument", "invalid_argument"].includes(type) || type === "api" && code > 0;
    return { content: JSON.stringify({ ok: false, error: { type: safe ? type : "unknown", ...(code > 0 ? { code } : {}),
      message: /keychain/i.test(raw) ? "应用环境无法访问飞书钥匙串，消息未获回执；请检查应用的系统权限，不要降级凭据存储。"
        : safe ? "飞书未接受发送，请核对登录、权限和接收目标。" : "发送未获确定回执，请先核对原消息，勿重复发送。" } }), isError: true };
  });
}
module.exports = { DEF, binary, send };
