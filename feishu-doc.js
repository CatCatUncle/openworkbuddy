"use strict";
/**
 * 飞书云文档创建 — agent 工具 feishu_doc_create 的实现。
 * 复用 config.im.feishu 的机器人凭证（与 IM 远程指挥同一个应用）。
 *
 * 内容转换走两条路：
 *  1) 首选官方转换 API（POST /docx/v1/documents/blocks/convert）——表格/加粗/斜体/链接/1-9级标题/待办全支持，
 *     需要应用开通 docx:document.block:convert 权限；
 *  2) 没这个权限就回退本地 mdToBlocks（标题/列表/引用/代码块/加粗）。
 * 图片（![alt](本地路径或URL)）单独切段处理：创建空 image 块 → upload_all(parent_node) → replace_image 回填。
 * 飞书只收 PNG/JPG；SVG 会先经 diagram.js 转 PNG，转不了就降级为文字占位。
 *
 * ⚠️ 飞书后台该应用需要开通「查看、评论、编辑和管理云文档」（docx:document）权限并发布版本，
 *    否则创建接口会返回权限错误（本模块会把开通指引原样返回给 agent 转告用户）。
 */

const fs = require("fs");
const path = require("path");

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

/** 行内格式：**加粗** 和 `代码` 拆成带样式的 text_run（旧版是直接剥掉，白瞎了模型认真写的重点） */
function inlineEls(s) {
  const els = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) els.push({ text_run: { content: s.slice(last, m.index) } });
    if (m[1] != null) els.push({ text_run: { content: m[1], text_element_style: { bold: true } } });
    else els.push({ text_run: { content: m[2], text_element_style: { inline_code: true } } });
    last = m.index + m[0].length;
  }
  if (last < s.length) els.push({ text_run: { content: s.slice(last) } });
  return els.length ? els : [{ text_run: { content: "" } }];
}

/** Markdown → 飞书 docx 块（本地回退路径：#/##/### 标题、-/* 列表、1. 列表、> 引用、``` 代码块、普通段落、行内加粗/代码） */
function mdToBlocks(md) {
  const blocks = [];
  const lines = String(md || "").split("\n");
  const el = (s) => [{ text_run: { content: s } }];
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
      blocks.push({ block_type: m[1].length + 2, [key]: { elements: inlineEls(m[2]) } });
    } else if ((m = line.match(/^\s*[-*]\s+(.+)$/))) {
      blocks.push({ block_type: 12, bullet: { elements: inlineEls(m[1]) } });
    } else if ((m = line.match(/^\s*\d+[.、]\s+(.+)$/))) {
      blocks.push({ block_type: 13, ordered: { elements: inlineEls(m[1]) } });
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      blocks.push({ block_type: 15, quote: { elements: inlineEls(m[1]) } });
    } else if (line.trim()) {
      blocks.push({ block_type: 2, text: { elements: inlineEls(line) } });
    }
    i++;
  }
  return blocks.length ? blocks : [{ block_type: 2, text: { elements: el("（空文档）") } }];
}

/** 把 markdown 按图片行切段：[{type:"md",text}] 与 [{type:"img",src,alt}] 交替。只切独占一行的图片 */
function splitMarkdownImages(md) {
  const segs = [];
  let buf = [];
  const flush = () => {
    const text = buf.join("\n");
    if (text.trim()) segs.push({ type: "md", text });
    buf = [];
  };
  for (const line of String(md || "").split("\n")) {
    const m = line.match(/^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/);
    if (m) {
      flush();
      segs.push({ type: "img", alt: m[1] || "图片", src: m[2] });
    } else {
      buf.push(line);
    }
  }
  flush();
  return segs.length ? segs : [{ type: "md", text: String(md || "") }];
}

/** 官方转换 API：markdown → 嵌套块（含表格）。飞书返回的 table 里带只读 merge_info，插入前必须剥掉 */
async function convertViaApi(token, md) {
  const data = await feishuFetch(token, "POST", "/docx/v1/documents/blocks/convert", {
    content_type: "markdown",
    content: md,
  });
  const blocks = (data.blocks || []).map((b) => {
    if (b.table) {
      const t = { ...b.table };
      delete t.merge_info;
      if (t.property) { t.property = { ...t.property }; delete t.property.merge_info; }
      return { ...b, table: t };
    }
    return b;
  });
  return { blocks, firstIds: data.first_level_block_ids || [] };
}

/** 把 convert 结果整树追加进文档（descendant 接口，按一级块分批，单批块数封顶 900） */
async function appendDescendants(token, docId, conv) {
  const byId = new Map(conv.blocks.map((b) => [b.block_id, b]));
  const subtree = (id, acc) => {
    const b = byId.get(id);
    if (!b) return acc;
    acc.push(b);
    for (const c of b.children || []) subtree(c, acc);
    return acc;
  };
  let ids = [], descendants = [], created = 0;
  const flush = async () => {
    if (!ids.length) return;
    await feishuFetch(token, "POST", `/docx/v1/documents/${docId}/blocks/${docId}/descendant`, {
      children_id: ids,
      descendants,
    });
    created += descendants.length;
    ids = []; descendants = [];
  };
  for (const id of conv.firstIds) {
    const tree = subtree(id, []);
    if (descendants.length && descendants.length + tree.length > 900) await flush();
    ids.push(id);
    descendants.push(...tree);
  }
  await flush();
  return created;
}

