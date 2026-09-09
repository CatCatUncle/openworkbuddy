"use strict";
/**
 * lark-cli（@larksuite/cli，MIT）的输出解析 —— 纯函数，不碰进程也不碰 config，方便测。
 *
 * 为什么值得单独一个模块：飞书机器人必须有「应用」的 app_id + app_secret，这是平台设计，
 * 扫码替代不了（扫码授权的是「你这个人」，而且设备码流程本身就要求先有一个已绑定的应用）。
 * 但 lark-cli 提供了另一条路：`config init --new` 能直接**新建一个应用**——它会阻塞着
 * 打印一个验证链接，用户在浏览器里点完，凭证就写进 ~/.lark-cli/config.json 了。
 * 我们把那个链接抓出来变成二维码，再把建好的凭证导进来，用户就一个字都不用手打。
 */

// lark-cli 的 config show 是「JSON + 空行 + Config file path: ...」，后面那截不是 JSON
function parseConfigShow(stdout) {
  const head = String(stdout || "").split(/\n\s*\n\s*Config file path/)[0].trim();
  try {
    const j = JSON.parse(head);
    return j && typeof j === "object" ? j : null;
  } catch {
    // 前面可能混进升级提示之类的杂话，退一步找第一个完整的 JSON 对象
    const i = head.indexOf("{");
    const k = head.lastIndexOf("}");
    if (i < 0 || k <= i) return null;
    try { return JSON.parse(head.slice(i, k + 1)); } catch { return null; }
  }
}

/**
 * 从 lark-cli 的输出里抠出那条验证链接。
 * 它可能是 "Open this URL in your browser to authenticate:\nhttps://..."，
 * 也可能夹在别的话里；统一按「第一个飞书/Lark 域名的 https 链接」取。
 */
function verifyUrlOf(text) {
  const s = String(text || "");
  const m = s.match(/https:\/\/[^\s"'<>）)]*\b(?:feishu\.cn|larksuite\.com|larkoffice\.com)[^\s"'<>）)]*/);
  return m ? m[0].replace(/[.,;：。]+$/, "") : "";
}

/** 建应用/授权失败时，把 lark-cli 那串英文报错翻成一句用户看得懂的中文 */
function explainLarkError(raw) {
  const s = String(raw || "").trim();
  if (!s) return "lark-cli 没有返回内容";
  if (/OPENCLAW_HOME|HERMES_HOME|Agent workspace/i.test(s)) return "lark-cli 认为自己在 Agent 环境里，拒绝新建应用；重启 OpenWorkBuddy 再试一次";
  if (/config init|app.?id.*(missing|empty)|no apps/i.test(s)) return "lark-cli 还没绑定应用：先「扫码新建应用」，或自己跑 lark-cli config init";
  if (/app registration failed/i.test(s)) return "飞书那边没能把应用建出来（多半是你的账号没有创建应用的权限，需要企业管理员开）";
  if (/timeout|deadline exceeded/i.test(s)) return "等太久超时了，重新点一次";
  if (/ENOENT|not found/i.test(s)) return "lark-cli 没装：先跑 npx @larksuite/cli@latest install";
  return s.slice(0, 300);
}

/**
 * lark-cli 的 app_secret 是「只进不出」的：`config init --app-secret-stdin` 能写进去，
 * 但 macOS 上它默认锁进系统钥匙串，`config show` 只回一串 `****`（config.json 里存的是
 * `{source:"keychain", id:...}` 这样一个引用，不是密钥本身）。
 * 把这串掩码当凭证存下来，等于用一个假 secret 把用户原来那个好的顶掉 —— 必须挡在门口。
 * 只有真读到明文（老版本 / 非 macOS 会直接写在 config.json 里）才认。
 */
function usableSecret(v) {
  if (typeof v !== "string") return false;         // 钥匙串引用是个对象，不是字符串
  const s = v.trim();
  if (!s || /^[*•·xX]+$/.test(s)) return false;    // 掩码
  return s.length >= 16;                           // 飞书 app_secret 是 32 位，放宽一档兜底
}

/** secret 读不出来时，告诉用户下一步该干嘛（而不是甩一句「导入失败」） */
const SECRET_LOCKED_HINT =
  "lark-cli 把 App Secret 锁在系统钥匙串里，命令行读不出来（它只进不出）。最后一步得你自己来：去开放平台复制 App Secret，粘到下面的「粘一段过来自动识别」框里。";

/** 拼一条直达这个应用「凭证与基础信息」页的链接，省得用户自己在后台里翻 */
function appConsoleUrl(appId, brand) {
  if (!/^cli_[A-Za-z0-9]+$/.test(String(appId || ""))) return "";
  const host = /lark/i.test(String(brand || "")) ? "open.larksuite.com" : "open.feishu.cn";
  return `https://${host}/app/${appId}/baseinfo`;
}

module.exports = { parseConfigShow, verifyUrlOf, explainLarkError, usableSecret, SECRET_LOCKED_HINT, appConsoleUrl };
