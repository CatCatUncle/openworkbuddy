"use strict";
/**
 * 飞书云文档创建 — agent 工具 feishu_doc_create 的实现。
 * 复用 config.im.feishu 的机器人凭证（与 IM 远程指挥同一个应用）。
 *
 * ⚠️ 飞书后台该应用需要额外开通「查看、评论、编辑和管理云文档」（docx:document）权限并发布版本，
 *    否则创建接口会返回权限错误（本模块会把开通指引原样返回给 agent 转告用户）。
 */

const API = "https://open.feishu.cn/open-apis";

async function feishuFetch(token, method, url, body) {
  const resp = await fetch(`${API}${url}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await resp.json();
  if (data.code !== 0) {
    const err = new Error(`${data.msg}（code ${data.code}）`);
    err.feishuCode = data.code;
    throw err;
  }
  return data.data;
}

async function getToken(feishuCfg) {
  // 云文档可用独立凭证（IM 机器人应用没开 docx 权限时，另配一个有云文档权限的应用）
  const cfg = feishuCfg || {};
  const app_id = cfg.doc_app_id || cfg.app_id;
  const app_secret = cfg.doc_app_id ? cfg.doc_app_secret : cfg.app_secret;
  if (!app_id || !app_secret) throw new Error("未配置飞书凭证（设置 → IM 远程指挥 → 飞书机器人 / 云文档凭证）");
  const resp = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id, app_secret }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`获取飞书 token 失败: ${data.msg}（code ${data.code}）`);
  return data.tenant_access_token;
}

/** Markdown → 飞书 docx 块（支持 #/##/### 标题、-/* 列表、1. 列表、> 引用、``` 代码块、普通段落） */
function mdToBlocks(md) {
  const blocks = [];
  const lines = String(md || "").split("\n");
  const el = (s) => [{ text_run: { content: s } }];
  const plain = (s) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // 跳过收尾 ```
      blocks.push({ block_type: 14, code: { elements: el(buf.join("\n")), style: {} } });
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.+)$/))) {
      const key = "heading" + m[1].length; // heading1/2/3 → block_type 3/4/5
      blocks.push({ block_type: m[1].length + 2, [key]: { elements: el(plain(m[2])) } });
    } else if ((m = line.match(/^\s*[-*]\s+(.+)$/))) {
      blocks.push({ block_type: 12, bullet: { elements: el(plain(m[1])) } });
    } else if ((m = line.match(/^\s*\d+[.、]\s+(.+)$/))) {
      blocks.push({ block_type: 13, ordered: { elements: el(plain(m[1])) } });
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      blocks.push({ block_type: 15, quote: { elements: el(plain(m[1])) } });
    } else if (line.trim()) {
      blocks.push({ block_type: 2, text: { elements: el(plain(line)) } });
    }
    i++;
  }
  return blocks.length ? blocks : [{ block_type: 2, text: { elements: el("（空文档）") } }];
}

const isPermissionError = (e) =>
  [99991672, 99991679, 1770032, 230002].includes(e.feishuCode) || /permission|权限/i.test(e.message);

const PERMISSION_GUIDE =
  "需要到飞书开放平台 → 该机器人应用 → 权限管理，开通「查看、评论、编辑和管理云文档」(docx:document) 与「查看、评论和管理云空间文件」(drive:drive) 权限，然后发布一个新版本，几分钟后生效。";

/** 可中断的 sleep：2 秒一切片，停止信号一来立即醒 */
async function sleepAbortable(ms, signal) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (signal && signal.aborted) return;
    await new Promise((r) => setTimeout(r, Math.min(2000, end - Date.now())));
  }
}

/**
 * 创建飞书云文档并写入 Markdown 内容。
 * wait_for_permission=true 时：权限不足不立刻失败，而是每 20 秒重试（上限约 10 分钟，
 * 且不超过任务总预算/停止信号）——用户去后台开通权限，一生效就自动建好文档继续任务。
 * @returns { url, document_id, blocks, warn }
 */
async function createFeishuDoc(feishuCfg, { title, markdown, wait_for_permission }, opts = {}) {
  const { deadline, stopSignal } = opts;
  const docTitle = String(title || "未命名文档").slice(0, 100);
  const waitCap = () => {
    const cap = Date.now() + 10 * 60 * 1000;
    return deadline ? Math.min(cap, deadline - 30000) : cap; // 给任务收尾留 30 秒
  };

  let doc;
  const tryCreate = async () => {
    const token = await getToken(feishuCfg);
    return { token, doc: await feishuFetch(token, "POST", "/docx/v1/documents", { title: docTitle }) };
  };
  let token;
  try {
    ({ token, doc } = await tryCreate());
  } catch (e) {
    if (!isPermissionError(e)) throw e;
    if (!wait_for_permission) throw new Error(`创建飞书文档被拒（${e.message}）。${PERMISSION_GUIDE}`);
    // 轮询等用户开通：20 秒一试，权限错误继续等，其他错误/超时/手动停止即放弃
    const until = waitCap();
    const t0 = Date.now();
    for (;;) {
      await sleepAbortable(20000, stopSignal);
      if (stopSignal && stopSignal.aborted) throw new Error("任务被手动停止，放弃等待权限。");
      if (Date.now() >= until) {
        throw new Error(
          `等了 ${Math.round((Date.now() - t0) / 60000)} 分钟权限仍未生效，先交付本地版本。${PERMISSION_GUIDE}开通并发布版本后，让我再发一次即可。`
        );
      }
      try {
        ({ token, doc } = await tryCreate());
        break; // 权限生效了
      } catch (e2) {
        if (!isPermissionError(e2)) throw e2;
      }
    }
  }
  const docId = doc.document.document_id;

  // 正文分批写入（单次上限 50 块）
  const blocks = mdToBlocks(markdown);
  for (let i = 0; i < blocks.length; i += 50) {
    await feishuFetch(token, "POST", `/docx/v1/documents/${docId}/blocks/${docId}/children`, {
      children: blocks.slice(i, i + 50),
    });
  }

  // 尽力打开「组织内可阅读」的链接分享（失败不致命：机器人创建的文档默认只有机器人自己可见）
  let warn = "";
  try {
    await feishuFetch(token, "PATCH", `/drive/v1/permissions/${docId}/public?type=docx`, {
      link_share_entity: "tenant_readable",
    });
  } catch (e) {
    warn = `文档已创建，但开启链接分享失败（${e.message}）——打开链接若提示无权限，请让机器人把文档发到会话里，或在飞书后台补 drive:drive 权限。`;
  }

  return { url: `https://feishu.cn/docx/${docId}`, document_id: docId, blocks: blocks.length, warn };
}

module.exports = { createFeishuDoc, mdToBlocks };
