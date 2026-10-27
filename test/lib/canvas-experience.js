// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const fs = require("fs");

const canvasFixture = (nodes, edges) => `
      await canvasFlushRemoteWrite();
      await new Promise((r) => setTimeout(r, 250));
      localStorage.clear();
      window.__store.jia = { main: { version: 2, updatedAt: 1000, edges: ${JSON.stringify(edges || [])}, nodes: ${JSON.stringify(nodes)} } };
      window.__active = "jia"; canvasState.canvasName = "main"; canvasState.cardDefaults = null; canvasState.chatOpen = false; canvasState.handsOnAt = 0; canvasState.nodeGesture = null;
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      localStorage.setItem("openworkbuddy.canvas.name", "main");
      await renderCanvasPage();
      await new Promise((r) => setTimeout(r, 400));
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }`;
const canvasNodeFixture = (id, kind, payload, x, y) => ({ id, kind, payload, position: { x, y } });

// 新旧画布回归共用同一份真实页面和项目存储夹具。
async function runCanvasExperience({ run, win, ok }) {
  const 摆画布 = canvasFixture, 卡片 = canvasNodeFixture;
  const 同 = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const saveScreenshot = async (suffix = "") => {
    if (!process.env.CANVAS_SCREENSHOT) return;
    await run(`if (document.getElementById("owb-toast")) document.getElementById("owb-toast").style.display = "none"; true`);
    const rect = await run(`(() => { const r = document.getElementById("assist-page").getBoundingClientRect(); return { x: Math.ceil(r.x), y: Math.ceil(r.y), width: Math.floor(r.width), height: Math.floor(r.height) }; })()`);
    const file = process.env.CANVAS_SCREENSHOT.replace(/\.png$/, suffix + ".png");
    fs.writeFileSync(file, (await win.webContents.capturePage(rect)).toPNG());
  };
  console.log("\n— 图片预览：目录相同才是同一张素材 —");
  const 图片身份 = await run(`(async () => {
    ${摆画布([卡片("preview-exact", "image", { path: "预览乙/同名.png" }, 20, 20)])}
    const saved = { root: canvasState.workspaceRoot, dir: canvasState.workspaceDir, preview: window.previewFile };
    try {
      canvasState.workspaceRoot = "fixture-root"; canvasState.workspaceDir = "/tmp/jia";
      canvasState.files = [{ name: "预览甲/同名.png" }, { name: "预览乙/同名.png" }];
      const out = { 完整路径: canvasResolvedFileName("预览乙/同名.png") === "预览乙/同名.png",
        绝对路径: canvasResolvedFileName("/tmp/jia/预览乙/同名.png") === "预览乙/同名.png",
        删除不补位: canvasResolvedFileName("缺失/同名.png") === "缺失/同名.png",
        裸名不猜: canvasResolvedFileName("同名.png") === "同名.png" };
      canvasRefreshNode(canvasState.graph.getCell("preview-exact"));
      const image = canvasWireRoot("preview-exact").querySelector("[data-canvas-image-preview]");
      await image.decode(); out.缩略图 = image.naturalWidth === 48;
      image.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const big = document.querySelector("#canvas-media-lightbox img"); await big.decode();
      out.放大原图 = big.naturalWidth === 48 && big.src.includes(encodeURIComponent("预览乙")) && !big.src.includes("thumb=");
      out.项目绑定 = big.src.includes("root=fixture-root");
      document.querySelector(".canvas-media-lightbox-close").click();
      let opened; window.previewFile = (name, root) => { opened = { name, root }; };
      canvasWireRoot("preview-exact").querySelector("[data-canvas-side-preview]").click();
      out.侧栏 = opened.name === "预览乙/同名.png" && opened.root === "fixture-root";
      canvasPreviewRight("/api/files/view/" + encodeURIComponent("预览乙") + "/" + encodeURIComponent("同名.png") + "?root=old-root");
      out.已有地址 = opened.name === "预览乙/同名.png" && opened.root === "old-root";
      canvasState.files = []; out.清单迟到 = canvasResolvedFileName("预览乙/同名.png") === "预览乙/同名.png";
      return out;
    } finally {
      canvasState.workspaceRoot = saved.root; canvasState.workspaceDir = saved.dir; window.previewFile = saved.preview;
      document.querySelector(".canvas-media-lightbox-close")?.click();
    }
  })()`);
  for (const [label, passed] of Object.entries(图片身份)) ok(passed, "图片身份：" + label, 图片身份);
  const 素材迟到 = await run(`(async () => {
    const oldFetch = window.fetch, oldFiles = canvasState.files;
    let release; const pending = new Promise((resolve) => { release = resolve; });
    window.fetch = (url, options) => String(url).startsWith("/api/files?") ? pending : oldFetch(url, options);
    try {
      canvasState.workspaceRoot = "fixture-root";
      const load = canvasLoadLibrary(); canvasState.workspaceName = "yi";
      release({ json: async () => [{ name: "其他项目/同名.png" }] }); await load;
      return canvasState.files === oldFiles;
    } finally { window.fetch = oldFetch; canvasState.workspaceRoot = ""; canvasState.workspaceName = "jia"; }
  })()`);
  ok(素材迟到, "切项目后迟到的素材清单不能覆盖当前画布");
  console.log("\n— 同批卡片长高：一次让位、不漏卡、不改人工叠放 —");
  const 批量让位 = await run(`(() => {
    const graph = canvasState.graph; let writes = 0, reads = 0;
    const make = (id, x, y, height) => { let p = { x, y }; return { id, position(x, y) { if (x !== undefined) { writes++; p = { x, y }; } else reads++; return { ...p }; }, size: () => ({ width: 100, height }) }; };
    const column = Array.from({ length: 120 }, (_, i) => make(i, 0, i * 120, 200));
    const separate = make("separate", 300, 120, 100), overlay = make("overlay", 0, 20, 50);
    try {
      canvasState.graph = { getElements: () => [...column, separate, overlay] };
      canvasMakeRoom(column.map((node, i) => ({ node, oldBottom: i * 120 + 100 })));
      const counts = { writes, reads }, positions = column.map((node) => node.position().y);
      canvasMakeRoom([]);
      return { ...counts, 连续无重叠: positions.every((y, i) => y === i * 220), 独立列不动: separate.position().y === 120, 人工重叠不动: overlay.position().y === 20 };
    } finally { canvasState.graph = graph; }
  })()`);
  ok(批量让位.连续无重叠 && 批量让位.独立列不动 && 批量让位.人工重叠不动, "120 张卡同时长高后整列不重叠，保留其他列和人工叠放", 批量让位);
  ok(批量让位.writes === 119 && 批量让位.reads === 122, "让位先计算再更新，每张卡最多挪一次，不反复触发连线重排", 批量让位);
  const 收起状态 = await run(`(async () => {
    ${摆画布([卡片("compact-error", "image", { path: "frame.png", generation_errors: { image: { message: "图像服务暂时不可用", at: 1 } } }, 20, 20)])}
    canvasSetSelection([]); canvasFitFlush();
    const root = canvasWireRoot("compact-error"), error = root.querySelector(".canvas-generation-error");
    return { 错误可见: error.getBoundingClientRect().height > 0, 编辑器收起: getComputedStyle(root.querySelector(".canvas-card-editor")).display === "none", 没有重复: root.querySelectorAll(".canvas-generation-error").length === 1 };
  })()`);
  ok(收起状态.错误可见 && 收起状态.编辑器收起 && 收起状态.没有重复, "已有结果的卡未选中时仍显示失败原因，编辑器继续收起", 收起状态);
  const 当前默认 = await run(`(async () => {
    ${摆画布([卡片("foreign-model", "image", { prompt: "山间晨光", model: "another-install-model" }, 20, 20)])}
    const old = settingsCache;
    try {
      settingsCache = { ...settingsCache, media_models: [{ cap: "image", name: "本窗口模型", model: "current-image-model", default: true }] };
      document.dispatchEvent(new Event("owb-media-models")); window.__runs = []; window.__bodies = [];
      canvasWireRoot("foreign-model").querySelector("[data-canvas-model-default]").click();
      const node = canvasState.graph.getCell("foreign-model"), root = canvasWireRoot(node.id);
      const out = { 默认已保存: canvasPayload(node).model === "", 不生成: window.__runs.length === 0, 警告消失: !root.querySelector(".canvas-card-model-problem"), 显示正确: root.querySelector('[data-canvas-card-key="model"]').selectedOptions[0].textContent.includes("current-image-model") };
      await canvasGenerate(node, "image"); out.请求跟随默认 = !window.__bodies.find((row) => row.url === "/api/tool/run").body.input.model;
      await canvasFlushRemoteWrite(); out.落盘 = canvasLoadSaved().nodes.find((item) => item.id === node.id).payload.model === ""; return out;
    } finally { settingsCache = old; document.dispatchEvent(new Event("owb-media-models")); }
  })()`);
  ok(当前默认.默认已保存 && 当前默认.不生成 && 当前默认.警告消失 && 当前默认.显示正确 && 当前默认.请求跟随默认 && 当前默认.落盘, "错误型号一键改用本窗口默认模型，展示与请求一致、持久保存且切换本身不生成", 当前默认);
  console.log("\n— 角色与场景：直接选模型、旧型号预检、设定编辑与结果写回 —");
  const 定妆模型 = await run(`(async () => {
    ${摆画布([卡片("script-model", "script", { title: "剧本", image_model: "retired-image-model" }, 20, 20)])}
    const oldSettings = settingsCache;
    try {
      settingsCache = { ...settingsCache, media_models: [{ cap: "image", name: "图像甲", model: "cast-model-a", default: true }, { cap: "image", name: "图像乙", model: "cast-model-b" }, { cap: "video", name: "视频甲", model: "video-model-a" }] };
      const role = canvasAddNode("character"), roleId = role.id;
      let root = canvasWireRoot(role.id), field = root.querySelector('[data-canvas-inline-key="description"]');
      const out = { 可编辑: !!field && document.activeElement === field, 空设定: field.value === "", 继承旧值: root.querySelector('[data-canvas-card-key="model"]').value, 有设置入口: !!root.querySelector("[data-canvas-model-settings]") };
      field.value = "短发，浅色外套，三十岁"; field.dispatchEvent(new Event("input", { bubbles: true }));
      window.__runs = []; window.__bodies = []; window.__failRun = null; window.__dropRun = null; window.__holdRun = null;
      const invalid = await canvasGenerate(role, "image"); out.旧值拦截 = !invalid.ok && window.__runs.length === 0 && invalid.error.includes("retired-image-model");
      root = canvasWireRoot(roleId); const model = root.querySelector('[data-canvas-card-key="model"]');
      out.只列图像 = ![...model.options].some((option) => option.value === "video-model-a");
      model.value = "图像乙"; model.dispatchEvent(new Event("change", { bubbles: true }));
      await canvasGenerate(role, "image");
      const sent = window.__bodies.find((b) => b.url === "/api/tool/run").body.input;
      out.指定请求 = sent.model === "图像乙" && sent.prompt.includes("短发，浅色外套，三十岁"); out.角色结果 = !!canvasPayload(role).reference;
      const location = canvasAddNode("location", { description: "午后茶馆，木桌与柔和斜光" });
      const locModel = canvasWireRoot(location.id).querySelector('[data-canvas-card-key="model"]');
      locModel.value = ""; locModel.dispatchEvent(new Event("change", { bubbles: true }));
      out.默认覆盖继承 = canvasDramaModel(canvasPayload(location), "image", "location") === "";
      window.__bodies = []; await canvasGenerate(location, "image");
      out.场景结果 = !!canvasPayload(location).image && !window.__bodies.find((b) => b.url === "/api/tool/run").body.input.model;
      settingsCache = { ...settingsCache, media_models: [] }; document.dispatchEvent(new Event("owb-media-models"));
      root = canvasWireRoot(roleId); out.配置变动刷新 = !!root.querySelector(".canvas-card-model-problem");
      window.__runs = []; const missing = await canvasGenerate(role, "image"); out.未配置拦截 = !missing.ok && window.__runs.length === 0;
      settingsCache = { ...settingsCache, media_models: [{ cap: "image", name: "图像乙", model: "cast-model-b", default: true }] }; document.dispatchEvent(new Event("owb-media-models"));
      out.配置恢复 = !canvasWireRoot(roleId).querySelector(".canvas-card-model-problem");
      await canvasFlushRemoteWrite(); const saved = canvasLoadSaved().nodes.find((n) => n.id === roleId);
      out.保存 = saved.payload.model === "图像乙" && saved.payload.description === "短发，浅色外套，三十岁";
      return out;
    } finally { settingsCache = oldSettings; document.dispatchEvent(new Event("owb-media-models")); }
  })()`);
  ok(定妆模型.可编辑 && 定妆模型.空设定 && 定妆模型.有设置入口 && 定妆模型.继承旧值 === "retired-image-model", "角色卡直接填写设定、选择模型，明确展示继承的旧型号", 定妆模型);
  ok(定妆模型.旧值拦截 && 定妆模型.只列图像 && 定妆模型.未配置拦截, "无效型号和未配置模型在提交前拦截，不发生成请求", 定妆模型);
  ok(定妆模型.指定请求 && 定妆模型.角色结果 && 定妆模型.场景结果 && 定妆模型.默认覆盖继承, "卡上选的模型与设定真正进入请求，默认选择覆盖旧继承值，结果写回角色和场景", 定妆模型);
  ok(定妆模型.配置变动刷新 && 定妆模型.配置恢复 && 定妆模型.保存, "模型配置变动立即刷新卡片，型号与人物设定持久保存", 定妆模型);
  console.log("\n— 镜头结果不重复铺卡、失败留痕、合并旧副本可撤销 —");
  const 镜头结果 = await run(`(async () => {
    ${摆画布([卡片("shot-result", "shot", { id: "S1-01", prompt: "窗边人物回头", first_frame: "frame.png" }, 30, 50)])}
    const shot = canvasState.graph.getCell("shot-result");
    window.__runs = []; window.__bodies = []; window.__failRun = () => ({ status: 200, body: { ok: false, isError: true, retryable: false, content: "火山拒绝了输入人像：InputImageSensitiveContentDetected.PrivacyInformation" } });
    const failed = await canvasGenerate(shot, "video");
    const out = { 失败: !failed.ok, 不重发: window.__runs.length === 1, 错误可见: !!canvasWireRoot(shot.id).querySelector(".canvas-generation-error"), 首帧保留: canvasPayload(shot).first_frame === "frame.png" };
    await canvasFlushRemoteWrite(); out.失败留存 = !!canvasLoadSaved().nodes.find((n) => n.id === shot.id).payload.generation_errors.video;
    window.__failRun = null; await canvasGenerate(shot, "video");
    out.成功清错 = !canvasPayload(shot).generation_errors?.video && !canvasWireRoot(shot.id).querySelector(".canvas-generation-error");
    out.没有重复卡 = canvasState.graph.getElements().length === 1 && !!canvasPayload(shot).video;
    await canvasGenerate(shot, "image"); out.首帧不复制 = canvasState.graph.getElements().length === 1;
    const file = canvasPayload(shot).first_frame, title = file.split("/").pop();
    const plain = canvasAddNode("image", { sourceId: shot.id, path: file, url: file, title }, undefined, { skipSelect: true }); canvasConnect(shot, plain);
    const used = canvasAddNode("image", { sourceId: shot.id, path: file, url: file, title }, undefined, { skipSelect: true }); canvasConnect(shot, used);
    const target = canvasAddNode("video", { prompt: "缓慢推进" }, undefined, { skipSelect: true }); canvasConnect(used, target, "first_frame");
    const edited = canvasAddNode("image", { sourceId: shot.id, path: file, url: file, title: "用户改过的标题" }, undefined, { skipSelect: true }); canvasConnect(shot, edited);
    const manual = canvasAddNode("image", { path: file, url: file, title }, undefined, { skipSelect: true });
    const old = canvasAddNode("image", { sourceId: shot.id, path: "old.png", url: "old.png", title: "old.png" }, undefined, { skipSelect: true }); canvasConnect(shot, old);
    canvasHistoryFlush(); document.querySelector("[data-canvas-merge-results]").click();
    out.只合并副本 = !canvasState.graph.getCell(plain.id) && [used, target, edited, manual, old, shot].every((n) => canvasState.graph.getCell(n.id));
    out.结果不丢 = canvasPayload(shot).first_frame === file && !!canvasPayload(shot).video;
    canvasUndo(); out.可撤销 = !!canvasState.graph.getCell(plain.id) && canvasState.graph.getConnectedLinks(canvasState.graph.getCell(plain.id)).length === 1;
    return out;
  })()`);
  ok(镜头结果.失败 && 镜头结果.不重发 && 镜头结果.错误可见 && 镜头结果.首帧保留 && 镜头结果.失败留存, "上游拒绝显示在镜头卡并保存，不自动重发、不抹掉已有首帧", 镜头结果);
  ok(镜头结果.成功清错 && 镜头结果.没有重复卡 && 镜头结果.首帧不复制, "再次成功后清除旧错误，镜头视频和首帧只留在原卡，不再自动复制结果节点", 镜头结果);
  ok(镜头结果.只合并副本 && 镜头结果.结果不丢 && 镜头结果.可撤销, "合并重复结果保留被引用、已编辑、手动素材和旧版本，操作可撤销", 镜头结果);
  const 审核素材 = await run(`(async () => {
    ${摆画布([])}
    const video = canvasAddNode("video", { prompt: "图片1里的虚拟人物向镜头挥手", first_frame: "本地旧首帧.png" });
    let root = canvasWireRoot(video.id); root.querySelector(".canvas-card-advanced").open = true;
    const input = root.querySelector('[data-canvas-inline-key="reference_assets"]'); input.value = "asset://asset-test-character\\nasset://asset-test-scene"; input.dispatchEvent(new Event("input", { bubbles: true }));
    window.__runs = []; window.__bodies = []; window.__failRun = null;
    await canvasGenerate(video, "video"); const body = window.__bodies.find((row) => row.url === "/api/tool/run").body.input;
    root = canvasWireRoot(video.id);
    return { 引用: body.reference_assets, 不发旧首帧: !("first_frame" in body) && !("last_frame" in body), 提示清楚: root.textContent.includes("不发送本地首尾帧") && root.textContent.includes("素材参考模式"), 旧首帧保留: canvasPayload(video).first_frame === "本地旧首帧.png" };
  })()`);
  ok(审核素材.引用?.length === 2 && 审核素材.不发旧首帧 && 审核素材.提示清楚 && 审核素材.旧首帧保留, "卡片可填写已审核素材 ID，明确参考模式且不混发本地旧首尾帧，原始引用仍保留", 审核素材);
  const 清单响应 = await run(`(async () => {
    ${摆画布([卡片("proposal-click", "image", { prompt: "山间晨光" }, 20, 20)])}
    const oldRun = canvasRunProposal, oldFetch = window.fetch;
    const p = { id: "proposal-click-error", scope: canvasScope(), name: canvasState.canvasName, items: [{ node_id: "proposal-click", kind: "image" }] }; canvasState.proposal = p;
    let release; canvasRunProposal = () => new Promise((resolve, reject) => { release = () => reject(new Error("启动测试失败")); });
    try {
      await canvasRenderProposal(p); const button = document.querySelector('[data-canvas-bar="proposal"] button'); button.click();
      const waiting = button.disabled && button.textContent === "正在准备…"; release(); await new Promise((r) => setTimeout(r, 30));
      const restored = [...document.querySelectorAll('[data-canvas-bar="proposal"] button')].find((b) => b.textContent === "开跑");
      return { 立即反馈: waiting, 恢复按钮: !!restored && !restored.disabled, 错误: document.getElementById("owb-toast").textContent.includes("启动测试失败") };
    } finally { canvasRunProposal = oldRun; window.fetch = oldFetch; canvasState.proposal = null; canvasHideBar("proposal"); }
  })()`);
  ok(清单响应.立即反馈 && 清单响应.恢复按钮 && 清单响应.错误, "真实点击开跑立即进入准备状态，启动抛错后显示原因并恢复按钮", 清单响应);
  const 清单报价等待 = await run(`(async () => {
    ${摆画布([卡片("proposal-wait", "image", { prompt: "山间晨光" }, 20, 20)])}
    const oldFetch = window.fetch, oldAsk = window.askConfirm, held = [], before = window.__runs.length;
    const p = { id: "proposal-wait", scope: canvasScope(), name: canvasState.canvasName, items: [{ node_id: "proposal-wait", kind: "image" }] }; canvasState.proposal = p;
    window.fetch = (url, options) => String(url).includes("/api/tool/estimate") && held.length < 2 ? new Promise((resolve) => held.push(resolve)) : oldFetch(url, options);
    window.askConfirm = async () => false;
    try {
      const rendering = canvasRenderProposal(p), button = document.querySelector('[data-canvas-bar="proposal"] button'); button.click();
      const out = { 准备提示: document.querySelector('[data-canvas-bar="proposal"]').textContent.includes("正在准备生成"), 两次报价: held.length === 2 };
      const quote = { ok: true, json: async () => ({ ok: true, items: [{ known: false }], total: 0, unknownCount: 1 }) };
      held[0](quote); await rendering;
      out.迟到报价不盖状态 = document.querySelector('[data-canvas-bar="proposal"]').textContent.includes("正在准备生成") && !document.querySelector('[data-canvas-bar="proposal"] button');
      held[1](quote); for (let i = 0; i < 30 && p.launching; i++) await new Promise((r) => setTimeout(r, 10));
      out.取消可重试 = [...document.querySelectorAll('[data-canvas-bar="proposal"] button')].some((b) => b.textContent === "开跑" && !b.disabled);
      out.没有生成 = window.__runs.length === before; return out;
    } finally { window.fetch = oldFetch; window.askConfirm = oldAsk; canvasState.proposal = null; canvasHideBar("proposal"); }
  })()`);
  ok(清单报价等待.准备提示 && 清单报价等待.两次报价 && 清单报价等待.迟到报价不盖状态 && 清单报价等待.取消可重试 && 清单报价等待.没有生成, "真实清单流程等待报价时保留准备状态，迟到报价不能重开按钮，取消后可重试且不提交生成", 清单报价等待);
  const 清单完成 = await run(`(async () => {
    ${摆画布([卡片("proposal-finish", "image", { prompt: "山间晨光" }, 20, 20)])}
    const oldAsk = window.askConfirm, before = window.__runs.length;
    const p = { id: "proposal-finish", scope: canvasScope(), name: canvasState.canvasName, items: [{ node_id: "proposal-finish", kind: "image" }] }; canvasState.proposal = p;
    window.askConfirm = async () => true;
    try {
      await canvasRenderProposal(p); document.querySelector('[data-canvas-bar="proposal"] button').click();
      for (let i = 0; i < 200 && p.launching; i++) await new Promise((r) => setTimeout(r, 10));
      return { 已结束: !p.launching, 只生成一次: window.__runs.length === before + 1, 状态收起: !canvasState.proposal && !document.querySelector('[data-canvas-bar="proposal"]'), 记录关闭: canvasState.proposalGone.has(p.id) };
    } finally { window.askConfirm = oldAsk; canvasState.proposal = null; canvasHideBar("proposal"); }
  })()`);
  ok(清单完成.已结束 && 清单完成.只生成一次 && 清单完成.状态收起 && 清单完成.记录关闭, "真实开跑完成后清单与状态条一起收起，finally 不再把已完成清单画回来", 清单完成);
  const 确认切项目 = await run(`(async () => {
    ${摆画布([卡片("quote-project", "image", { prompt: "山间晨光" }, 20, 20)])}
    const oldAsk = window.askConfirm, workspace = canvasState.workspaceName, before = window.__runs.length; let confirm;
    window.askConfirm = () => new Promise((resolve) => { confirm = resolve; });
    try {
      const running = canvasRunQueue("image", [canvasState.graph.getCell("quote-project")]);
      for (let i = 0; i < 100 && !confirm; i++) await new Promise((r) => setTimeout(r, 10));
      if (!confirm) throw new Error("没有进入报价确认");
      canvasState.workspaceName = "other-project"; confirm(true);
      return { 未启动: !(await running), 没有生成: window.__runs.length === before, 没有批次: !canvasState.batch, 解除确认: !canvasState.confirming };
    } finally { window.askConfirm = oldAsk; canvasState.workspaceName = workspace; }
  })()`);
  ok(确认切项目.未启动 && 确认切项目.没有生成 && 确认切项目.没有批次 && 确认切项目.解除确认, "报价确认期间切换项目，确认后也不向新项目的同名节点发起生成", 确认切项目);
  console.log("\n— 五十二、卡片直接输入、空内容不生成、新节点在当前视口 —");
  const 卡上输入 = await run(`
    (async () => {
      ${摆画布([])}
      const page = document.getElementById("assist-page"), paper = canvasState.paper;
      canvasZoom(page, .65); canvasState.x = -2800; canvasState.y = -1700; paper.translate(-2800, -1700);
      const image = canvasAddNode("image"), root = canvasWireRoot(image.id), field = root.querySelector('[data-canvas-inline-key="prompt"]');
      const r = root.getBoundingClientRect(), v = document.getElementById("canvas-viewport").getBoundingClientRect();
      const out = { 空值: field.value, 聚焦: document.activeElement === field, 无面板: !canvasState.inspectorOpen,
        可见: r.left >= v.left && r.right <= v.right && r.top >= v.top && r.bottom <= v.bottom };
      field.value = "保留原人物，换成海边夜景\\n@角色"; field.dispatchEvent(new Event("input", { bubbles: true }));
      out.内容 = canvasPayload(image).prompt;
      const menuEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); field.dispatchEvent(menuEvent);
      const key = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }); field.dispatchEvent(key);
      out.原生输入 = !menuEvent.defaultPrevented && !key.defaultPrevented && !document.getElementById("canvas-context-menu");
      let saves = 0; const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key === canvasStorageKey()) saves++; return setItem.call(this, key, value); };
      try {
        for (let i = 0; i < 40; i++) { field.value = "连续输入" + i; field.dispatchEvent(new Event("input", { bubbles: true })); }
        const before = saves; await canvasFlushRemoteWrite();
        out.合并保存 = { 之前: before, 之后: saves, 最后内容: canvasLoadSaved().nodes.find((n) => n.id === image.id).payload.prompt };
      } finally { Storage.prototype.setItem = setItem; }
      const reference = canvasAddNode("image", { title: "参考素材", path: "ref.png" }, { x: 20, y: 20 }, { skipSelect: true });
      canvasConnect(reference, image, "reference");
      field.value = ""; field.dispatchEvent(new Event("input", { bubbles: true }));
      window.__runs = []; window.__bodies = [];
      const results = [await canvasGenerate(image, "image")];
      const video = canvasAddNode("video", { first_frame: "ref.png" }); results.push(await canvasGenerate(video, "video"));
      const audio = canvasAddNode("audio"); results.push(await canvasGenerate(audio, "audio"));
      out.空内容 = { 结果: results, 请求: window.__runs.length, 工具请求: window.__bodies.filter((b) => b.url === "/api/tool/run").length };
      const old = canvasAddNode("image", { prompt: "这张图要保持的主体、风格与构图…" }); out.旧占位 = await canvasGenerate(old, "image");
      const note = canvasAddNode("note"), edit = canvasWireRoot(note.id).querySelector("[contenteditable=true]");
      out.笔记 = { 内容: edit.textContent, 聚焦: document.activeElement === edit, 存的: canvasPayload(note).text };
      const shot = canvasAddNode("shot"); out.镜头 = { 空提示词: canvasPayload(shot).prompt === "", 空台词: canvasPayload(shot).line === "", 就地输入: canvasState.inlineEdit?.nodeId === shot.id };
      canvasInlineCancel(); await canvasFlushRemoteWrite(); return out;
    })()`);
  ok(卡上输入.空值 === "" && 卡上输入.聚焦 && 卡上输入.无面板, "新参考图卡片直接出现空输入框并聚焦，不用先开设置", 卡上输入);
  ok(卡上输入.可见, "大幅平移、缩放后添加的节点仍完整出现在当前视口", 卡上输入);
  ok(卡上输入.内容 === "保留原人物，换成海边夜景\n@角色" && 卡上输入.原生输入, "卡片输入实时保存，换行、@、退格和原生右键不被画布快捷键吞掉", 卡上输入);
  ok(卡上输入.合并保存.之前 === 0 && 卡上输入.合并保存.之后 === 1 && 卡上输入.合并保存.最后内容 === "连续输入39", "连续输入 40 次合并为一次快照，切换前立即写下最后一笔", 卡上输入.合并保存);
  ok(卡上输入.空内容.请求 === 0 && 卡上输入.空内容.工具请求 === 0 && 卡上输入.空内容.结果.every((r) => !r.ok && r.error === "缺提示词"), "空图片/视频/配音均不发请求；已连参考图或已有首帧也不代替提示词", 卡上输入.空内容);
  ok(!卡上输入.旧占位.ok && 卡上输入.旧占位.error === "占位文字", "旧存档里的示例占位文案仍被识别，不能误生成", 卡上输入.旧占位);
  ok(卡上输入.笔记.内容 === "" && 卡上输入.笔记.存的 === "" && 卡上输入.笔记.聚焦 && 卡上输入.镜头.空提示词 && 卡上输入.镜头.空台词 && 卡上输入.镜头.就地输入, "笔记、镜头初值为空，添加后直接输入，不用先删示例文字", 卡上输入);

  console.log("\n— 五十三、批量参考、复制不丢关系、批量整理和删除只保存一次 —");
  const 批量体验 = await run(`
    (async () => {
      ${摆画布([卡片("r1", "image", { title: "人物参考", path: "ref-a.png" }, 40, 40), 卡片("r2", "image", { title: "光线参考", path: "ref-b.png" }, 500, 300)])}
      canvasSetSelection(["r1", "r2"]); canvasHistoryReset(canvasSnapshot());
      canvasConnectReferences("__new__");
      const target = canvasSelectedNode(), id = target.id;
      const 连好 = { 个数: canvasState.graph.getElements().length, 输入: canvasUpstreamImages(target), 聚焦: document.activeElement === canvasWireRoot(id).querySelector("textarea"), 提示词: canvasPayload(target).prompt };
      target.set("canvasPayload", { ...canvasPayload(target), prompt: "同一个人物，柔和侧光", model: "指定图模型", pending_jobs: { image: { id: "原任务" } }, generation_runs: [{ output: "原结果.png" }] });
      canvasPersist(); canvasHistoryFlush();
      const copies = canvasDuplicateSelection(target), copy = copies[0], cp = canvasPayload(copy);
      const 复制 = { 输入: canvasUpstreamImages(copy), 提示词: cp.prompt, 型号: cp.model, 无旧任务: !cp.pending_jobs && !cp.generation_runs, 未串绑: !cp.board && !cp.sourceId };
      canvasSetSelection(["r1", "r2"]); canvasArrangeSelection("left");
      const 整理 = canvasState.graph.getCell("r1").position().x === canvasState.graph.getCell("r2").position().x;
      canvasHistoryFlush(); canvasUndo();
      const 撤销整理 = canvasState.graph.getCell("r1").position().x !== canvasState.graph.getCell("r2").position().x;
      canvasSetSelection(["r1", "r2"]); canvasHistoryReset(canvasSnapshot());
      let writes = 0; const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key === canvasStorageKey()) writes++; return original.call(this, key, value); };
      try { canvasDeleteSelection(); } finally { Storage.prototype.setItem = original; }
      const 删除 = { 次数: writes, 源卡没了: !canvasState.graph.getCell("r1") && !canvasState.graph.getCell("r2") };
      canvasUndo();
      删除.撤回 = !!canvasState.graph.getCell("r1") && !!canvasState.graph.getCell("r2") && canvasUpstreamImages(canvasState.graph.getCell(id)).length === 2;
      await canvasFlushRemoteWrite(); return { 连好, 复制, 整理, 撤销整理, 删除 };
    })()`);
  ok(批量体验.连好.个数 === 3 && 批量体验.连好.输入.length === 2 && 批量体验.连好.聚焦 && 批量体验.连好.提示词 === "", "多张素材一次连进新图片节点，只聚焦输入，不自动生成", 批量体验.连好);
  ok(同(批量体验.复制.输入, 批量体验.连好.输入) && 批量体验.复制.提示词 === "同一个人物，柔和侧光" && 批量体验.复制.型号 === "指定图模型" && 批量体验.复制.无旧任务 && 批量体验.复制.未串绑, "复制保留模型、提示词、上游参考，不继承旧任务或分镜绑定", 批量体验.复制);
  ok(批量体验.整理 && 批量体验.撤销整理, "多选左对齐可用，一次撤销还原各自位置", 批量体验);
  ok(批量体验.删除.次数 === 1 && 批量体验.删除.源卡没了 && 批量体验.删除.撤回, "批量删除只写一次本机快照，撤销同时恢复节点和连线", 批量体验.删除);

  console.log("\n— 五十四、大画布增量同步、滚轮合帧与小地图 —");
  const 大图 = Array.from({ length: 160 }, (_, i) => 卡片("perf" + i, "note", { title: "节点 " + i, text: "内容 " + i }, (i % 16) * 400, Math.floor(i / 16) * 300));
  const 性能体验 = await run(`
    (async () => {
      ${摆画布(大图)}
      const page = document.getElementById("assist-page"), graph = canvasState.graph, paper = canvasState.paper;
      const roots = new Map(graph.getElements().map((node) => [node.id, canvasWireRoot(node.id).firstElementChild]));
      const snap = canvasSnapshot(); snap.nodes[80].payload = { ...snap.nodes[80].payload, text: "只改这一张" };
      let refreshes = 0; const refresh = window.canvasRefreshNode;
      window.canvasRefreshNode = (...args) => { refreshes++; return refresh(...args); };
      const start = performance.now();
      try { canvasApplySnapshot(snap, { fromRemote: true }); } finally { window.canvasRefreshNode = refresh; }
      const 同步 = { 耗时: performance.now() - start, 重画: refreshes, 保留: graph.getElements().filter((node) => canvasWireRoot(node.id).firstElementChild === roots.get(node.id)).length, 改到了: canvasPayload(graph.getCell("perf80")).text };
      canvasZoom(page, .6); canvasState.x = 0; canvasState.y = 0; paper.translate(0, 0);
      let transforms = 0; const translate = paper.translate;
      paper.translate = function(...args) { if (args.length) transforms++; return translate.apply(this, args); };
      const world = page.querySelector("#canvas-world");
      for (let i = 0; i < 120; i++) world.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 1, deltaY: 2, clientX: 600, clientY: 300 }));
      const 帧前 = transforms; await new Promise(requestAnimationFrame); paper.translate = translate;
      const 滚动 = { 帧前, 变换: transforms, x: canvasState.x, y: canvasState.y };
      page.querySelector("[data-canvas-minimap]").click(); await new Promise(requestAnimationFrame);
      const map = canvasState.minimap, before = canvasState.x;
      const r = map.svg.getBoundingClientRect();
      // 使用真实坐标换算，跳转不依赖小地图当前的缩放比例。
      const point = new DOMPoint(r.left + r.width * .8, r.top + r.height * .5).matrixTransform(map.svg.getScreenCTM().inverse());
      const pointer = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: r.left + r.width * .8, clientY: r.top + r.height * .5 });
      // 合成指针没有活跃硬件 id；只替换 capture，不替换导航计算。
      const capture = map.svg.setPointerCapture; map.svg.setPointerCapture = () => {};
      try { map.svg.dispatchEvent(pointer); } finally { map.svg.setPointerCapture = capture; }
      const area = canvasViewportArea(page), mr = map.el.getBoundingClientRect();
      const 导航 = { 显示: !map.el.hidden, 正确图层: map.nodes.ownerSVGElement === map.svg && map.svg.viewBox.baseVal.width > 0, 不被遮住: mr.bottom <= area.top + area.height + 1 && mr.top >= area.top, 轮廓: map.nodes.children.length, 移了: before !== canvasState.x, 准确: Math.abs(canvasState.x - (area.offsetX + area.width / 2 - point.x * canvasState.scale)) < .1 };
      map.el.querySelector("button").click(); 导航.可关闭 = map.el.hidden;
      await canvasFlushRemoteWrite(); return { 同步, 滚动, 导航 };
    })()`);
  ok(性能体验.同步.重画 === 1 && 性能体验.同步.保留 === 159 && 性能体验.同步.改到了 === "只改这一张", "160 节点只改一张：仅重画一张，另外 159 张卡片 DOM 保留", 性能体验.同步);
  ok(性能体验.滚动.帧前 === 0 && 性能体验.滚动.变换 === 1 && 性能体验.滚动.x === -120 && 性能体验.滚动.y === -240, "120 个滚轮事件一帧只改一次 SVG，累计位移完整保留", 性能体验.滚动);
  ok(性能体验.导航.显示 && 性能体验.导航.正确图层 && 性能体验.导航.不被遮住 && 性能体验.导航.轮廓 === 160 && 性能体验.导航.移了 && 性能体验.导航.准确 && 性能体验.导航.可关闭, "小地图按需打开，展示全部轮廓，点击准确跳转并可关闭；不被底部对话框遮住", 性能体验.导航);
  console.log("  增量同步测量（本机 Chromium，160 张笔记卡）:", JSON.stringify(性能体验.同步));

  console.log("\n— 五十五、通用创作入口、卡片参数、参考输入、结果衔接与版本对比 —");
  const 流程 = await run(`(async () => {
    ${摆画布([])}
    const page = document.getElementById("assist-page");
    const start = { 空: canvasState.graph.getElements().length === 0, 起步: !page.querySelector("#canvas-start").hidden, 收起: page.querySelector(".canvas-chat-body").hidden, 按钮: getComputedStyle(page.querySelector(".canvas-quick-add")).display };
    const allStarts = page.querySelectorAll("[data-canvas-start]");
    page.querySelector('[data-canvas-start="image"]').click();
    const added = canvasSelectedNode(), addedRoot = canvasWireRoot(added.id);
    start.添加 = canvasKind(added) === "image" && document.activeElement === addedRoot.querySelector("textarea") && page.querySelector("#canvas-start").hidden;
    const prompt = addedRoot.querySelector("textarea"); prompt.value = "海边灯塔，柔和夕阳"; prompt.dispatchEvent(new Event("input", { bubbles: true })); prompt.setSelectionRange(3, 6);
    canvasRefreshNode(added);
    const rebuilt = canvasWireRoot(added.id).querySelector("textarea");
    start.光标 = document.activeElement === rebuilt && rebuilt.selectionStart === 3 && rebuilt.selectionEnd === 6 && rebuilt.value === "海边灯塔，柔和夕阳";
    page.querySelector("[data-canvas-chat-open]").click(); start.展开 = !page.querySelector(".canvas-chat-body").hidden; page.querySelector("[data-canvas-chat-toggle]").click(); start.再收起 = page.querySelector(".canvas-chat-body").hidden;
    const model = canvasWireRoot(added.id).querySelector('[data-canvas-card-key="model"]'); model.add(new Option("指定图模型", "image-test")); model.value = "image-test"; model.dispatchEvent(new Event("change", { bubbles: true }));
    const size = canvasWireRoot(added.id).querySelector('[data-canvas-card-key="size"]'); size.value = "1536x1024"; size.dispatchEvent(new Event("change", { bubbles: true }));
    const advanced = canvasWireRoot(added.id).querySelector(".canvas-card-advanced"); start.高级默认收起 = !advanced.open;
    window.__runs = []; window.__bodies = []; window.__failRun = null; window.__dropRun = null; window.__holdRun = null; window.__echoName = true;
    await canvasGenerate(added, "image");
    const sentImage = window.__bodies.find((b) => b.url === "/api/tool/run").body.input;
    const gen = { 估价尺寸: canvasEstimateItem(added, "image").input.size, 型号: sentImage.model, 尺寸: sentImage.size, 内容: sentImage.prompt, 数量: canvasState.graph.getElements().length };
    canvasCreateFromResult(added, "video"); const video = canvasSelectedNode();
    const next = { 原图: canvasMediaPath(canvasPayload(added)), 空: canvasPayload(video).prompt === "", 聚焦: document.activeElement === canvasWireRoot(video.id).querySelector("textarea"), 输入: canvasUpstreamInputs(video).map((i) => i.relation), 未跑: window.__runs.length === 1 };
    const last = canvasAddNode("image", { title: "尾帧素材", path: "end.png" }, undefined, { skipSelect: true });
    canvasAddCardReference(video, last);
    const videoRoot = canvasWireRoot(video.id), vp = videoRoot.querySelector("textarea"); vp.value = "镜头缓慢推进"; vp.dispatchEvent(new Event("input", { bubbles: true }));
    for (const [key, value] of [["duration", "10s"], ["aspect_ratio", "9:16"], ["resolution", "720p"]]) { const field = videoRoot.querySelector('[data-canvas-card-key="' + key + '"]'); field.value = value; field.dispatchEvent(new Event("change", { bubbles: true })); }
    window.__bodies = []; await canvasGenerate(video, "video");
    const sentVideo = window.__bodies.find((b) => b.url === "/api/tool/run").body.input;
    gen.视频 = { 首帧: sentVideo.first_frame, 尾帧: sentVideo.last_frame, 时长: sentVideo.duration, 画幅: sentVideo.aspect_ratio, 分辨率: sentVideo.resolution };
    const root = canvasWireRoot(video.id), refs = root.querySelectorAll("[data-canvas-card-disconnect]");
    const disconnect = refs[0].dataset.canvasCardDisconnect; root.querySelector('[data-canvas-card-disconnect="' + disconnect + '"]').click();
    next.移除 = canvasUpstreamInputs(video).length === 1 && canvasWireRoot(video.id).querySelectorAll("[data-canvas-card-disconnect]").length === 1;
    canvasHistoryFlush(); canvasUndo(); next.撤销移除 = canvasUpstreamInputs(canvasState.graph.getCell(video.id)).length === 2;
    const liveImage = canvasState.graph.getCell(added.id);
    liveImage.set("canvasPayload", { ...canvasPayload(liveImage), generation_runs: [{ kind: "image", output: "old_v1.png", version: 1 }, { kind: "image", output: "new_v2.png", version: 2 }], path: "new_v2.png", url: "new_v2.png", first_frame: "new_v2.png" });
    canvasRefreshNode(liveImage); canvasCompareVersions(liveImage);
    const compare = document.querySelector(".canvas-compare"); const version = { 打开: !!compare, 两列: compare?.querySelectorAll("section").length };
    compare?.querySelector("[data-compare-close]").click(); version.关闭 = !document.querySelector(".canvas-compare");
    await canvasUseVersion(liveImage.id, "image", "old_v1.png"); version.路径 = canvasMediaPath(canvasPayload(liveImage));
    canvasSetSelection([video.id]); await Promise.resolve();
    version.素材收紧 = getComputedStyle(canvasWireRoot(liveImage.id).querySelector(".canvas-card-editor")).display === "none";
    canvasSetSelection([liveImage.id]); await Promise.resolve(); version.选中可改 = getComputedStyle(canvasWireRoot(liveImage.id).querySelector(".canvas-card-editor")).display !== "none";
    await canvasFlushRemoteWrite(); return { start, gen, next, version };
  })()`);
  ok(流程.start.空 && 流程.start.起步 && 流程.start.收起 && ["flex", "inline-flex"].includes(流程.start.按钮), "空画布显示创作入口和有样式的常用工具，Agent 默认收起", 流程.start);
  ok(流程.start.添加 && 流程.start.光标, "从入口创建图片立即写提示词，卡片重画保留文字和光标选择", 流程.start);
  ok(流程.start.展开 && 流程.start.再收起 && 流程.start.高级默认收起, "Agent 按需展开，高级参数默认收起，不占满主工作区", 流程.start);
  ok(流程.gen.型号 === "image-test" && 流程.gen.尺寸 === "1536x1024" && 流程.gen.估价尺寸 === 流程.gen.尺寸 && 流程.gen.内容 === "海边灯塔，柔和夕阳" && 流程.gen.数量 === 1, "卡上模型与尺寸真正进入生成请求，结果留在原卡上", 流程.gen);
  ok(流程.next.空 && 流程.next.聚焦 && 流程.next.未跑 && 流程.next.输入[0] === "first_frame", "从图片继续做视频：自动接好首帧，聚焦新描述，不自动扣费", 流程.next);
  ok(流程.gen.视频.首帧 === 流程.next.原图 && 流程.gen.视频.尾帧 === "end.png" && 流程.gen.视频.时长 === "10s" && 流程.gen.视频.画幅 === "9:16" && 流程.gen.视频.分辨率 === "720p", "两张图片自动分配首尾帧，卡上时长、画幅和分辨率照实发送", 流程.gen.视频);
  ok(流程.next.移除 && 流程.next.撤销移除, "在卡片移除参考立即更新，撤销恢复对应连线", 流程.next);
  ok(流程.version.打开 && 流程.version.两列 === 2 && 流程.version.关闭 && 流程.version.路径 === "old_v1.png", "生成版本可并排对比，切换版本更新真正展示的文件路径", 流程.version);
  ok(流程.version.素材收紧 && 流程.version.选中可改, "已有素材不选中时收紧成预览卡，选中后原地编辑", 流程.version);

  const 语言 = await run(`(async () => { const node = canvasSelectedNode(), text = canvasPayload(node).prompt; I18N.setLang("en"); await new Promise(requestAnimationFrame); const root = canvasWireRoot(node.id), english = /Generate/.test(root.querySelector("[data-canvas-generate]").textContent), same = root.querySelector("textarea").value === text; I18N.setLang("zh"); return { english, same }; })()`);
  ok(语言.english && 语言.same, "切换语言会更新 SVG 卡片内的操作文字，用户提示词保持原文", 语言);

  const 简化 = await run(`(async () => {
    ${摆画布([])}
    canvasState.cardDefaults = null;
    const first = canvasAddNode("image");
    const model = canvasWireRoot(first.id).querySelector('[data-canvas-card-key="model"]');
    model.add(new Option("常用图模型", "usual-image")); model.value = "usual-image"; model.dispatchEvent(new Event("change", { bubbles: true }));
    const second = canvasAddNode("image");
    const remembered = canvasPayload(second).model === "usual-image" && canvasPayload(second).prompt === "";
    const wrongVideo = canvasAddNode("video", { prompt: "画面渐变", last_frame: "only-last.png" });
    window.__bodies = []; const rejected = await canvasGenerate(wrongVideo, "video");
    const planned = canvasAddNode("video", { prompt: "镜头推进" }); canvasConnect(second, planned, "first_frame");
    const plannedResult = await canvasGenerate(planned, "video");
    const frame = !plannedResult.ok && plannedResult.error === "缺首帧" && !rejected.ok && rejected.error === "缺首帧" && !window.__bodies.some((b) => b.url === "/api/tool/run");
    const before = canvasState.graph.getElements().length; canvasCreateDramaWorkflow();
    const script = canvasSelectedNode(), nodes = canvasState.graph.getElements();
    const drama = nodes.length === before + 3 && canvasKind(script) === "script" && canvasPayload(script).text === "" && !nodes.some((n) => ["character", "location"].includes(canvasKind(n))) && canvasState.inlineEdit?.nodeId === script.id;
    canvasInlineCancel(); await canvasFlushRemoteWrite(); return { remembered, frame, drama };
  })()`);
  ok(简化.remembered && 简化.frame && 简化.drama, "新卡沿用最近模型但不带旧提示词；尾帧不能单独发单；短剧先写剧本，无需手填角色", 简化);

  const 图片群 = Array.from({ length: 120 }, (_, i) => 卡片("imgperf" + i, "image", { title: "图片 " + i, prompt: "待创作 " + i }, i % 12 * 400, Math.floor(i / 12) * 450));
  const 卡片开销 = await run(`(async () => {
    let scans = 0; const original = window.canvasCardReferenceCandidates;
    window.canvasCardReferenceCandidates = (...args) => { scans++; return original(...args); };
    try {
      ${摆画布(图片群)}
      const before = scans, graph = canvasState.graph;
      const roots = graph.getElements().map((node) => canvasWireRoot(node.id).firstElementChild);
      const snap = canvasSnapshot(); snap.nodes[50].payload.prompt = "只更新一张图片卡";
      canvasApplySnapshot(snap, { fromRemote: true });
      const kept = graph.getElements().filter((node, i) => canvasWireRoot(node.id).firstElementChild === roots[i]).length;
      const select = canvasWireRoot("imgperf50").querySelector("[data-canvas-card-reference]"); select.dispatchEvent(new Event("focus"));
      return { before, after: scans, kept, options: select.options.length };
    } finally { window.canvasCardReferenceCandidates = original; }
  })()`);
  ok(卡片开销.before === 0 && 卡片开销.after === 1 && 卡片开销.kept === 119 && 卡片开销.options === 120, "120 张生成卡加载不逐卡扫描参考候选；展开一次才计算一次，单卡更新保留其他 119 张 DOM", 卡片开销);

  await run(`document.querySelector(".input-wrap").style.display = "none"; chatCol.classList.add("wide-page"); document.getElementById("chat-scroll").scrollTop = 0; true`);
  const 尺寸前 = win.getSize(); win.setSize(940, 900);
  const 窄窗 = await run(`(async () => { ${摆画布([])} await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); const p = document.getElementById("assist-page"), v = p.querySelector("#canvas-viewport").getBoundingClientRect(), tools = p.querySelector(".canvas-tool-cluster").getBoundingClientRect(), head = p.querySelector(".canvas-head").getBoundingClientRect(); return { 不溢出: tools.right <= v.right && tools.left >= v.left, 不遮挡: tools.top >= head.bottom, 有样式: getComputedStyle(p.querySelector(".canvas-quick-add")).borderTopStyle === "none" }; })()`);
  ok(窄窗.不溢出 && 窄窗.不遮挡 && 窄窗.有样式, "窄窗口按实际画布宽度收起工具文字，工具栏不溢出、不遮挡顶部项目操作", 窄窗);
  await saveScreenshot("-narrow");
  win.setSize(...尺寸前);

  if (process.env.CANVAS_SCREENSHOT) {
    await run(`document.querySelector(".input-wrap").style.display = "none"; chatCol.classList.add("wide-page"); document.getElementById("chat-scroll").scrollTop = 0; true`);
    await run(`(async () => { ${摆画布([卡片("demo1", "image", { title: "人物参考", prompt: "人物穿浅色外套，柔和日光" }, 40, 60), 卡片("demo2", "image", { title: "场景参考", prompt: "傍晚海边，远处灯塔" }, 430, 60), 卡片("demo3", "image", { title: "新画面", prompt: "保持同一个人物，在海边回头，电影感构图" }, 820, 60)], [{ source: { id: "demo1" }, target: { id: "demo3" }, relation: "reference" }, { source: { id: "demo2" }, target: { id: "demo3" }, relation: "reference" }])} canvasFitAll(document.getElementById("assist-page")); if (!canvasState.minimapOpen) document.querySelector("[data-canvas-minimap]").click(); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); await new Promise((r) => setTimeout(r, 60)); })()`);
    await saveScreenshot();
    await run(`document.documentElement.dataset.theme = "dark"; I18N.setLang("en"); true`);
    await new Promise((done) => setTimeout(done, 160)); await saveScreenshot("-dark-en");
    await run(`(async () => { I18N.setLang("zh"); document.documentElement.dataset.theme = "light"; ${摆画布([])} document.getElementById("owb-toast")?.classList.remove("show"); const select = document.querySelector("[data-canvas-workspace-select]"); if (select) select.innerHTML = '<option value="jia">示例项目</option>'; document.querySelector("[data-canvas-board-select]").innerHTML = '<option value="main">主画布</option>'; canvasState.minimap.el.hidden = true; canvasState.minimapOpen = false; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); })()`);
    await saveScreenshot("-start");
  }
}

module.exports = { canvasFixture, canvasNodeFixture, runCanvasExperience };