/** 三步插图：空 image 块 → upload_all(parent_node=块id) → replace_image 回填 */
async function appendImage(token, docId, absPath, alt) {
  let buf, name;
  if (/^https?:\/\//.test(absPath)) {
    const resp = await fetch(absPath, { signal: AbortSignal.timeout(20000) });
    if (!resp.ok) throw new Error(`下载图片失败 HTTP ${resp.status}`);
    buf = Buffer.from(await resp.arrayBuffer());
    name = (absPath.split("/").pop() || "image.png").split("?")[0].slice(-80) || "image.png";
  } else {
    buf = fs.readFileSync(absPath);
    name = path.basename(absPath);
  }
  if (/\.svg$/i.test(name)) {
    // 飞书不收 SVG，尽力转 PNG
    const { svgToPngAnyhow } = require("./diagram");
    const r = await svgToPngAnyhow(buf.toString("utf8"));
    if (!r.png) throw new Error("SVG 转 PNG 失败（桌面应用内或装了 Chrome 才能转）");
    buf = r.png;
    name = name.replace(/\.svg$/i, ".png");
  }
  if (buf.length > 20 * 1024 * 1024) throw new Error("图片超过 20MB");
  const made = await feishuFetch(token, "POST", `/docx/v1/documents/${docId}/blocks/${docId}/children`, {
    children: [{ block_type: 27, image: {} }],
  });
  const blockId = made.children[0].block_id;
  const form = new FormData();
  form.append("file_name", name);
  form.append("parent_type", "docx_image");
  form.append("parent_node", blockId);
  form.append("size", String(buf.length));
  form.append("file", new Blob([buf]), name);
  const up = await fetch(`${API}/drive/v1/medias/upload_all`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  const upData = await up.json();
  if (upData.code !== 0) throw new Error(`上传图片素材失败: ${upData.msg}（code ${upData.code}）`);
  await feishuFetch(token, "PATCH", `/docx/v1/documents/${docId}/blocks/${blockId}`, {
    replace_image: { token: upData.data.file_token },
  });
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
 * 创建飞书云文档并写入 Markdown 内容（含表格与图片）。
 * wait_for_permission=true 时：权限不足不立刻失败，而是每 20 秒重试（上限约 10 分钟，
 * 且不超过任务总预算/停止信号）——用户去后台开通权限，一生效就自动建好文档继续任务。
 * opts.resolveImage(相对路径) → 绝对路径或 null：本地图片按 agent 工作目录解析，越界拒绝。
 * @returns { url, document_id, blocks, images, warn }
 */
async function createFeishuDoc(feishuCfg, { title, markdown, wait_for_permission }, opts = {}) {
  const { deadline, stopSignal, resolveImage } = opts;
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

  // 正文按图片切段：文字段优先走官方转换 API（表格/加粗全支持），没权限就回退本地解析；图片段三步上传
  let blockCount = 0, imageCount = 0;
  const warns = [];
  let convertUsable = true; // 首次权限失败后整篇降级，不反复撞
  for (const seg of splitMarkdownImages(markdown)) {
    if (seg.type === "img") {
      try {
        let abs = seg.src;
        if (!/^https?:\/\//.test(abs)) {
          abs = resolveImage ? resolveImage(seg.src) : null;
          if (!abs || !fs.existsSync(abs)) throw new Error("本地图片不存在或路径越界");
        }
        await appendImage(token, docId, abs, seg.alt);
        imageCount++;
        blockCount++;
      } catch (e) {
        warns.push(`图片「${seg.src}」插入失败：${e.message}`);
        await feishuFetch(token, "POST", `/docx/v1/documents/${docId}/blocks/${docId}/children`, {
          children: [{ block_type: 2, text: { elements: [{ text_run: { content: `（图片缺失：${seg.alt} — ${seg.src}）` } }] } }],
        }).catch(() => {});
      }
      continue;
    }
    let appended = false;
    if (convertUsable) {
      try {
        const conv = await convertViaApi(token, seg.text);
        if (conv.firstIds.length) blockCount += await appendDescendants(token, docId, conv);
        appended = true;
      } catch (e) {
        convertUsable = false; // 没开 block:convert 权限或转换挂了——本篇余下全走本地解析
        if (!isPermissionError(e)) warns.push(`官方转换失败已回退本地解析：${e.message}`);
      }
    }
    if (!appended) {
      const blocks = mdToBlocks(seg.text);
      for (let i = 0; i < blocks.length; i += 50) {
        await feishuFetch(token, "POST", `/docx/v1/documents/${docId}/blocks/${docId}/children`, {
          children: blocks.slice(i, i + 50),
        });
      }
      blockCount += blocks.length;
    }
  }

  // 尽力打开「组织内可阅读」的链接分享（失败不致命：机器人创建的文档默认只有机器人自己可见）
  try {
    await feishuFetch(token, "PATCH", `/drive/v1/permissions/${docId}/public?type=docx`, {
      link_share_entity: "tenant_readable",
    });
  } catch (e) {
    warns.push(`文档已创建，但开启链接分享失败（${e.message}）——打开链接若提示无权限，请让机器人把文档发到会话里，或在飞书后台补 drive:drive 权限。`);
  }

  return { url: `https://feishu.cn/docx/${docId}`, document_id: docId, blocks: blockCount, images: imageCount, warn: warns.join("\n") };
}

module.exports = { createFeishuDoc, mdToBlocks, splitMarkdownImages, inlineEls };
