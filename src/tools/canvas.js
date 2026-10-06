// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
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
 *
 * 光按次数留还不够：界面拖一下就存一次，编辑一两秒三代就冲光了，「上午那一版」早没了。
 * 所以再按时间各留一份：每个小时头一回覆盖时，把被盖掉的那版存成 .每小时-<日期T小时>.bak，
 * 每天头一回存成 .每天-<日期>.bak。各自封顶（24 小时、14 天），最老的掉出去，一张画布最多 41 份
 */
const CANVAS_BAK_KEEP = 3;
const CANVAS_BAK_HOURS = 24;
const CANVAS_BAK_DAYS = 14;
function canvasRotateBackups(file, now = Date.now()) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }   // 第一次写，没有旧版
  try { JSON.parse(text); } catch { return; }
  const gen = (i) => (i ? `${file}.bak.${i}` : `${file}.bak`);
  for (let i = CANVAS_BAK_KEEP - 1; i > 0; i--) { try { fs.renameSync(gen(i - 1), gen(i)); } catch {} }
  try { fs.writeFileSync(gen(0), text, "utf8"); } catch {}
  const stamp = canvasStamp(now);
  canvasKeepPeriodic(file, "每小时", stamp.slice(0, 13), text, CANVAS_BAK_HOURS);
  canvasKeepPeriodic(file, "每天", stamp.slice(0, 10), text, CANVAS_BAK_DAYS);
}
/** 这个时段（slot）还没留过就留一份，然后把同一类里超出 keep 的最老几份删掉。时段写在文件名里，字典序就是时间序 */
function canvasKeepPeriodic(file, tag, slot, text, keep) {
  const dir = path.dirname(file), prefix = `${path.basename(file)}.${tag}-`, own = path.join(dir, `${prefix}${slot}.bak`);
  if (fs.existsSync(own)) return;
  try { fs.writeFileSync(own, text, "utf8"); } catch { return; }
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith(".bak")).sort(); } catch { return; }
  for (const n of names.slice(0, Math.max(0, names.length - keep))) { try { fs.unlinkSync(path.join(dir, n)); } catch {} }
}
/** 本地时间的文件名时间戳：2026-10-06T14-03-22。人看得懂，按字典序排就是按时间排 */
function canvasStamp(ms = Date.now()) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
/** canvasStamp 的反面：认不出来给 0 */
function canvasStampTime(text) {
  const m = /(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)/.exec(String(text || ""));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : 0;
}

/**
 * 画布回收站：删画布不真删，整份挪进 .openworkbuddy/canvas-trash/，文件名是「画布名@删的时间.json」。
 *
 * 以前是 unlink：点错一下「删除当前」，那张画布上几十个镜头的提示词、连线、选好的版本全没了，
 * 唯一的确认框里还写着「节点和连线一并删除」——人看了也只能点。回收站不自动清：一张画布几十 KB，
 * 攒一年也不占地方，自动清掉的那一份偏偏可能就是要找的。
 */
function canvasTrashDir() { return path.join(ws(), ".openworkbuddy", "canvas-trash"); }
const CANVAS_TRASH_RE = /@\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d(?:-\d+)?\.json$/;
/** 把一张画布挪进回收站。返回 { id, name, file, deletedAt }；主画布不收 */
function canvasTrashPut(name, now = Date.now()) {
  const safe = canvasSafeName(name);
  if (safe !== String(name)) throw new Error("画布名称不合法");
  if (safe === "main") throw new Error("主画布不能删除");
  const src = canvasStatePath(safe), dir = canvasTrashDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = canvasStamp(now);
  let id = `${safe}@${stamp}.json`;
  for (let n = 2; fs.existsSync(path.join(dir, id)); n++) id = `${safe}@${stamp}-${n}.json`;
  fs.renameSync(src, path.join(dir, id));
  // 这张画布上没点的待生成清单一起作废：以后再建一张同名的，不能冒出一条上一张的横幅
  canvasProposalDrop(safe);
  // 删的正是 Agent 认的「当前画布」：指回主画布，免得它接着往一张已经不在的画布上写
  if (canvasCurrentName() === safe) canvasSetCurrentName("main");
  return { id, name: safe, file: path.join(dir, id), deletedAt: now };
}
/** 回收站里有什么，新删的在前 */
function canvasTrashList() {
  const dir = canvasTrashDir();
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => CANVAS_TRASH_RE.test(n)); } catch { return []; }
  return names.map((id) => {
    let nodes = 0, broken = "";
    try { nodes = canvasNormalizeState(JSON.parse(fs.readFileSync(path.join(dir, id), "utf8"))).nodes.length; } catch (e) { broken = e.message; }
    return { id, name: id.slice(0, id.lastIndexOf("@")), deletedAt: canvasStampTime(id.slice(id.lastIndexOf("@") + 1)), nodes, path: `.openworkbuddy/canvas-trash/${id}`, ...(broken ? { broken } : {}) };
  }).sort((a, b) => b.deletedAt - a.deletedAt || (a.id < b.id ? 1 : -1));
}
/** 读回收站里的一张（素材台账要看它引用了什么）。读不出来照样抛 */
function canvasTrashRead(id) {
  id = String(id || "");
  if (!CANVAS_TRASH_RE.test(id) || id.includes("/") || id.includes("\\")) throw new Error("回收站里没有这张画布");
  return canvasNormalizeState(JSON.parse(fs.readFileSync(path.join(canvasTrashDir(), id), "utf8")));
}
/**
 * 从回收站拿回来。原名已经被一张新画布占了，就叫 原名_2、原名_3……——两张都在，谁也不盖谁。
 * id 只认回收站里真有的那几个文件名，不拼路径。返回 { name, from }
 */
