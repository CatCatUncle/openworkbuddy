"use strict";
/**
 * 画布路由：/api/canvas（读写、新建、删除）、素材台账 /api/canvas/assets、制片进度 /api/canvas/progress。
 * 一键合成 /api/canvas/compose 在 routes/compose.js，任务队列在 lib/compose-jobs.js。
 * 都是从 server.js 原样搬出来的，URL、状态码、返回体一个字没动。
 *
 * 写法跟 admin.js 那种「工厂函数里登记路由」不一样：路由和函数都写在顶层，路由器变量就叫 app。
 * 测试按源码切片验（test/lib/src.js 把 server.js + routes/ + lib/ 拼成一份），认的是顶格的函数名、
 * 顶格的 app 登记和它后面那个顶格的「});」。缩进进工厂函数里，这些切片就全切不出来了。
 * 所以依赖做成模块级变量，createCanvasRouter(deps) 一次填上；路由器全进程就这一个，server.js 挂一次。
 * 依赖全从 deps 进来，不 require server.js：当前工作区、租户根这些状态都在 server 手里。
 */
const fs = require("fs");
const path = require("path");
const express = require("express");
const dramaPipeline = require("../drama-pipeline");

// 下面这几个由 createCanvasRouter(deps) 填上。readDramaJson 住在 routes/drama.js，素材台账要读分镜表
let getWorkspaceDir, outputFiles, safePath, rootedPath, canvasList, canvasReadState, canvasWriteState, canvasNormalizeState, canvasSafeName, readDramaJson;

// 大小写敏感跟 server.js 一致：子路由器不继承外面那个 case sensitive routing 的设置
const app = express.Router({ caseSensitive: true });

// 无限画布的项目内状态：浏览器负责渲染，Agent 通过 canvas_manage 工具改同一份 JSON。
// 不把它放到 localStorage 作为唯一真源，否则 Agent 改完节点浏览器永远看不到。
app.get("/api/canvas/list", (_req, res) => res.json({ canvases: canvasList() }));

/**
 * 短剧素材台账。
 *
 * 做短剧的素材不是一堆文件，是一张关系表：
 * 这张图是谁的定妆照、那段视频是第几镜、这条配音配的哪句台词、哪张图根本没人用、
 * 哪一镜引用的文件已经不在盘上了。光给一个文件列表解决不了任何一个上面的问题。
 *
 * 所以这里做三件事：
 *   ① 从工作区挑出媒体文件，按 short-drama 技能的命名规矩认出它是什么
 *      （角色_*.png = 定妆照、镜头_*_首帧.* = 首帧、镜头_*.mp4 = 成片镜头、配音_*.* = 配音）；
 *   ② 把画布节点和分镜表里所有指向文件的字段摊平，算出「谁在用这个文件」；
 *   ③ 反过来标出两种病：**引用了但盘上没有**（镜头永远生不出来，最该先看的一类），
 *      和**在盘上但没人用**（多半是重跑留下的旧版本，占地方，也容易选错）。
 *
 * 只读，不动任何文件。要删要改是用户的事，这里只负责把事实摆清楚。
 */
const ASSET_KINDS = { image: /\.(png|jpe?g|webp|gif|bmp|avif)$/i, video: /\.(mp4|mov|webm|m4v|mkv)$/i, audio: /\.(mp3|wav|m4a|aac|flac|ogg)$/i };
/** 画布节点和分镜表里，这些字段装的是文件路径 */
// reference 这一条是补上的：角色节点的定妆照就落在 reference 里。少了它，定妆照会被算成
// 「没人用」——而「没人用」这一栏在界面上是加粗的、旁边还写着「多半是重跑留下的旧版本，占地方」，
// 等于指着这部戏最要命的几张图叫人删。文件删了，后面每一镜的脸都会开始换人。
const ASSET_REF_KEYS = ["path", "url", "first_frame", "last_frame", "video", "audio", "image", "reference", "ref", "voice_file", "file"];

