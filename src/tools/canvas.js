"use strict";
/**
 * 画布状态：存哪、读写、规整、备份轮转，外加 agent 手里的 canvas 工具（canvasManage）。
 *
 * 从 tools.js 整段搬过来的，函数体一个字没动。tools.js 还是门面，导出的名字一个不少。
 * 画布文件落在当前工作目录下，ws() 由 tools.js 加载时经 bindWorkspace 递过来（为什么不反过来 require，见 media.js 开头）。
 */

const fs = require("fs");
const path = require("path");

let wsRoot = null;
function bindWorkspace(root) {
  wsRoot = root;
}
function ws() {
  if (!wsRoot) throw new Error("src/tools/canvas.js 还没接上工作目录，要经 tools.js 加载");
  return wsRoot();
}

const CANVAS_KINDS = new Set(["note", "script", "agent", "character", "location", "storyboard", "scene", "shot", "image", "video", "audio", "timeline"]);
// 连线不是纯视觉箭头：用途会进入生成请求、Trace 与下一次 Agent 会话。
// 白名单既让旧画布兼容，也避免把任意对象原样写进项目状态。
const CANVAS_EDGE_RELATIONS = new Set(["input", "split", "generate", "character", "background", "composition", "motion", "style", "prop", "continuity", "first_frame", "last_frame", "audio", "reference"]);
const CANVAS_MAX_NODES = 500;
const CANVAS_MAX_EDGES = 1200;

function canvasSafeName(value) {
  const name = String(value || "main").trim();
  // 字符类里是 \0（真 NUL）。以前写成 \\0，匹配的是反斜杠和字符「0」——
  // 于是「第10集」「2024版」这种名字全被判不合法、悄悄回落成 main，新建画布就等于拿空画布盖主画布
  if (!name || name === "." || name === ".." || name.length > 80 || /[\\/\0]/.test(name)) return "main";
  return name;
}
function canvasCurrentPath() { return path.join(ws(), ".openworkbuddy", "canvas-current.json"); }
function canvasCurrentName() {
  try { return canvasSafeName(JSON.parse(fs.readFileSync(canvasCurrentPath(), "utf8")).name); } catch { return "main"; }
}
function canvasSetCurrentName(name) {
  const dir = path.dirname(canvasCurrentPath()); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(canvasCurrentPath(), JSON.stringify({ name: canvasSafeName(name), updatedAt: Date.now() }), "utf8"); return canvasSafeName(name);
}
function canvasStatePath(name = canvasCurrentName()) {
  const safe = canvasSafeName(name);
  return safe === "main" ? path.join(ws(), ".openworkbuddy", "canvas.json") : path.join(ws(), ".openworkbuddy", "canvases", safe + ".json");
}
function canvasEmptyState() { return { version: 1, nodes: [], edges: [], updatedAt: 0 }; }
/**
 * 规整画布状态 —— 这一层只管「把形状理顺」，不管「这条数据配不配存在」。
 *
 * 以前它兼着当校验器：不认识的节点类型直接扔掉、超过 500 个的节点直接截断。
 * 问题是它同时站在读和写两条路上，于是「读一遍」本身就会掉东西，而界面拖一下节点
 * 就会把读出来的残缺状态原样回存。实测三条路都能把用户的画布吃掉：
 *   · 600 个节点的画布，读出来 500 个，回存之后盘上就真只剩 500 个；
 *   · 老版本写的画布里有这个版本不认识的类型，3 个节点读出来只剩 1 个；
 *   · 文件坏了（写一半断电）读出来是空画布，回存直接把残骸盖成 []。
 * 用户升级完打开画布发现东西没了，就是这么没的。
 *
 * 所以规矩改成：**序列化不许挑食，校验挪到真正新建数据的地方**（add 那边本来就查
 * CANVAS_KINDS，connect 那边本来就查 CANVAS_EDGE_RELATIONS，那才是该拦的地方）。
 * 这里只做三件不会丢东西的事：补全缺的字段、把类型强制成字符串/数字、去掉挂空的连线。
 *
 * lost 传个对象进来就能拿到「这一趟少了什么」的账，界面据此提醒用户，而不是默默抹掉。
 */