function canvasTrashRestore(id) {
  id = String(id || "");
  const dir = canvasTrashDir();
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  if (!CANVAS_TRASH_RE.test(id) || !names.includes(id)) throw new Error("回收站里没有这张画布");
  const base = id.slice(0, id.lastIndexOf("@"));
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? base : `${base}_${n}`;
    if (canvasSafeName(name) !== name || name === "main") continue;
    const file = canvasStatePath(name);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.renameSync(path.join(dir, id), file);
    return { name, from: id };
  }
  throw new Error("同名画布太多，换不出空着的名字");
}

/**
 * 快照：Agent 清空画布、或者一口气删一串节点之前，把画布原样存一份，界面上一键放回去。
 *
 * 跟上面的 .bak 不是一回事：.bak 是「上一次写之前的样子」，Agent 删一个节点写一次盘，删六个就把三代 .bak 冲光了，
 * 留下的全是删到一半的样子。快照只在「要开始删」的那一下存：清空前存一份；删节点时，安静了 5 分钟以后的头一下存一份，
 * 接下来连着删的不再存——这一串删完，快照里就是删之前的整张画布。
 * 放回去只「补」：快照里有、现在没有的节点和连线加回来，现在有的一个不动，Agent 删完又加的东西不会被抹掉。
 */