function assetKindOf(name) {
  for (const [kind, re] of Object.entries(ASSET_KINDS)) if (re.test(name)) return kind;
  return "";
}
/**
 * 按 short-drama 技能的命名规矩认用途。认不出就是「其他」，不猜。
 * 画布重生成一版会落成「镜头_S1-01_首帧_v3.png」这种带版本号的名字，先把 _v 数字剥掉再认——
 * 不剥的话，哪天加一条按结尾认的规矩，新版本就全掉进「其他」里
 */
function assetRoleOf(base) {
  base = String(base || "").replace(/_v\d+(\.[^./\\]+)$/i, "$1");
  if (/^(角色|定妆)[_\-]/.test(base)) return "定妆照";
  if (/首帧/.test(base)) return "首帧";
  if (/^配音[_\-]/.test(base)) return "配音";
  if (/^镜头[_\-]/.test(base)) return "镜头";
  if (/^(场景|背景)[_\-]/.test(base)) return "场景图";
  return "其他";
}
function assetBase(p) { return String(p || "").split(/[\\/]/).pop() || ""; }
/** 文件名里的版本号：镜头_S1-01_首帧_v3.png → 3。没带就是 0 */
function assetVersionOf(base) { const m = /_v(\d+)\.[^./\\]+$/i.exec(String(base || "")); return m ? Number(m[1]) : 0; }

/**
 * 素材定位器：画布 / 分镜表里写的路径 → 盘上那一份（工作区相对路径）。判定在 drama-pipeline 的 assetLocator，
 * 这里只补两件碰外部世界的事：
 *   ① 工作区里的绝对路径先折成相对路径（Agent 写画布时偶尔写全路径）；
 *      工作区外的绝对路径 outside="trust" 时原样算「在」——进度那边一直是「不敢说就不喊丢」；
 *      其余调用方按文件名去搜，跟以前一样；
 *   ② exists：清单截断过，清单里没有的再问一次盘。
 * near 是默认的「就近目录」：画布的产物按 短剧/<画布名> 分目录落盘，同名的先认自己这张画布的
 */
function canvasAssetLocator(files, exists, opts = {}) {
  const root = path.resolve(getWorkspaceDir());
  const loc = dramaPipeline.assetLocator((files || []).map((f) => f.name), { exists });
  return (ref, near) => {
    const s = String(ref || "").trim();
    const where = near == null ? opts.near : near;
    if (path.isAbsolute(s)) {
      const abs = path.resolve(s);
      if (abs.startsWith(root + path.sep)) return loc(path.relative(root, abs).split(path.sep).join("/"), where);
      if (opts.outside === "trust") return { rel: s };
    }
    return loc(s, where);
  };
}
/** 画布自己的产物目录（跟画布前端 subdir 的口径一样：短剧/<画布名>）。没给名字就不猜是哪张 */
function canvasAssetNear(name) { return name ? "短剧/" + canvasSafeName(name) : ""; }

/** 把一个 payload 里所有指向文件的值摘出来。数组和一层嵌套也要看，引用列表就藏在那儿 */
function assetRefsIn(payload, out) {
  if (!payload || typeof payload !== "object") return;
  for (const key of ASSET_REF_KEYS) {
    const v = payload[key];
    if (typeof v === "string" && v.trim()) out.add(v.trim());
  }
  for (const v of Object.values(payload)) {
    if (Array.isArray(v)) for (const item of v) { if (typeof item === "string" && /\.[a-z0-9]{2,5}$/i.test(item)) out.add(item.trim()); else assetRefsIn(item, out); }
  }
}