function canvasNormalizeState(value, lost = null) {
  const raw = value && typeof value === "object" ? value : {};
  const note = (k, n) => { if (lost && n > 0) lost[k] = (lost[k] || 0) + n; };
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  // 连 id 都没有的才丢——没有 id 的节点没法引用、没法连线，留着也指不到它
  const usable = rawNodes.filter((node) => node && node.id);
  note("noId", rawNodes.length - usable.length);
  const nodes = usable.map((node) => ({
    // kind 照原样留着，哪怕这个版本不认识：可能是老版本建的，也可能是用户装了别的版本。
    // 认不出来就在界面上画成一张「这个版本不认识的节点」的占位卡，绝不替用户删。
    // 只掐长度，免得有人往里塞一整篇文章当类型名
    id: String(node.id), kind: String(node.kind || "note").slice(0, 40),
    payload: node.payload && typeof node.payload === "object" ? node.payload : {},
    position: { x: Number(node.position && node.position.x) || 0, y: Number(node.position && node.position.y) || 0 },
    size: node.size && typeof node.size === "object" ? { width: Number(node.size.width) || undefined, height: Number(node.size.height) || undefined } : undefined,
  }));
  // 超上限只记账、不截断。上限该拦的是「再往里加」（见 add），不是「你已经有的」——
  // 一张叫「无限画布」的东西，打开自己的旧文件反而被删到 500 个，说不过去
  note("overflowNodes", Math.max(0, nodes.length - CANVAS_MAX_NODES));
  const ids = new Set(nodes.map((node) => node.id));
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  // 连线两头必须都还在，且不能自己连自己——这条是真的完整性，留着也画不出来
  const liveEdges = rawEdges.filter((edge) => edge && ids.has(edge.source?.id || edge.source) && ids.has(edge.target?.id || edge.target) && (edge.source?.id || edge.source) !== (edge.target?.id || edge.target));
  note("danglingEdges", rawEdges.length - liveEdges.length);
  note("overflowEdges", Math.max(0, liveEdges.length - CANVAS_MAX_EDGES));
  const edges = liveEdges.map((edge) => {
    // 用途同理：不认识的照留，别把用户标好的关系悄悄抹成一根没名字的线
    const relation = String(edge.relation || edge.role || "").slice(0, 40);
    return { source: { id: String(edge.source?.id || edge.source) }, target: { id: String(edge.target?.id || edge.target) }, ...(relation ? { relation } : {}) };
  });
  // 版本号照原样留着：版本 2 说明这份文件把连线记全了，界面据此判断「没有连线」是真的没有，
  // 还是这份文件老到没存过。在这儿统一抹成 1，用户删掉的连线会被当成「老文件缺了一段」补回来
  return { version: Number(raw.version) >= 2 ? 2 : 1, nodes, edges, updatedAt: Number(raw.updatedAt) || 0 };
}
/** 把一份读不动的画布文件原样挪到一边，绝不在它上面写东西。返回备份路径。 */
function canvasBackup(file, why) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bak = `${file}.${why}-${stamp}.bak`;
  try { fs.copyFileSync(file, bak); return bak; } catch { return ""; }
}
/**
 * 读画布。
 *
 * 「文件不存在」和「文件读不出来」是两件完全不同的事，以前一个 catch 全吞了，
 * 两种都当空画布返回。后一种返回空画布是会要命的：界面显示一张白板，用户在白板上
 * 随便动一下，自动保存就把真文件盖成空的。所以现在只有 ENOENT 才算空画布，
 * 其余一律抛出来，让界面显示「读不出来」而不是「是空的」。
 */
