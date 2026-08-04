"use strict";
/** 结果推送 — 企业微信群机器人 + 钉钉自定义机器人（支持加签），任务/定时任务完成通知共用。 */

const crypto = require("crypto");

async function pushWecom(imCfg, text) {
  const url = imCfg.wecom_bot_webhook;
  if (!url) return false;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content: text.slice(0, 2000) } }),
    signal: AbortSignal.timeout(15000),
  });
  return true;
}

async function pushDingtalk(imCfg, text) {
  let url = imCfg.dingtalk_webhook;
  if (!url) return false;
  if (imCfg.dingtalk_secret) {
    const ts = Date.now();
    const sign = encodeURIComponent(
      crypto.createHmac("sha256", imCfg.dingtalk_secret).update(`${ts}\n${imCfg.dingtalk_secret}`).digest("base64")
    );
    url += `${url.includes("?") ? "&" : "?"}timestamp=${ts}&sign=${sign}`;
  }
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content: text.slice(0, 2000) } }),
    signal: AbortSignal.timeout(15000),
  });
  return true;
}

/** 推送到所有已配置的机器人通道；单通道失败不影响其他通道，返回成功的通道名列表 */
async function pushBots(config, text) {
  const imCfg = (config || {}).im || {};
  const sent = [];
  for (const [name, fn] of [["wecom", pushWecom], ["dingtalk", pushDingtalk]]) {
    try {
      if (await fn(imCfg, text)) sent.push(name);
    } catch (e) {
      console.warn(`[${name}] 推送失败:`, e.message);
    }
  }
  return sent;
}

module.exports = { pushBots, pushWecom, pushDingtalk };
