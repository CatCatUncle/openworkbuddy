// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 画布存盘这一侧的安全网 —— 素材台账别把在用的标成「没人用」；
 * 删画布进回收站、Agent 清空和连删之前存快照、.bak 按时间也留；
 * 画布 Agent 交的待生成清单（propose）：只记不生成、随画布一起给、按号收。
 *
 *   node test/canvas-store.js
 *
 * 起一个本地 express，挂真的画布路由、真的 src/tools/canvas.js，工作区是临时目录。
 * 不起整台 server，不碰真数据目录，不连任何外网。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const { mod } = require("./lib/mod");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  ← " + String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 300) : "")); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "owb-canvas-store-"));
const OWB = path.join(WS, ".openworkbuddy");
// src/tools/ 不在 mod 表里（见 test/lib/mod.js 开头），按路径拿
const store = require(path.join(ROOT, "src", "tools", "canvas.js"));
store.bindWorkspace(() => WS);
const routes = require(mod("routes/canvas"));

/** 工作区里的文件清单，口径跟 tools.js outputFiles 一样：相对路径、不含 .openworkbuddy */
function outputFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".openworkbuddy") continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else { const st = fs.statSync(abs); out.push({ name: path.relative(WS, abs).split(path.sep).join("/"), size: st.size, mtime: st.mtime.toISOString() }); }
    }
  };
  walk(WS);
  return out;
}
const inWs = (rel) => { const abs = path.resolve(WS, String(rel)); if (!abs.startsWith(WS + path.sep)) throw new Error("越界"); return abs; };
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(routes.createCanvasRouter({
  getWorkspaceDir: () => WS, outputFiles, safePath: inWs, rootedPath: (_req, rel) => inWs(rel),
  canvasList: store.canvasList, canvasReadState: store.canvasReadState, canvasWriteState: store.canvasWriteState,
  canvasNormalizeState: store.canvasNormalizeState, canvasSafeName: store.canvasSafeName,
  readDramaJson: (name) => ({ rel: name, data: JSON.parse(fs.readFileSync(inWs(name), "utf8")) }),
}));

let port = 0;
function call(method, url, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port, path: encodeURI(url), method, headers: { ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}), ...headers } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ code: res.statusCode, json, body: b, etag: res.headers.etag || "" }); });
    });
    req.on("error", (e) => resolve({ code: 0, json: null, body: e.message }));
    if (data) req.write(data);
    req.end();
  });
}
const put = (rel, text = "x") => { const abs = path.join(WS, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); };
const node = (id, kind, payload) => ({ id, kind, payload, position: { x: 0, y: 0 } });
const board = (nodes) => ({ version: 2, nodes, edges: [] });