app.get("/api/canvas/assets", (req, res) => {
  try {
    const name = String(req.query.name || "").trim();
    // 谁在用：画布节点一份，分镜表一份。分镜表才是短剧的真源，
    // 画布上没画出来的镜头，它的首帧照样是「有人在用」的。
    // 引用先原样收齐（连同从哪写出来的），拿到清单再统一认：以前按文件名记账，
    // 两集各有一张「镜头_S1-01_首帧.png」时，A 集的引用会记到 B 集那张图头上
    const uses = [];   // { ref, near, use: { from, id, title, kind } }
    const noteUse = (ref, use, near) => { if (assetBase(ref)) uses.push({ ref, near, use }); };
    const boardNear = canvasAssetNear(name);
    let boardUnreadable = "";
    try {
      const state = canvasReadState(name || undefined, {});
      for (const node of state.nodes || []) {
        const refs = new Set();
        assetRefsIn(node.payload, refs);
        for (const r of refs) noteUse(r, { from: "画布", id: String(node.id || ""), title: String((node.payload && (node.payload.title || node.payload.name || node.payload.id)) || node.kind || "节点"), kind: String(node.kind || "") }, boardNear);
      }
    } catch (e) { boardUnreadable = e.message; }   // 画布坏了不该连素材台账一起看不了

    const boards = [];
    for (const f of outputFiles()) {
      if (!/(?:分镜表|storyboard|shotlist)[^/]*\.json$/i.test(f.name)) continue;
      try {
        const r = readDramaJson(f.name);
        boards.push(r.rel);
        // 分镜表里的路径按它自己所在的目录起算：短剧/第1集/分镜表.json 里写的首帧，先认第1集那一份。
        // 反斜杠写成 [\\] 而不是裸的 \\：路由处理函数里，e2e 的路由嵌套扫描会把 /\\/g 当成行注释，括号数就配不平了
        const near = path.posix.dirname(String(r.rel).replace(/[\\]/g, "/")).replace(/^\.$/, "");
        for (const c of Array.isArray(r.data.characters) ? r.data.characters : []) {
          const refs = new Set(); assetRefsIn(c, refs);
          for (const x of refs) noteUse(x, { from: "分镜表", id: String(c.id || c.name || ""), title: `角色 ${c.name || c.id || ""}`.trim(), kind: "character" }, near);
        }
        for (const scene of Array.isArray(r.data.scenes) ? r.data.scenes : []) {
          for (const [i, shot] of (Array.isArray(scene.shots) ? scene.shots : []).entries()) {
            const sid = String(shot.id || `${scene.id || "S"}-${String(i + 1).padStart(2, "0")}`);
            const refs = new Set(); assetRefsIn(shot, refs);
            for (const x of refs) noteUse(x, { from: "分镜表", id: sid, title: `镜头 ${sid}`, kind: "shot" }, near);
          }
        }
      } catch {}
    }

    const files = outputFiles();
    // 先按相对路径认，认不出再按文件名全区搜；同名好几份的，每一份都记上「有人在用」并标 ambiguous——
    // 分不清用的是哪份，就哪份都不能标成「没人用」（那一栏是提示可以删的）
    const locate = canvasAssetLocator(files, (rel) => { try { return fs.existsSync(safePath(rel)); } catch { return false; } });
    const users = new Map();   // 相对路径 → [{ from, id, title, kind }]
    const twins = new Map();   // 相对路径 → 跟它同名的那几份（含它自己）
    const lost = new Map();    // 文件名 → { base, paths, usedBy }
    const addUse = (list, use) => { if (!list.some((u) => u.from === use.from && u.id === use.id)) list.push(use); return list; };
    for (const u of uses) {
      const hit = locate(u.ref, u.near);
      if (hit.ambiguous) { for (const r of hit.ambiguous) { users.set(r, addUse(users.get(r) || [], u.use)); twins.set(r, hit.ambiguous); } continue; }
      if (hit.rel) { users.set(hit.rel, addUse(users.get(hit.rel) || [], u.use)); continue; }
      const base = assetBase(u.ref);
      if (!assetKindOf(base)) continue;      // 引用的不是媒体文件（分镜表 JSON 之类），不归这儿管
      const m = lost.get(base) || { base, paths: [], usedBy: [] };
      if (!m.paths.includes(u.ref)) m.paths.push(u.ref);
      addUse(m.usedBy, u.use);
      lost.set(base, m);
    }
    const assets = [];
    for (const f of files) {
      const kind = assetKindOf(f.name);
      if (!kind) continue;
      const base = assetBase(f.name), rel = String(f.name).replace(/[\\]/g, "/");   // [\\] 的缘故见上面 near 那行
      const usedBy = users.get(rel) || [];
      const version = assetVersionOf(base);
      assets.push({
        name: f.name, base, kind, role: assetRoleOf(base), size: f.size, mtime: f.mtime, dup_of: f.dup_of || undefined, usedBy, orphan: usedBy.length === 0,
        ...(version ? { version } : {}), ...(twins.has(rel) ? { ambiguous: twins.get(rel) } : {}),
      });
    }
    // 引用了但盘上没有的。这类最要紧：那一镜现在就是生不出来的，而文件列表里永远看不见它
    const missing = [...lost.values()];
    assets.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
    res.json({
      assets, missing, boards, ...(boardUnreadable ? { boardUnreadable } : {}),
      stat: {
        total: assets.length, orphan: assets.filter((a) => a.orphan).length, missing: missing.length, ambiguous: assets.filter((a) => a.ambiguous).length,
        bytes: assets.reduce((n, a) => n + (a.size || 0), 0),
        byKind: { image: assets.filter((a) => a.kind === "image").length, video: assets.filter((a) => a.kind === "video").length, audio: assets.filter((a) => a.kind === "audio").length },
      },
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
/**
 * 短剧制片进度。素材台账回答「这个文件谁在用」，这里回答「这部戏做到哪了、卡在哪、还剩多少活儿」。
 *
 * 判定放在 drama-pipeline.js（纯函数、可单测），这一层只负责两件事：把画布读出来，
 * 以及告诉它**哪些文件真的在盘上**——「字段里写着 first_frame」和「首帧真的存在」是两回事，
 * 后者才是能不能往下走的依据。画布读不出来不 500：进度看不了是小事，
 * 但顺手把界面打成白板才是真事故（跟 /api/canvas/assets 一个道理）。
 */
app.get("/api/canvas/progress", (req, res) => {
  try {
    const name = String(req.query.name || "").trim();
    let state = { nodes: [], edges: [] }, boardUnreadable = "";
    try { state = canvasReadState(name || undefined, {}); } catch (e) { boardUnreadable = e.message; }
    // 这份清单是截断过的（最深 3 层、最多 500 条，见 tools.js outputFiles），
    // 「不在清单里」不等于「文件没了」。画布上引用到、清单里又没有的那些，挨个问一次盘——
    // 判死刑只有盘说了算。跟 /api/files/exists 同一个道理，那条口子就是为这个开的。
    // 400 是一张画布撑死的量级；再多也不该在一次请求里 stat 完。
    // 认法是「先相对路径、再文件名全区搜、同名好几份报 ambiguous」（见 canvasAssetLocator）
    let asked = 0;
    const exists = (rel) => {
      if (++asked > 400) return false;
      // 解析不出来（越界、根本不是相对路径）也算「不敢说」，宁可不喊也不冤枉一个还在的文件
      try { return fs.existsSync(rootedPath(req, rel)); } catch { return true; }
    };
    const locate = canvasAssetLocator(outputFiles(), exists, { near: canvasAssetNear(name), outside: "trust" });
    const data = dramaPipeline.dramaProgress(state, { locate });
    res.json({ ...data, ...(boardUnreadable ? { boardUnreadable } : {}) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * 画布的版本号就是 updatedAt（毫秒，canvasWriteState 每次写都会盖）。
 * 同一毫秒里连写两次，两份就撞成同一个版本号——拿着旧版本号的那一边会被当成「没过期」放行，
 * 正好是 409 要拦的那一下。所以写之前等时钟走过盘上那个数；最多等 5 毫秒，
 * 盘上的数比现在还大（改过系统时间）就不等了，反正两个数不相等，冲突照样认得出来
 */
function canvasTickPast(stamp) {
  const t = Number(stamp) || 0, until = Date.now() + 5;
  while (Date.now() <= t && Date.now() < until) { /* 忙等不到 1 毫秒 */ }
}

/** If-None-Match 里有没有这个版本号。W/ 前缀和引号都剥掉比；「*」算命中 */
function canvasEtagHit(header, stamp) {
  return String(header || "").split(",").map((t) => t.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1"))
    .some((t) => t === "*" || (t !== "" && t === String(stamp)));
}
app.get("/api/canvas", (req, res) => {
  const name = String(req.query.name || "").trim();
  try {
    const lost = {};
    const state = canvasReadState(name || undefined, lost);
    // ETag 就是版本号 updatedAt。0 不给：「文件还没有」和「刚建的空白画布」都是 0，
    // 两样内容不一样，拿同一个 ETag 回 304 会让前端留着另一张的缓存。
    // 带 lost 的那一回也不回 304：lost 只在这一次响应里说，缓存里那份没有它
    const stamp = Number(state.updatedAt) || 0;
    if (stamp > 0 && !Object.keys(lost).length) {
      res.set("ETag", `"${stamp}"`);
      res.set("Cache-Control", "no-cache");
      if (canvasEtagHit(req.headers["if-none-match"], stamp)) return res.status(304).end();
    }
    res.json({ name: name || undefined, ...state, ...(Object.keys(lost).length ? { lost } : {}) });
  } catch (e) {
    // 读不出来就明说读不出来。以前这一层拿到的是一张空画布（tools 里一个 catch 全吞了），
    // 界面照着画成白板，用户在白板上随手一动、自动保存一回，原文件就没了
    // 这里绝不能带 nodes/edges。带了的话，只看 body 不看状态码的那条路就会把它当成
    // 一张空画布——白板 + 自动保存，正好是这一整套防护要拦的那场事故
    res.status(409).json({ error: e.message, unreadable: true });
  }
});
app.put("/api/canvas", (req, res) => {
  try {
    const body = req.body || {};
    const name = body.name || undefined;
    // 名字会被 canvasSafeName 改写（带斜杠、超长、「..」）就不收：改写的去向是 main，
    // 照写等于拿这一份去盖主画布——跟新建画布那条是同一个坑
    if (name !== undefined && canvasSafeName(name) !== String(name)) return res.status(400).json({ ok: false, error: "画布名称不合法" });
    // 盘上那份正读不出来的时候，绝不许覆盖。
    // 少了这道闸，「打开 → 报错 → 界面照常自动存一次」这条路照样能把一个坏掉但还有救的
    // 文件盖成空画布。真要盖，得用户自己说「就用我现在屏幕上这份」（force），
    // 而那时候原件已经在 .坏了-*.bak 里躺着了
    let disk = null;
    try { disk = canvasReadState(name); } catch (e) {
      if (!body.force) return res.status(409).json({ ok: false, unreadable: true, error: "盘上那份画布现在读不出来，所以没覆盖它：" + e.message });
    }
    // 乐观并发：前端带着它上次读到的版本号（updatedAt）来写。盘上已经不是那一版了——
    // 另一个标签页、Agent 的 canvas_manage、一键合成的写回，谁先写过——就不写，把盘上最新的那份还回去，
    // 由前端按节点合并后再带新版本号来存。不带 baseUpdatedAt 的老调用照旧直接写；force 是用户明说「就用我这份」
    if (!body.force && body.baseUpdatedAt != null && body.baseUpdatedAt !== "") {
      const base = Number(body.baseUpdatedAt);
      if (!Number.isFinite(base)) return res.status(400).json({ ok: false, error: "baseUpdatedAt 不是数字" });
      const now = Number(disk && disk.updatedAt) || 0;
      if (base !== now) return res.status(409).json({ ok: false, conflict: true, name, state: disk, error: "这张画布在别处改过了，这次没存" });
    }
    canvasTickPast(disk && disk.updatedAt);
    const saved = canvasWriteState(canvasNormalizeState(body.state || body), name);
    res.json({ ok: true, name, updatedAt: saved.updatedAt, state: saved });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
/**
 * 画布名 → canvases/ 下那个文件的绝对路径；落到目录外面、或名字会被 canvasSafeName 改写，就返回 ""。
 *
 * 名字是从 URL 里来的：DELETE 的 :name 会被解码，..%2F..%2F分镜表 到这儿就是 ../../分镜表，
 * 以前直接 path.join + unlinkSync，删得到工作区里任何一个 .json（包括主画布 canvas.json 本身）。
 * 只认 canvases/ 的直接下一层：画布就住在那一层，再往下、往上都不是画布。
 */
function resolveBoardFile(name) {
  name = String(name || "");
  if (!name || canvasSafeName(name) !== name) return "";
  const dir = path.resolve(getWorkspaceDir(), ".openworkbuddy", "canvases");
  const file = path.resolve(dir, name + ".json");
  const rel = path.relative(dir, file);
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel) || path.dirname(rel) !== ".") return "";
  // 还得正好是「名字.json」：Windows 上「c:x」这种带盘符的名字 resolve 完落在目录里的 x.json，
  // 查的是一个文件、canvasWriteState 写的是另一个（c:x.json），撞名判断就白做了
  if (rel !== name + ".json") return "";
  return file;
}
// 新建前先看一眼：名字会被改写（回落成 main），或盘上已经有这个文件（macOS 不分大小写，Foo 撞 foo），
// 就 409，一个字节都不写。以前照写不误，结果是拿空画布把 main / 同名那张整个盖掉
app.post("/api/canvas/boards", (req, res) => {
  try {
    const name = String(req.body && req.body.name || "").trim();
    if (!name || /[\\/\0]/.test(name) || name.length > 80) throw new Error("画布名称不合法");
    const file = resolveBoardFile(name), taken = name === "main" || !!file && fs.existsSync(file) || canvasList().some((item) => item.name === name);
    if (!file || taken) return res.status(409).json({ ok: false, error: file ? "已经有同名画布，请换一个名称" : "这个名称存不成单独的画布，请换一个" });
    const state = canvasWriteState({ version: 2, nodes: [], edges: [], updatedAt: 0 }, name, { pristine: true });
    res.json({ ok: true, name, state, canvases: canvasList() });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete("/api/canvas/boards/:name", (req, res) => {
  try {
    const name = String(req.params.name || "");
    if (!name || name === "main") throw new Error("主画布不能删除");
    const file = resolveBoardFile(name);
    if (!file) throw new Error("画布名称不合法");
    if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: "没有这张画布" });
    fs.unlinkSync(file);
    res.json({ ok: true, canvases: canvasList() });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/**
 * deps：getWorkspaceDir / outputFiles / safePath / canvasList / canvasReadState / canvasWriteState /
 * canvasNormalizeState / canvasSafeName 来自 tools.js；rootedPath 是 server.js 的（要按请求找租户根）；
 * readDramaJson 来自 routes/drama.js。
 */
function createCanvasRouter(deps) {
  ({ getWorkspaceDir, outputFiles, safePath, rootedPath, canvasList, canvasReadState, canvasWriteState, canvasNormalizeState, canvasSafeName, readDramaJson } = deps);
  return app;
}

// 素材定位这几样合成那头也要用（lib/compose-jobs.js），由 server.js 通过 deps 递过去
module.exports = { createCanvasRouter, assetBase, canvasAssetLocator, canvasAssetNear, canvasTickPast };