function canvasReadState(name = canvasCurrentName(), lost = null) {
  const file = canvasStatePath(name);
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e.code === "ENOENT") return canvasEmptyState();   // 还没建过——这才是真的空画布
    throw new Error(`画布文件读不出来（${file}）：${e.message}。没有当成空画布，免得下一次保存把它盖掉。`);
  }
  try { return canvasNormalizeState(JSON.parse(text), lost); } catch (e) {
    const bak = canvasBackup(file, "坏了");
    throw new Error(`画布文件不是完整的 JSON，多半是上次写到一半断了（${file}）：${e.message}。` +
      (bak ? `原文件已原样备份到 ${path.basename(bak)}，一个字节都没动。` : "备份也没做成，请先手动把这个文件复制一份再说。"));
  }
}
function canvasWriteState(value, name = canvasCurrentName(), { pristine = false } = {}) {
  // pristine：刚建出来的空画布，updatedAt 留 0，意思是「还没人动过」。界面靠这个决定要不要铺
  // 起手那两张卡——这里要是盖上时间戳，用户自己清空的画布就跟新建的一模一样了
  const state = canvasNormalizeState(value); state.updatedAt = pristine ? 0 : Date.now();
  const active = canvasSetCurrentName(name), file = canvasStatePath(active), dir = path.dirname(file), tmp = file + "." + process.pid + ".tmp";
  fs.mkdirSync(dir, { recursive: true });
  // 改名之前先 fsync：不落盘就改名，断电后盘上可能是一个改过名的 0 字节文件
  const fd = fs.openSync(tmp, "w");
  try { fs.writeFileSync(fd, JSON.stringify(state, null, 2), "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  canvasRotateBackups(file);
  fs.renameSync(tmp, file);
  return state;
}
/**
 * 覆盖之前把上几版往后挪：.bak → .bak.1 → .bak.2，最老的那份掉出去。文件数封顶，不会越攒越多。
 *
 * 以前只留一代。可「刚才那一下把画布搞没了」之后，界面往往又自动存了一两回，
 * 那一代 .bak 早被空画布顶掉了。画布是用户一笔一笔摆出来的，没有回收站，出事就是白干。
 * 正本自己读不出来（0 字节 / 半截 JSON）时不轮转：把残骸挪进 .bak，等于拿它顶掉一份好的
 */
const CANVAS_BAK_KEEP = 3;
function canvasRotateBackups(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }   // 第一次写，没有旧版
  try { JSON.parse(text); } catch { return; }
  const gen = (i) => (i ? `${file}.bak.${i}` : `${file}.bak`);
  for (let i = CANVAS_BAK_KEEP - 1; i > 0; i--) { try { fs.renameSync(gen(i - 1), gen(i)); } catch {} }
  try { fs.writeFileSync(gen(0), text, "utf8"); } catch {}
}
function canvasList() {
  const dir = path.join(ws(), ".openworkbuddy", "canvases"), out = [], add = (name, file) => {
    let stat = null, state = canvasEmptyState(), broken = "";
    try { stat = fs.statSync(file); } catch {}
    // 读不出来的画布在列表里要显出来是「读不出来」，不能显示成「0 个节点」——
    // 后者看着就像一张空画布，用户会直接点进去开始画，然后把它盖掉
    try { state = canvasReadState(name); } catch (e) { broken = e.message; }
    out.push({ name, title: name === "main" ? "主画布" : name, nodes: state.nodes.length, updatedAt: state.updatedAt || (stat ? stat.mtimeMs : 0), ...(broken ? { broken } : {}) });
  };
  const legacy = path.join(ws(), ".openworkbuddy", "canvas.json"); if (fs.existsSync(legacy)) add("main", legacy);
  try { fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => { if (entry.isFile() && /\.json$/i.test(entry.name)) add(entry.name.replace(/\.json$/i, ""), path.join(dir, entry.name)); }); } catch {}
  if (!out.length) out.push({ name: "main", title: "主画布", nodes: 0, updatedAt: 0 });
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function canvasManage(input = {}) {
  const op = String(input.operation || "get");
  const canvasName = canvasSafeName(input.canvas_name || canvasCurrentName());
  if (op === "list") return { content: JSON.stringify({ current: canvasCurrentName(), canvases: canvasList() }), isError: false };
  // 点名了一张画布、名字却会被 canvasSafeName 改写（带斜杠、超长、「..」）：改写的去向是 main，
  // 照做的话 add/clear 全落在主画布上，agent 还以为自己建了张新的。直说不收
  if (input.canvas_name && canvasSafeName(input.canvas_name) !== String(input.canvas_name).trim()) return { content: `画布名称不合法：${JSON.stringify(String(input.canvas_name).slice(0, 100))}。不能带 / \\ 或 NUL，不能是 . / ..，最长 80 字。换个名字再试。`, isError: true };
  let state;
  // 读不出来要当场告诉 agent，而不是递给它一张空画布——递空的，它会「好心」地
  // 重新建一遍节点，一存就把原文件盖了
  try { state = canvasReadState(canvasName); } catch (e) { return { content: e.message, isError: true }; }
  if (op === "get") return { content: JSON.stringify({ canvas_name: canvasName, version: state.version, updatedAt: state.updatedAt, nodes: state.nodes, edges: state.edges }), isError: false };
  if (op === "clear") { state = canvasWriteState(canvasEmptyState(), canvasName); return { content: `画布 ${canvasName} 已清空（${state.updatedAt}）。`, isError: false }; }
  if (op === "add") {
    const kind = String(input.kind || ""); if (!CANVAS_KINDS.has(kind)) return { content: `不支持的画布节点类型：${kind}`, isError: true };
    const id = String(input.node_id || `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`);
    if (state.nodes.some((node) => node.id === id)) return { content: `节点 id 已存在：${id}`, isError: true };
    // 上限拦在「往里加」这一步。以前是在序列化时截断，等于替用户删已有的节点；
    // 拦在这儿最多是加不进去，一个字节都不会少
    if (state.nodes.length >= CANVAS_MAX_NODES) return { content: `画布 ${canvasName} 已经有 ${state.nodes.length} 个节点，到上限 ${CANVAS_MAX_NODES} 了，加不进去。先删掉些用不上的，或者换一张画布（canvas_name 换个名字就是新的一张）。`, isError: true };
    state.nodes.push({ id, kind, payload: input.payload && typeof input.payload === "object" ? input.payload : {}, position: { x: Number(input.position?.x) || 120 + (state.nodes.length % 4) * 390, y: Number(input.position?.y) || 120 + Math.floor(state.nodes.length / 4) * 300 } });
    state = canvasWriteState(state, canvasName); return { content: `已添加${kind}节点 ${id} 到画布 ${canvasName}。`, isError: false };
  }
  if (op === "update") {
    const node = state.nodes.find((item) => item.id === String(input.node_id || "")); if (!node) return { content: `找不到节点：${input.node_id || "（空）"}`, isError: true };
    if (input.payload && typeof input.payload === "object") node.payload = { ...node.payload, ...input.payload };
    if (input.position && typeof input.position === "object") node.position = { x: Number(input.position.x) || node.position.x, y: Number(input.position.y) || node.position.y };
    state = canvasWriteState(state, canvasName); return { content: `已更新节点 ${node.id}。`, isError: false };
  }
  if (op === "connect") {
    const source = String(input.source_id || ""), target = String(input.target_id || "");
    if (!state.nodes.some((node) => node.id === source) || !state.nodes.some((node) => node.id === target)) return { content: "connect 需要存在的 source_id 和 target_id。", isError: true };
    if (source === target) return { content: "不能把节点连接到自己。", isError: true };
    const relation = String(input.relation || "");
    if (relation && !CANVAS_EDGE_RELATIONS.has(relation)) return { content: `不支持的连线用途：${relation}`, isError: true };
    // 同 add：上限拦在这一步，不在序列化时截断
    if (state.edges.length >= CANVAS_MAX_EDGES) return { content: `画布 ${canvasName} 的连线已经到上限 ${CANVAS_MAX_EDGES} 条了，连不上去。先删掉些用不上的连线。`, isError: true };
    const existing = state.edges.find((edge) => edge.source.id === source && edge.target.id === target);
    if (existing) { if (relation) existing.relation = relation; }
    else state.edges.push({ source: { id: source }, target: { id: target }, ...(relation ? { relation } : {}) });
    state = canvasWriteState(state, canvasName); return { content: `已连接 ${source} → ${target}。`, isError: false };
  }
  if (op === "delete") {
    const id = String(input.node_id || ""), before = state.nodes.length; state.nodes = state.nodes.filter((node) => node.id !== id); state.edges = state.edges.filter((edge) => edge.source.id !== id && edge.target.id !== id);
    if (state.nodes.length === before) return { content: `找不到节点：${id}`, isError: true };
    state = canvasWriteState(state, canvasName); return { content: `已删除节点 ${id} 及其连线。`, isError: false };
  }
  return { content: `不支持的画布操作：${op}`, isError: true };
}

module.exports = {
  bindWorkspace,
  CANVAS_KINDS, CANVAS_EDGE_RELATIONS, CANVAS_MAX_NODES, CANVAS_MAX_EDGES, CANVAS_BAK_KEEP, canvasSafeName,
  canvasCurrentName, canvasSetCurrentName, canvasNormalizeState, canvasBackup, canvasReadState, canvasWriteState,
  canvasList, canvasManage
};