async function main() {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = server.address().port;
  try {
    console.log("\n【1】素材台账：带字幕的成片、动作参考片都算在用");
    put("短剧/main/镜头_S1-01.mp4"); put("短剧/main/镜头_S1-01_字幕.mp4"); put("动作参考.mp4"); put("没人用的图.png");
    store.canvasWriteState(board([node("s1", "shot", { title: "S1-01", video: "短剧/main/镜头_S1-01.mp4", subtitled: "短剧/main/镜头_S1-01_字幕.mp4", reference_video: "动作参考.mp4" })]), "main");
    let r = await call("GET", "/api/canvas/assets?name=main");
    const by = (res) => new Map(((res.json && res.json.assets) || []).map((a) => [a.name, a]));
    let m = by(r);
    ok(r.code === 200 && m.size === 4, "台账读得出来，四个媒体文件都在", r.body.slice(0, 200));
    ok(m.get("短剧/main/镜头_S1-01_字幕.mp4") && m.get("短剧/main/镜头_S1-01_字幕.mp4").orphan === false,
      "★烧好字幕的成片不是「没人用」★ 以前 subtitled 不在字段表里，带字幕的成片被标成可以删", m.get("短剧/main/镜头_S1-01_字幕.mp4"));
    ok(m.get("动作参考.mp4") && m.get("动作参考.mp4").orphan === false && m.get("动作参考.mp4").usedBy.some((u) => u.id === "s1"),
      "★动作参考视频也算在用★ reference_video 同理", m.get("动作参考.mp4"));
    ok(m.get("没人用的图.png").orphan === true, "反向对照：真没人引用的照样标没人用");

    console.log("\n【2】项目里每一张画布都算，不只眼下这张");
    put("角色_小满.png");
    store.canvasWriteState(board([node("c1", "character", { name: "小满", reference: "角色_小满.png" })]), "第2集");
    r = await call("GET", "/api/canvas/assets?name=main");
    m = by(r);
    const xm = m.get("角色_小满.png");
    ok(xm && xm.orphan === false, "★第 2 集画布上的定妆照，在主画布看也不是「没人用」★", xm);
    ok(xm && xm.usedBy.some((u) => u.board === "第2集" && /画布 第2集/.test(u.title)), "用处里注明是哪张画布", xm && xm.usedBy);
    ok(m.get("动作参考.mp4").usedBy.every((u) => !/（画布/.test(u.title)), "眼下这张画布上的用处不加画布名", m.get("动作参考.mp4").usedBy);
    r = await call("GET", "/api/canvas/assets?name=第2集");
    m = by(r);
    ok(m.get("动作参考.mp4").orphan === false && m.get("动作参考.mp4").usedBy.some((u) => u.board === "main"), "反过来在第 2 集看，主画布上的用处也在");
    ok(r.json.stat.orphan === 1, "没人用的只剩那一张", r.json.stat);

    console.log("\n【3】有画布读不出来：「没人用」一个都不敢说");
    fs.writeFileSync(path.join(OWB, "canvases", "坏的.json"), "{ 写到一半");
    r = await call("GET", "/api/canvas/assets?name=main");
    m = by(r);
    ok(r.code === 200 && Array.isArray(r.json.boardsUnreadable) && r.json.boardsUnreadable.includes("坏的"), "读不出来的那张报出来", r.json && r.json.boardsUnreadable);
    ok(m.get("没人用的图.png").orphan === false && m.get("没人用的图.png").usedBy === null,
      "★没查到用处的不标没人用，usedBy 给 null（界面上就是不说）★ 坏掉那张可能正用着它", m.get("没人用的图.png"));
    ok(!r.json.boardUnreadable && r.json.stat.orphan === 0, "眼下这张是好的，不报「这张画布读不出来」", r.json.stat);
    ok(m.get("动作参考.mp4").usedBy.length > 0, "查到用处的照样列出来");
    fs.unlinkSync(path.join(OWB, "canvases", "坏的.json"));
    for (const f of fs.readdirSync(path.join(OWB, "canvases"))) if (/^坏的\.json\./.test(f)) fs.unlinkSync(path.join(OWB, "canvases", f));

    console.log("\n【4】两边字段表对得上");
    const server = fs.readFileSync(mod("routes/canvas"), "utf8");
    const keysOf = (src, name) => JSON.parse((new RegExp(`const ${name} = (\\[[^\\]]*\\])`).exec(src) || [])[1] || "[]");
    const serverKeys = keysOf(server, "ASSET_REF_KEYS");
    const front = keysOf(fs.readFileSync(path.join(ROOT, "public/js/app-07-canvas-compose.js"), "utf8"), "CANVAS_REF_KEYS");
    const missingKeys = front.filter((k) => !serverKeys.includes(k));
    ok(front.length > 5 && missingKeys.length === 0, "★前端认作文件的字段，服务端台账也认★ 少一个就有一类素材被标没人用", missingKeys);

    console.log("\n【5】.bak 按时间也留：最近三代 + 每小时一份 + 每天一份，各自封顶");
    const CAN = path.join(OWB, "canvases");
    const bakFile = path.join(CAN, "备份测.json");
    const ver = (tag) => JSON.stringify(board([node(tag, "note", { title: tag })]));
    const t0 = new Date(2026, 0, 1, 0, 5, 0).getTime(), H = 3600e3, D = 24 * H;
    // 30 个小时，每小时改两回：每个小时那份留的是这个小时头一回被盖掉的版本
    for (let h = 0; h < 30; h++) {
      fs.writeFileSync(bakFile, ver(`h${h}-头`)); store.canvasRotateBackups(bakFile, t0 + h * H);
      fs.writeFileSync(bakFile, ver(`h${h}-尾`)); store.canvasRotateBackups(bakFile, t0 + h * H + 20 * 60e3);
    }
    const listOf = (tag) => fs.readdirSync(CAN).filter((n) => n.startsWith(`备份测.json.${tag}-`)).sort();
    const idIn = (n) => { try { return JSON.parse(fs.readFileSync(path.join(CAN, n), "utf8")).nodes[0].id; } catch { return ""; } };
    const hours = listOf("每小时");
    ok(hours.length === store.CANVAS_BAK_HOURS, `每小时的封顶 ${store.CANVAS_BAK_HOURS} 份，最老的掉出去`, hours.length);
    ok(hours.length > 0 && idIn(hours[hours.length - 1]) === "h29-头" && idIn(hours[0]) === "h6-头", "★留的是每个小时头一回被盖掉的那版★ 同一小时第二回不顶掉它", [hours[0], idIn(hours[0]), idIn(hours[hours.length - 1])]);
    ok(fs.existsSync(bakFile + ".bak") && fs.existsSync(bakFile + ".bak.1") && fs.existsSync(bakFile + ".bak.2") && !fs.existsSync(bakFile + ".bak.3"), "按次数的三代照旧");
    for (let d = 2; d < 20; d++) { fs.writeFileSync(bakFile, ver(`d${d}`)); store.canvasRotateBackups(bakFile, t0 + d * D); }
    const days = listOf("每天");
    ok(days.length === store.CANVAS_BAK_DAYS && days.length > 0 && idIn(days[days.length - 1]) === "d19" && idIn(days[0]) === "d6", `每天一份、封顶 ${store.CANVAS_BAK_DAYS} 份`, days.map(idIn));
    ok(listOf("每小时").length === store.CANVAS_BAK_HOURS, "每小时的照样封顶，一张画布的备份不会越攒越多");
    fs.writeFileSync(bakFile, "{ 写到一半"); store.canvasRotateBackups(bakFile, t0 + 40 * D);
    ok(listOf("每天").every((n) => !n.includes(store.canvasStamp(t0 + 40 * D).slice(0, 10))), "反向对照：正本读不出来不留——拿残骸顶掉一份好的就亏了");
    fs.unlinkSync(bakFile);

    console.log("\n【6】删画布进回收站：挪过去、列得出来、拿得回来，原名被占了就叫 _2");
    store.canvasWriteState(board([node("t1", "note", { title: "第3集的卡" }), node("t2", "image", { title: "回收站里的图", image: "回收站里的图.png" })]), "第3集");
    // 再存两回：身边攒出 .bak、.bak.1、每小时、每天几份；再造一份「坏了」的、一份快照
    store.canvasWriteState(board([node("t1", "note", { title: "第3集的卡" }), node("t2", "image", { title: "回收站里的图", image: "回收站里的图.png" })]), "第3集");
    store.canvasWriteState(board([node("t1", "note", { title: "第3集的卡" }), node("t2", "image", { title: "回收站里的图", image: "回收站里的图.png" })]), "第3集");
    put(".openworkbuddy/canvases/第3集.json.坏了-2026-01-02T03-04-05.bak", "{\"t1\":1}");
    put(".openworkbuddy/canvases/第3集.json.json.bak", "别的画布的");   // 名字恰好以它开头的另一张画布（叫「第3集.json」）的备份：不沾
    store.canvasSnapshotSave("第3集", "清空前", store.canvasReadState("第3集"));
    const bakOf = (base) => fs.readdirSync(CAN).filter((n) => n.startsWith(base + ".json.") && !n.startsWith(base + ".json.json")).sort();
    const baksBefore = bakOf("第3集");
    ok(baksBefore.includes("第3集.json.bak") && baksBefore.includes("第3集.json.bak.1") && baksBefore.some((n) => /\.每小时-/.test(n)) && baksBefore.some((n) => /\.每天-/.test(n)), "（前提）删之前身边有 .bak、.bak.1、每小时、每天几份", baksBefore);
    put("回收站里的图.png");
    store.canvasSetCurrentName("第3集");
    r = await call("DELETE", "/api/canvas/boards/第3集");
    const trashed = r.json && r.json.trashed;
    const bakDir = trashed ? path.join(WS, trashed.path.replace(/\.json$/, ".备份")) : "";
    ok(trashed && bakOf("第3集").length === 0, "★备份跟着进了回收站，画布目录里一份不剩★ 以前留在原地，同名新画布的每小时、每天那一格被上一张占着", bakOf("第3集"));
    ok(trashed && baksBefore.every((n) => fs.existsSync(path.join(bakDir, n))) && fs.existsSync(path.join(bakDir, "快照")), "  └ 原样放在回收站里那张旁边的 .备份 文件夹，快照也在", trashed && fs.existsSync(bakDir) ? fs.readdirSync(bakDir) : "没有 .备份");
    ok(fs.existsSync(path.join(CAN, "第3集.json.json.bak")), "  └ 反向对照：名字恰好以它开头的别的画布的备份没被挪走");
    ok(!fs.existsSync(path.join(OWB, "canvas-snapshots", "第3集")) && store.canvasSnapshotList("第3集").length === 0, "★快照不再挂在这个名字下★ 不然同名新画布点「放回去」，补进来的是上一张的节点");
    ok(r.code === 200 && trashed && /^\.openworkbuddy\/canvas-trash\/第3集@\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.json$/.test(trashed.path), "删掉回 200，说清挪到了哪个路径", r.body.slice(0, 300));
    ok(trashed && fs.existsSync(path.join(WS, trashed.path)) && !fs.existsSync(path.join(CAN, "第3集.json")), "★文件真在回收站里，画布目录里没了★ 以前是 unlink，点错一下就白干");
    ok(!r.json.canvases.some((c) => c.name === "第3集"), "画布列表里不再有它");
    ok(store.canvasCurrentName() === "main", "删的正是 Agent 认的当前画布：指回主画布，别接着往一张不在的画布上写", store.canvasCurrentName());
    r = await call("GET", "/api/canvas/list");
    const inTrash = (r.json.trash || []).find((t) => t.id === trashed.id);
    ok(inTrash && inTrash.name === "第3集" && inTrash.nodes === 2 && inTrash.path === trashed.path && inTrash.deletedAt > 0, "画布列表接口带上回收站：名字、几个节点、路径、什么时候删的", r.json.trash);
    ok((r.json.trash || []).length === 1 && r.json.trash.every((t) => /\.json$/.test(t.id)), "回收站列表只列画布本身，.备份 文件夹不当成一张画布", r.json.trash);
    r = await call("GET", "/api/canvas/assets?name=main");
    m = by(r);
    ok(m.get("回收站里的图.png") && m.get("回收站里的图.png").orphan === false && m.get("回收站里的图.png").usedBy.some((u) => /回收站里的画布 第3集/.test(u.title)),
      "★回收站里的画布引用的素材不算「没人用」★ 它随时会被放回来，这时删了素材就是一屏「找不到」", m.get("回收站里的图.png"));
    store.canvasWriteState(board([node("new1", "note", { title: "后来新建的第3集" })]), "第3集");
    store.canvasWriteState(board([node("new1", "note", { title: "后来新建的第3集" }), node("new2", "note", { title: "又加一张" })]), "第3集");
    const hourly = bakOf("第3集").find((n) => /\.每小时-/.test(n));
    ok(hourly && /new1/.test(fs.readFileSync(path.join(CAN, hourly), "utf8")) && !/t1/.test(fs.readFileSync(path.join(CAN, hourly), "utf8")),
      "★同名新画布的每小时备份存的是它自己★ 以前那一格被上一张占着，这一小时就留不下它", hourly);
    r = await call("POST", "/api/canvas/trash/restore", { id: trashed.id });
    ok(r.code === 200 && r.json.name === "第3集_2", "原名被新画布占了：放回来叫 第3集_2", r.body.slice(0, 200));
    const backBaks = bakOf("第3集_2");
    ok(baksBefore.every((n) => backBaks.includes(n.replace(/^第3集\.json/, "第3集_2.json"))) && /t1/.test(fs.readFileSync(path.join(CAN, "第3集_2.json.bak"), "utf8")),
      "★备份跟回来了，按新名字改名（第3集_2.json.bak…）★", backBaks);
    ok(store.canvasSnapshotList("第3集_2").length === 1 && store.canvasSnapshotList("第3集").length === 0, "快照跟着回到 第3集_2 名下，新的 第3集 那张不沾");
    ok(!fs.existsSync(bakDir), "挪空了的 .备份 文件夹删掉，回收站里不留空壳");
    ok(store.canvasReadState("第3集").nodes[0].id === "new1" && store.canvasReadState("第3集_2").nodes.map((n) => n.id).join() === "t1,t2", "★两张都在，谁也不盖谁★");
    ok(!(r.json.trash || []).some((t) => t.id === trashed.id) && !fs.existsSync(path.join(WS, trashed.path)), "放回来之后回收站里就没它了");
    r = await call("POST", "/api/canvas/trash/restore", { id: "../canvas.json" });
    ok(r.code === 400 && fs.existsSync(path.join(OWB, "canvas.json")), "反向对照：回收站里没有的名字（../canvas.json）拿不动，主画布原地不动", r.body);
    r = await call("DELETE", "/api/canvas/boards/main");
    ok(r.code === 400 && fs.existsSync(path.join(OWB, "canvas.json")), "主画布照旧删不掉");
    r = await call("DELETE", "/api/canvas/boards/第3集");
    const second = r.json && r.json.trashed;
    r = await call("DELETE", "/api/canvas/boards/第3集_2");
    r = await call("GET", "/api/canvas/trash");
    ok(second && r.json.trash.length === 2 && r.json.trash.every((t) => t.nodes > 0), "删两张就列两张", r.json.trash);

    console.log("\n【7】Agent 清空画布：先存快照，用户一键放回去；放回去只补不盖");
    const eight = Array.from({ length: 8 }, (_, i) => node("q" + i, "note", { title: "第" + i + "张" }));
    store.canvasWriteState({ version: 2, nodes: eight, edges: [{ source: { id: "q0" }, target: { id: "q1" } }, { source: { id: "q1" }, target: { id: "q2" } }] }, "快照测");
    let out = store.canvasManage({ operation: "clear", canvas_name: "快照测" });
    ok(!out.isError && store.canvasReadState("快照测").nodes.length === 0, "清空照做", out.content);
    ok(/8 个节点存了快照（\.openworkbuddy\/canvas-snapshots\/快照测\//.test(out.content) && /撤销/.test(out.content), "回给 Agent 的话里说存了快照、在哪、用户能撤销", out.content);
    store.canvasManage({ operation: "add", canvas_name: "快照测", kind: "note", node_id: "agent-new", payload: { title: "Agent 清完新加的" } });
    r = await call("GET", "/api/canvas/snapshots?name=快照测");
    const snaps = (r.json && r.json.snapshots) || [];
    ok(snaps.length === 1 && snaps[0].why === "清空前" && snaps[0].nodes === 8 && snaps[0].missing === 8 && snaps[0].at > 0, "快照列得出来：为什么存的、几个节点、现在少了几个", snaps);
    r = await call("POST", "/api/canvas/snapshots/restore", { name: "快照测", id: snaps[0] && snaps[0].id });
    const back = store.canvasReadState("快照测");
    ok(r.code === 200 && r.json.restored === 8 && r.json.edges === 2 && back.nodes.length === 9 && back.edges.length === 2, "★八张和两条线都回来了★", { code: r.code, restored: r.json && r.json.restored, nodes: back.nodes.length, edges: back.edges.length });
    ok(back.nodes.some((n) => n.id === "agent-new"), "★Agent 清完又加的那张还在★ 放回去只补、不拿快照整个盖回去");
    ok(r.json.state && r.json.state.updatedAt === back.updatedAt && r.json.updatedAt === back.updatedAt, "回执带着放回去之后盘上那份，界面直接铺");
    r = await call("POST", "/api/canvas/snapshots/restore", { name: "快照测", id: snaps[0] && snaps[0].id });
    ok(r.code === 200 && r.json.restored === 0 && store.canvasReadState("快照测").nodes.length === 9, "再点一次：没缺的就什么都不加，不重复");
    r = await call("GET", "/api/canvas/snapshots?name=../快照测");
    ok(r.code === 400, "反向对照：画布名带 ../ 不收", r.body);
    // 存不下快照就不清：拿一个同名文件占住快照目录的位置
    store.canvasWriteState(board([node("z1", "note", { title: "留着" })]), "存不下");
    fs.mkdirSync(path.join(OWB, "canvas-snapshots"), { recursive: true });
    fs.writeFileSync(path.join(OWB, "canvas-snapshots", "存不下"), "占位");
    out = store.canvasManage({ operation: "clear", canvas_name: "存不下" });
    ok(out.isError && /没清空/.test(out.content) && store.canvasReadState("存不下").nodes.length === 1, "★快照存不下就不清★ 清了却没留底，用户那一下「撤销」就是空的", out.content);

    console.log("\n【8】Agent 一口气删一串：头一下存快照，连着删的不再存");
    store.canvasWriteState({ version: 2, nodes: Array.from({ length: 9 }, (_, i) => node("w" + i, "note", { title: "w" + i })), edges: [] }, "连删");
    for (let i = 0; i < 7; i++) store.canvasManage({ operation: "delete", canvas_name: "连删", node_id: "w" + i });
    r = await call("GET", "/api/canvas/snapshots?name=连删");
    const ds = (r.json && r.json.snapshots) || [];
    ok(ds.length === 1 && ds[0].why === "删节点前" && ds[0].nodes === 9 && ds[0].missing === 7, "★删了七张只存一份，里面是删之前的整张画布★ 每删一张存一份的话，最后一份就只剩两张", ds);
    out = store.canvasManage({ operation: "delete", canvas_name: "连删", node_id: "不存在的" });
    ok(out.isError && ((await call("GET", "/api/canvas/snapshots?name=连删")).json.snapshots.length === 1), "删一个不存在的节点：报找不到，不平白存快照");
    const k0 = Date.now() + 10 * 60e3;
    const st = store.canvasReadState("连删");
    ok(store.canvasSnapshotBeforeDelete("连删", st, k0) !== null, "安静了 5 分钟以上再删：算新的一串，再存一份");
    ok(store.canvasSnapshotBeforeDelete("连删", st, k0 + 60e3) === null, "一分钟后接着删：还是同一串，不存");
    for (let i = 0; i < store.CANVAS_SNAP_KEEP + 5; i++) store.canvasSnapshotSave("连删", "删节点前", st, k0 + (i + 10) * 3600e3);
    ok(fs.readdirSync(path.join(OWB, "canvas-snapshots", "连删")).length === store.CANVAS_SNAP_KEEP, `快照一张画布封顶 ${store.CANVAS_SNAP_KEEP} 份`);

    console.log("\n【9】画布 Agent 先报价：propose 只交清单、不生成；清单随画布一起给，点了按号收掉");
    store.canvasWriteState(board([
      node("s1", "shot", { id: "s1", prompt: "一号镜头", model: "假图模型" }), node("s2", "shot", { id: "s2", prompt: "二号镜头" }),
      node("c1", "character", { name: "阿青", description: "短发" }), node("t1", "note", { title: "备注" }),
    ]), "报价测");
    const before = JSON.stringify(store.canvasReadState("报价测"));
    const propose = (items) => store.canvasManage({ operation: "propose", canvas_name: "报价测", items });
    out = propose([{ node_id: "s1", kind: "image" }, { node_id: "s1", kind: "image" }, { node_id: "s2", kind: "video" }, { node_id: "c1", kind: "image" }]);
    const pr = store.canvasProposalRead("报价测");
    ok(!out.isError && /2 张图、1 段视频/.test(out.content) && /没有扣费/.test(out.content) && /开跑/.test(out.content), "★交清单：回话说清几张图几段视频、还没生成没扣费、等用户点「开跑」★", out.content);
    ok(pr && /^p_/.test(pr.id) && JSON.stringify(pr.items) === JSON.stringify([{ node_id: "s1", kind: "image" }, { node_id: "s2", kind: "video" }, { node_id: "c1", kind: "image" }]),
      "清单落在画布旁边，同一节点同一类只记一次", pr);
    ok(JSON.stringify(store.canvasReadState("报价测")) === before && outputFiles().every((f) => !/一号镜头|s1/.test(f.name)), "交清单不碰画布、不出任何文件");
    const bad = [
      [[], /items/], [[{ node_id: "不存在", kind: "image" }], /找不到节点/], [[{ node_id: "s1", kind: "music" }], /只能是 image/],
      [[{ node_id: "t1", kind: "image" }], /note 节点 t1 不能生成 image/], [[{ node_id: "c1", kind: "video" }], /不能生成 video/],
      [[{ node_id: "s1", kind: "image", model: "别的模型" }], /先用 update 把 payload\.model 改成「别的模型」/],
      [[{ node_id: "s2", kind: "audio", model: "某型号" }], /别写 model/],
      [Array.from({ length: 61 }, () => ({ node_id: "s1", kind: "image" })), /最多 60 项/],
    ].map(([items, re]) => { const o = propose(items); return { ok: o.isError && re.test(o.content), why: o.content }; });
    ok(bad.every((b) => b.ok) && store.canvasProposalRead("报价测").id === pr.id,
      "★不对的清单一律退回、说清哪里不对；型号跟节点上写的不一样也退回（用户看到的要跟真跑的一样）★ 退回的不顶掉上一份", bad.filter((b) => !b.ok));
    ok(!propose([{ node_id: "s1", kind: "image", model: "假图模型" }]).isError, "  └ 反向对照：型号跟节点上写的一样就收");
    const p2 = store.canvasProposalRead("报价测");
    ok(p2 && p2.id !== pr.id && p2.items.length === 1, "新交的一份顶掉旧的（一张画布只摆一份）", p2);

    r = await call("GET", "/api/canvas?name=报价测");
    ok(r.code === 200 && r.json.proposal && r.json.proposal.id === p2.id && r.json.nodes.length === 4, "★GET /api/canvas 带上清单：画布轮询一趟就拿到★", r.json && r.json.proposal);
    const tagWith = r.etag;
    r = await call("GET", "/api/canvas?name=报价测", undefined, { "If-None-Match": tagWith });
    ok(r.code === 304, "同一份清单再问：304", r.code);
    propose([{ node_id: "s2", kind: "image" }]);
    const p3 = store.canvasProposalRead("报价测");
    r = await call("GET", "/api/canvas?name=报价测", undefined, { "If-None-Match": tagWith });
    ok(r.code === 200 && r.json.proposal && r.json.proposal.id === p3.id && r.etag !== tagWith,
      "★画布没变、Agent 又交了一份：不回 304，新清单带得出来★ ETag 不算清单号的话横幅永远出不来", { code: r.code, etag: r.etag, was: tagWith });

    r = await call("POST", "/api/canvas/proposal/dismiss", { name: "报价测", id: p2.id });
    ok(r.code === 200 && r.json.dropped === false && store.canvasProposalRead("报价测").id === p3.id, "★点的是旧横幅（号对不上）：Agent 刚交的那份不动★", r.json);
    r = await call("POST", "/api/canvas/proposal/dismiss", { name: "报价测", id: p3.id });
    ok(r.code === 200 && r.json.dropped === true && store.canvasProposalRead("报价测") === null, "按号收掉", r.json);
    r = await call("GET", "/api/canvas?name=报价测");
    ok(r.code === 200 && !("proposal" in r.json), "收掉之后 GET 不再带清单", r.json && r.json.proposal);
    r = await call("POST", "/api/canvas/proposal/dismiss", { name: "报价测" });
    const r2 = await call("POST", "/api/canvas/proposal/dismiss", { name: "../报价测", id: "p_x" });
    ok(r.code === 400 && r2.code === 400, "反向对照：不带清单号、画布名带 ../，都不收", [r.body, r2.body]);
    // 只开跑了其中几类：划掉跑过的，剩下的换新号留着（号不换的话 ETag 不变，别的标签页还是 304、横幅上还是整份）
    propose([{ node_id: "s1", kind: "image" }, { node_id: "s2", kind: "video" }, { node_id: "s2", kind: "audio" }]);
    const p4 = store.canvasProposalRead("报价测");
    r = await call("GET", "/api/canvas?name=报价测");
    const tag4 = r.etag;
    r = await call("POST", "/api/canvas/proposal/dismiss", { name: "报价测", id: p4.id, kinds: ["image"] });
    const p5 = store.canvasProposalRead("报价测");
    ok(r.code === 200 && r.json.dropped === false && r.json.left === 2 && p5 && r.json.id === p5.id && p5.id !== p4.id && p5.at === p4.at
      && JSON.stringify(p5.items) === JSON.stringify([{ node_id: "s2", kind: "video" }, { node_id: "s2", kind: "audio" }]),
      "★开跑了图那一类：只划掉图，视频、配音留着，换了新清单号★", { r: r.json, p5 });
    r = await call("GET", "/api/canvas?name=报价测", undefined, { "If-None-Match": tag4 });
    ok(r.code === 200 && r.json.proposal && r.json.proposal.id === p5.id && r.json.proposal.items.length === 2,
      "★划掉之后别的标签页再问：不回 304，拿到的是剩下的那两项★", { code: r.code, proposal: r.json && r.json.proposal });
    r = await call("POST", "/api/canvas/proposal/dismiss", { name: "报价测", id: p4.id, kinds: ["video"] });
    ok(r.code === 200 && r.json.dropped === false && !r.json.id && store.canvasProposalRead("报价测").id === p5.id, "拿旧号来划：号对不上，一项不动", r.json);
    r = await call("POST", "/api/canvas/proposal/dismiss", { name: "报价测", id: p5.id, kinds: ["music"] });
    const r3 = await call("POST", "/api/canvas/proposal/dismiss", { name: "报价测", id: p5.id, kinds: [] });
    ok(r.code === 400 && r3.code === 400 && store.canvasProposalRead("报价测").id === p5.id, "反向对照：kinds 写错、给空的，都退回、不动清单", [r.body, r3.body]);
    r = await call("POST", "/api/canvas/proposal/dismiss", { name: "报价测", id: p5.id, kinds: ["video", "audio"] });
    ok(r.code === 200 && r.json.dropped === true && store.canvasProposalRead("报价测") === null, "剩下的全跑了：跟收掉一样，整份没了", r.json);
    propose([{ node_id: "s1", kind: "image" }]);
    store.canvasTrashPut("报价测");
    store.canvasWriteState(board([node("s1", "shot", { id: "s1", prompt: "新的一镜" })]), "报价测");
    ok(store.canvasProposalRead("报价测") === null, "删画布时清单一起作废：再建一张同名的，不冒出上一张的横幅");

    console.log("\n【10】Agent 断开一条连线：只去掉这一条，两头的节点、别的线都留着");
    store.canvasWriteState({ version: 2, nodes: [node("d1", "character", { name: "阿青" }), node("d2", "shot", { id: "d2" }), node("d3", "shot", { id: "d3" })],
      edges: [{ source: { id: "d1" }, target: { id: "d2" }, relation: "character" }, { source: { id: "d1" }, target: { id: "d3" }, relation: "character" }] }, "断线测");
    const dc = (source_id, target_id) => store.canvasManage({ operation: "disconnect", canvas_name: "断线测", source_id, target_id });
    out = dc("d1", "d2");
    let ds2 = store.canvasReadState("断线测");
    ok(!out.isError && /已断开 d1 → d2/.test(out.content) && ds2.nodes.length === 3 && ds2.edges.length === 1 && ds2.edges[0].target.id === "d3",
      "★断开 d1 → d2：三个节点都在，d1 → d3 那条还在★", { out: out.content, nodes: ds2.nodes.length, edges: ds2.edges });
    const stamp = ds2.updatedAt;
    out = dc("d1", "d2");
    ok(out.isError && /没有 d1 → d2/.test(out.content) && store.canvasReadState("断线测").updatedAt === stamp, "再断一次：报没有这条线，不白写一趟盘", out.content);
    out = dc("d3", "d1");
    ok(out.isError && /反方向的 d1 → d3/.test(out.content) && store.canvasReadState("断线测").edges.length === 1, "★方向写反了：点出反方向那条在，不替它断★", out.content);
    out = dc("d1", "");
    ok(out.isError && /source_id 和 target_id/.test(out.content), "少一头：直说要两头", out.content);
    // 只读源码，不 require：tools.js 一加载就要绑工作区、起一串别的模块
    const toolSrc = fs.readFileSync(mod("tools"), "utf8");
    ok(/"connect", "disconnect", "delete"/.test(toolSrc) && /用 disconnect 断开一条连线/.test(toolSrc), "工具说明里有 disconnect，Agent 才知道能只断线不删节点");
  } finally {
    server.close();
  }
}

main().catch((e) => { fail++; console.log("  ✗ 跑挂了：" + (e && e.stack || e)); }).finally(() => {
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch {}
  console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
  process.exit(fail ? 1 : 0);
});