const CANVAS_SNAP_KEEP = 20;
const CANVAS_DELETE_QUIET_MS = 5 * 60 * 1000;
const canvasDeleteSeen = new Map();   // 画布文件 → 上一回 Agent 删节点的时间
function canvasSnapDir(name) { return path.join(ws(), ".openworkbuddy", "canvas-snapshots", canvasSafeName(name)); }
/** 存一份快照。空画布不存（没什么可放回去的）。返回 { id, path } 或 null */
function canvasSnapshotSave(name, why, state, now = Date.now()) {
  if (!state || !Array.isArray(state.nodes) || !state.nodes.length) return null;
  const dir = canvasSnapDir(name), stamp = canvasStamp(now);
  fs.mkdirSync(dir, { recursive: true });
  let id = `${stamp}-${why}.json`;
  for (let n = 2; fs.existsSync(path.join(dir, id)); n++) id = `${stamp}-${n}-${why}.json`;
  fs.writeFileSync(path.join(dir, id), JSON.stringify({ name: canvasSafeName(name), why, at: now, state }), "utf8");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.json$/.test(n)).sort(); } catch {}
  for (const n of names.slice(0, Math.max(0, names.length - CANVAS_SNAP_KEEP))) { try { fs.unlinkSync(path.join(dir, n)); } catch {} }
  return { id, path: `.openworkbuddy/canvas-snapshots/${canvasSafeName(name)}/${id}` };
}
function canvasSnapshotRead(name, id) {
  id = String(id || "");
  const dir = canvasSnapDir(name);
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  if (!/\.json$/.test(id) || !names.includes(id)) throw new Error("没有这份快照");
  const data = JSON.parse(fs.readFileSync(path.join(dir, id), "utf8"));
  return { ...data, state: canvasNormalizeState(data.state) };
}
/** 这张画布的快照，新的在前。missing：快照里有、现在画布上没有的节点数——放回去能补回几个 */
function canvasSnapshotList(name) {
  const dir = canvasSnapDir(name);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.json$/.test(n)).sort().reverse(); } catch { return []; }
  let now = null;
  try { now = new Set(canvasReadState(name).nodes.map((n) => n.id)); } catch {}
  const out = [];
  for (const id of names) {
    try {
      const snap = canvasSnapshotRead(name, id);
      out.push({ id, why: String(snap.why || ""), at: Number(snap.at) || canvasStampTime(id), nodes: snap.state.nodes.length,
        ...(now ? { missing: snap.state.nodes.filter((n) => !now.has(n.id)).length } : {}), path: `.openworkbuddy/canvas-snapshots/${canvasSafeName(name)}/${id}` });
    } catch {}
  }
  return out;
}
/** 把快照里有、现在没有的节点和连线补回去。现在画布读不出来就不动它（canvasReadState 会抛）。返回 { nodes, edges, state } */
function canvasSnapshotRestore(name, id) {
  const snap = canvasSnapshotRead(name, id);
  const state = canvasReadState(name);
  const have = new Set(state.nodes.map((n) => n.id));
  const back = snap.state.nodes.filter((n) => !have.has(n.id));
  state.nodes.push(...back);
  back.forEach((n) => have.add(n.id));
  const edgeKey = (e) => `${e.source.id}\n${e.target.id}`;
  const edges = new Set(state.edges.map(edgeKey));
  const backEdges = snap.state.edges.filter((e) => have.has(e.source.id) && have.has(e.target.id) && !edges.has(edgeKey(e)));
  state.edges.push(...backEdges);
  // 清空过的画布是版本 1 的空壳：放回来的连线要按版本 2 存，不然界面会当成「老文件没存连线」
  state.version = 2;
  const saved = back.length || backEdges.length ? canvasWriteState(state, name) : state;
  return { nodes: back.length, edges: backEdges.length, state: saved };
}
/** Agent 删节点前：安静了一阵之后的头一下存快照，连着删的不再存 */
function canvasSnapshotBeforeDelete(name, state, now = Date.now()) {
  const key = canvasStatePath(name), last = canvasDeleteSeen.get(key) || 0;
  canvasDeleteSeen.set(key, now);
  if (now - last < CANVAS_DELETE_QUIET_MS) return null;
  try { return canvasSnapshotSave(name, "删节点前", state, now); } catch { return null; }
}
/**
 * 画布任务里的 Agent 不自己花钱：先交清单，用户点「开跑」才生成。
 *
 * 画布右栏发出去的对话，会话号是 s_canvas_ 开头（public/js/app-07-canvas-generate.js canvasTaskSessionId）。
 * 以前提示词写着「需要时直接调用」生成工具：Agent 一句话就能连发十几单，没报价、不带任务号，
 * 断线了也不知道哪单收过——画布按钮那条路上的扣费确认、台账、版本号它一样都不过。
 * 现在这类会话里这三个工具一律拦下（tools.js executeToolCore；借给本机引擎的那份也摘掉，见 agent.js runViaEngine），
 * Agent 改用 propose 交一份「哪几个节点、生什么」的清单，画布摆成横幅，用户点「开跑」走画布自己那条路。
 */
const CANVAS_QUOTE_FIRST = ["generate_image", "generate_video", "text_to_speech"];
function canvasSessionOf(sessionId) { return /^s_canvas_/.test(String(sessionId || "")); }
// 拦下时回给模型的话：说清该怎么走，它照着改就是，不会原样再撞一次
const CANVAS_QUOTE_FIRST_NOTE = "请先报价：画布任务里不直接生成，这一单没发出去，也没扣费。" +
  "先用 canvas_manage 的 update 把提示词（要指定型号就写 payload.model）写进节点，再用 operation \"propose\" 交待生成清单" +
  "（items: [{node_id, kind: image|video|audio}]）。画布上会摆出清单、型号和报价，用户点「开跑」才生成、扣费。";

