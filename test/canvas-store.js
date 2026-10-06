// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 画布存盘这一侧的安全网 —— 素材台账别把在用的标成「没人用」。
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
function call(method, url, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port, path: encodeURI(url), method, headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ code: res.statusCode, json, body: b }); });
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
  } finally {
    server.close();
  }
}

main().catch((e) => { fail++; console.log("  ✗ 跑挂了：" + (e && e.stack || e)); }).finally(() => {
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch {}
  console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
  process.exit(fail ? 1 : 0);
});