// 每类节点能生什么：跟画布上的生成按钮一致（canvasGenerate）。图：镜头首帧、图片、定妆照、场景图；视频：镜头、视频；配音：镜头、音频
const CANVAS_PROPOSE_KINDS = { image: ["shot", "image", "character", "location"], video: ["shot", "video"], audio: ["shot", "audio"] };
const CANVAS_PROPOSE_MAX = 60;
/** 每张画布至多一份待开跑的清单，住在画布文件旁边；新交的顶掉旧的 */
function canvasProposalPath(name) { return path.join(ws(), ".openworkbuddy", "canvas-proposals", canvasSafeName(name) + ".json"); }
function canvasProposalRead(name) {
  try {
    const p = JSON.parse(fs.readFileSync(canvasProposalPath(name), "utf8"));
    return p && p.id && Array.isArray(p.items) && p.items.length ? p : null;
  } catch { return null; }
}
/** 收掉一份清单（用户点了「开跑」或「不要」）。带 id 时只收那一份：点的是旧横幅，不能把 Agent 刚交的新清单一起扔了 */
function canvasProposalDrop(name, id) {
  const cur = canvasProposalRead(name);
  if (!cur || (id && cur.id !== String(id))) return false;
  try { fs.unlinkSync(canvasProposalPath(name)); } catch {}
  return true;
}
/** canvas_manage propose：核对清单、落盘。不碰节点、不发任何生成请求 */
function canvasPropose(input, state, canvasName) {
  const raw = Array.isArray(input.items) ? input.items : [];
  if (!raw.length) return { content: "propose 要带 items：[{node_id, kind}]，kind 是 image / video / audio。", isError: true };
  if (raw.length > CANVAS_PROPOSE_MAX) return { content: `一份清单最多 ${CANVAS_PROPOSE_MAX} 项，这次是 ${raw.length} 项。分几批交。`, isError: true };
  const items = [], seen = new Set();
  for (const it of raw) {
    const id = String((it && it.node_id) || ""), kind = String((it && it.kind) || "");
    const node = state.nodes.find((n) => n.id === id);
    if (!node) return { content: `找不到节点：${id || "（空）"}`, isError: true };
    if (!CANVAS_PROPOSE_KINDS[kind]) return { content: `不支持的生成类型：${kind || "（空）"}，只能是 image / video / audio。`, isError: true };
    if (!CANVAS_PROPOSE_KINDS[kind].includes(node.kind)) return { content: `${node.kind} 节点 ${id} 不能生成 ${kind}。图：shot/image/character/location；视频：shot/video；配音：shot/audio。`, isError: true };
    // 型号以节点上写的为准：开跑时画布按节点上的 model 生成。清单里另写一个，用户看到的和真跑的就对不上
    const model = String((it && it.model) || "").trim(), on = String((node.payload && node.payload.model) || "");
    if (model && kind === "audio") return { content: `配音按角色音色走，不按型号选：节点 ${id} 这一项别写 model。`, isError: true };
    if (model && model !== on) return { content: `节点 ${id} 上写的型号是「${on || "没写（用短剧默认）"}」，清单里是「${model}」。先用 update 把 payload.model 改成「${model}」，再交清单。`, isError: true };
    if (seen.has(id + "\n" + kind)) continue;
    seen.add(id + "\n" + kind);
    items.push({ node_id: id, kind });
  }
  const proposal = { id: `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), items };
  const file = canvasProposalPath(canvasName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(proposal), "utf8");
  const count = (k) => items.filter((x) => x.kind === k).length;
  const sum = [["image", "张图"], ["video", "段视频"], ["audio", "条配音"]].filter(([k]) => count(k)).map(([k, w]) => count(k) + " " + w).join("、");
  return { content: `待生成清单已摆到画布 ${canvasName} 上：${sum}。还没有生成，也没有扣费：用户在画布上看过型号和报价、点「开跑」才开始，点「不要」就作废。` +
    "回复里把清单和每项用的型号说给用户，别再调用生成工具。", isError: false };
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
// 节点 payload 里放文件路径的那几格：页面 canvasMediaPath 读的，加上镜头、角色、场景卡各自的图和视频
const CANVAS_PATH_KEYS = ["path", "file", "url", "image", "first_frame", "last_frame", "video", "audio", "reference_video", "ref"];
/**
 * agent 写进节点的文件路径，改成从工作区根算起。
 *
 * 对话有了自己的成果文件夹（任务_1001_xx）以后，agent 手里的相对路径是从那个文件夹算的：
 * write_file、run_shell 落的素材，generate_image 回的 file，都是这个口径。画布却是整个工作区
 * 共用的一份，页面按根去找文件。照原样写进去，「不烧心_素材包/03_关键帧/x.png」在根下当然没有，
 * 满画布的参考图一起挂「找不到」，文件其实好好躺在 任务_1001_xx/不烧心_素材包/ 里。
 *
 * 认的顺序跟文件工具读文件一样：成果文件夹里有，就是它；那里没有、根下有，就是根下那个
 * （旧对话的产物、共享素材）；两边都还没有（先占位、等会儿再生成），按成果文件夹算，
 * 那是 agent 接下来往里写的地方。不像文件名的（ref 里写了一句描述）、网址、工作区外的绝对路径都不碰。
 * 原地改 payload，返回改了哪几条 [原样, 改成]。
 */
function canvasRebasePaths(payload, base) {
  const moved = [];
  if (!payload || typeof payload !== "object") return moved;
  const root = path.resolve(ws());
  const inside = (abs) => abs.startsWith(root + path.sep);
  let baseAbs = base ? path.resolve(root, String(base)) : "";
  if (baseAbs && !inside(baseAbs)) baseAbs = "";
  const baseRel = baseAbs ? path.relative(root, baseAbs).split(path.sep).join("/") : "";
  for (const key of CANVAS_PATH_KEYS) {
    const v = payload[key];
    if (typeof v !== "string") continue;
    const raw = v.trim();
    if (!raw || /^(https?:|data:|blob:|\/api\/files\/view\/)/i.test(raw)) continue;
    if (!/\.[a-z0-9]{2,5}$/i.test(raw.split(/[?#]/)[0])) continue;
    let abs;
    if (path.isAbsolute(raw)) abs = path.resolve(raw);
    else {
      const clean = raw.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
      const atRoot = path.resolve(root, clean);
      // 已经带着本对话文件夹那一截的，本来就是从根算的
      if (!baseRel || clean === baseRel || clean.startsWith(baseRel + "/")) abs = atRoot;
      else {
        const inBase = path.resolve(baseAbs, clean);
        abs = fs.existsSync(inBase) || !fs.existsSync(atRoot) ? inBase : atRoot;
      }
    }
    if (!inside(abs)) continue;
    const out = path.relative(root, abs).split(path.sep).join("/");
    if (out !== v) { payload[key] = out; moved.push([v, out]); }
  }
  return moved;
}
/** 改过的路径要告诉 agent：它接下来拿 get 读到的是新写法，不说一声它会以为节点被人动过 */
function canvasMovedNote(moved) {
  return moved.length ? `\n节点里的文件路径已改成从工作区根算起（画布整个工作区共用一份，页面按根找文件）：${moved.map(([a, b]) => `${a} → ${b}`).join("；")}` : "";
}
/**
 * @param {object} input 工具入参
 * @param {{ base?: string, platform?: string }} [ctx] base：本对话的成果文件夹（相对工作区根），没有就是空；
 *   platform：按哪家系统查画布名（默认本机，测试里传 "win32"）
 */
function canvasManage(input = {}, ctx = {}) {
  const op = String(input.operation || "get");
  const canvasName = canvasSafeName(input.canvas_name || canvasCurrentName());
  if (op === "list") return { content: JSON.stringify({ current: canvasCurrentName(), canvases: canvasList() }), isError: false };
  // 点名了一张画布、名字却会被 canvasSafeName 改写（带斜杠、超长、「..」）：改写的去向是 main，
  // 照做的话 add/clear 全落在主画布上，agent 还以为自己建了张新的。直说不收
  if (input.canvas_name && canvasSafeName(input.canvas_name) !== String(input.canvas_name).trim()) return { content: `画布名称不合法：${JSON.stringify(String(input.canvas_name).slice(0, 100))}。不能带 / \\ 或 NUL，不能是 . / ..，最长 80 字。换个名字再试。`, isError: true };
  // 画布存成 canvases/<名字>.json：Windows 上「第1集:开场」的冒号会让内容写进备用数据流、CON 打不开。
  // 名字是 agent 起的，拦下来让它换，不悄悄改（改了它以后点名还是点原来那个）
  const winBad = input.canvas_name ? require("../util/winname").badPath(String(input.canvas_name).trim() + ".json", ctx.platform || process.platform) : "";
  if (winBad) return { content: `画布名称不合法：${winBad}`, isError: true };
  let state;
  // 读不出来要当场告诉 agent，而不是递给它一张空画布——递空的，它会「好心」地
  // 重新建一遍节点，一存就把原文件盖了
  try { state = canvasReadState(canvasName); } catch (e) { return { content: e.message, isError: true }; }
  if (op === "get") return { content: JSON.stringify({ canvas_name: canvasName, version: state.version, updatedAt: state.updatedAt, nodes: state.nodes, edges: state.edges }), isError: false };
  if (op === "propose") return canvasPropose(input, state, canvasName);
  if (op === "clear") {
    // 先存快照再清：存不下来就不清——清掉了却没留底，用户那一下「撤销」就是空的
    let snap = null;
    try { snap = canvasSnapshotSave(canvasName, "清空前", state); } catch (e) { return { content: `清空前存快照没存成，所以没清空：${e.message}`, isError: true }; }
    const before = state.nodes.length;
    state = canvasWriteState(canvasEmptyState(), canvasName);
    return { content: `画布 ${canvasName} 已清空（${state.updatedAt}）。` + (snap ? `清空前的 ${before} 个节点存了快照（${snap.path}），用户在画布上点「撤销」就能放回去。` : ""), isError: false };
  }
  if (op === "add") {
    const kind = String(input.kind || ""); if (!CANVAS_KINDS.has(kind)) return { content: `不支持的画布节点类型：${kind}`, isError: true };
    const id = String(input.node_id || `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`);
    if (state.nodes.some((node) => node.id === id)) return { content: `节点 id 已存在：${id}`, isError: true };
    // 上限拦在「往里加」这一步。以前是在序列化时截断，等于替用户删已有的节点；
    // 拦在这儿最多是加不进去，一个字节都不会少
    if (state.nodes.length >= CANVAS_MAX_NODES) return { content: `画布 ${canvasName} 已经有 ${state.nodes.length} 个节点，到上限 ${CANVAS_MAX_NODES} 了，加不进去。先删掉些用不上的，或者换一张画布（canvas_name 换个名字就是新的一张）。`, isError: true };
    const payload = input.payload && typeof input.payload === "object" ? { ...input.payload } : {};
    const moved = canvasRebasePaths(payload, ctx.base);
    state.nodes.push({ id, kind, payload, position: { x: Number(input.position?.x) || 120 + (state.nodes.length % 4) * 390, y: Number(input.position?.y) || 120 + Math.floor(state.nodes.length / 4) * 300 } });
    state = canvasWriteState(state, canvasName); return { content: `已添加${kind}节点 ${id} 到画布 ${canvasName}。${canvasMovedNote(moved)}`, isError: false };
  }
  if (op === "update") {
    const node = state.nodes.find((item) => item.id === String(input.node_id || "")); if (!node) return { content: `找不到节点：${input.node_id || "（空）"}`, isError: true };
    let moved = [];
    if (input.payload && typeof input.payload === "object") {
      const patch = { ...input.payload };
      moved = canvasRebasePaths(patch, ctx.base);
      node.payload = { ...node.payload, ...patch };
    }
    if (input.position && typeof input.position === "object") node.position = { x: Number(input.position.x) || node.position.x, y: Number(input.position.y) || node.position.y };
    state = canvasWriteState(state, canvasName); return { content: `已更新节点 ${node.id}。${canvasMovedNote(moved)}`, isError: false };
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
    const id = String(input.node_id || "");
    if (!state.nodes.some((node) => node.id === id)) return { content: `找不到节点：${id}`, isError: true };
    // 连着删一串的头一下先存快照（见 canvasSnapshotBeforeDelete），删多了用户能一键放回去
    canvasSnapshotBeforeDelete(canvasName, state);
    state.nodes = state.nodes.filter((node) => node.id !== id); state.edges = state.edges.filter((edge) => edge.source.id !== id && edge.target.id !== id);
    state = canvasWriteState(state, canvasName); return { content: `已删除节点 ${id} 及其连线。`, isError: false };
  }
  return { content: `不支持的画布操作：${op}`, isError: true };
}

module.exports = {
  bindWorkspace,
  CANVAS_KINDS, CANVAS_EDGE_RELATIONS, CANVAS_MAX_NODES, CANVAS_MAX_EDGES, CANVAS_BAK_KEEP, CANVAS_BAK_HOURS, CANVAS_BAK_DAYS, canvasSafeName,
  canvasCurrentName, canvasSetCurrentName, canvasNormalizeState, canvasBackup, canvasReadState, canvasWriteState, canvasRotateBackups,
  canvasList, canvasManage, canvasRebasePaths, canvasStamp,
  canvasTrashPut, canvasTrashList, canvasTrashRead, canvasTrashRestore,
  CANVAS_SNAP_KEEP, canvasSnapshotSave, canvasSnapshotList, canvasSnapshotRestore, canvasSnapshotBeforeDelete,
  CANVAS_QUOTE_FIRST, CANVAS_QUOTE_FIRST_NOTE, canvasSessionOf, canvasProposalRead, canvasProposalDrop
};
