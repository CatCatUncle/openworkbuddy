"use strict";
/**
 * 精灵图宠物：直接吃 Codex / Petdex 那套格式，不自己造轮子。
 *
 * 为什么是「吃别人的格式」而不是「自己也能孵一只」：
 *   孵一只的成本是真金白银。实测过的人报的数是 —— 主参考图等 3 分钟，9 组动画帧
 *   并行生成又等了 1 小时，孵第二只直接把 5 小时额度用光。而 Codex 那边的格式是
 *   公开的、有现成画廊（petdex.dev）、用户一条 `npx petdex install <名字>` 就装好了。
 *   我们只要会读，就白嫖了整个生态，一分钱生成费不花。
 *
 * 格式（从 petdex 的源码里核出来的，不是看文章转述）：
 *   目录：~/.codex/pets/<slug>/ 或 ~/.petdex/pets/<slug>/
 *   文件：pet.json（{id, displayName, description}）+ spritesheet.webp|png
 *   图集：8 列 × 9 行，单帧 192×208，整图 1536×1872
 *         ChatGPT 导出的是 1536×2288（11 行），前 9 行与上面完全一致，多出来的两行忽略
 *   行序：见 ROWS —— 顺序是格式的一部分，不能猜
 *
 * 这里刻意不引任何图像库：只需要读出宽高来校验，PNG/WebP 的文件头自己解就够了。
 * 装一个 sharp 来读两个数字，对一个「桌面挂件」是不成比例的依赖。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { dataPath } = require("./paths");

/** 一帧的原始尺寸。整图必须是它的整数倍（允许整体等比缩放过的图集）。 */
const FRAME_W = 192;
const FRAME_H = 208;
const COLS = 8;

/**
 * 9 个状态各占一行，行号就是它在图集里的位置。frames 是这一行真正用了几列
 * （不足 8 列的后面是空的，播过去会闪一下空白），durationMs 是走完一轮的时长。
 * 这份表来自 petdex 的 pet-states.ts，逐字对齐；改动它等于改动兼容性。
 */
const ROWS = [
  { id: "idle", row: 0, frames: 6, durationMs: 1100 },
  { id: "running-right", row: 1, frames: 8, durationMs: 1060 },
  { id: "running-left", row: 2, frames: 8, durationMs: 1060 },
  { id: "waving", row: 3, frames: 4, durationMs: 700 },
  { id: "jumping", row: 4, frames: 5, durationMs: 840 },
  { id: "failed", row: 5, frames: 8, durationMs: 1220 },
  { id: "waiting", row: 6, frames: 6, durationMs: 1010 },
  { id: "running", row: 7, frames: 6, durationMs: 820 },
  { id: "review", row: 8, frames: 6, durationMs: 1030 },
];

/**
 * 我们自己的状态词汇 → 它的行。
 *
 * 对应关系不是随便配的，按的是这套动画本来的语义：
 *   跳跃 = 需要你做决定 → asking；挥手 = 打招呼/交付 → done；failed 就是出错。
 * walk-left / walk-right 是我们新加的（宠物会自己溜达），正好白拿它的方向跑动画。
 * review 也一并暴露出来：以后「等你审阅产出」是个真状态，现在先接上不浪费。
 */
const STATE_ROW = {
  idle: "idle",
  working: "running",
  asking: "jumping",
  done: "waving",
  error: "failed",
  sleep: "waiting",
  review: "review",
  "walk-left": "running-left",
  "walk-right": "running-right",
};

/* ------------------------------------------------------------------ *
 * 图片尺寸：只读文件头，不解码像素
 * ------------------------------------------------------------------ */

/** PNG：签名 8 字节，紧接着必然是 IHDR，宽高是两个大端 uint32（偏移 16 / 20） */
function pngSize(buf) {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * WebP 有三种子格式，宽高各藏各的地方：
 *   VP8X（带 alpha/动画的扩展头）：24 起两个 3 字节小端，存的是「尺寸 - 1」
 *   VP8 （有损）：26 起两个 16 位小端，低 14 位才是尺寸
 *   VP8L（无损）：21 起 4 字节里挤了两个 14 位，同样存「尺寸 - 1」
 * Codex 导出的是带 alpha 的 webp，实际走的是 VP8X 这条；另外两条一并支持，
 * 免得用户从画廊下到的是别的编码器出的图就报「读不出尺寸」。
 */
function webpSize(buf) {
  if (buf.length < 30) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const kind = buf.toString("ascii", 12, 16);
  if (kind === "VP8X") {
    return { width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1, height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1 };
  }
  if (kind === "VP8 ") {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (kind === "VP8L") {
    if (buf[20] !== 0x2f) return null;
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** 读图集尺寸；认不出来就返回 null（调用方要如实报错，不许猜一个默认值糊过去） */
function imageSize(file) {
  let buf;
  try { buf = Buffer.alloc(64); const fd = fs.openSync(file, "r"); fs.readSync(fd, buf, 0, 64, 0); fs.closeSync(fd); }
  catch { return null; }
  return pngSize(buf) || webpSize(buf);
}

/* ------------------------------------------------------------------ *
 * 校验与扫描
 * ------------------------------------------------------------------ */

/**
 * 图集合不合规。允许整体等比缩放（有人把 1536×1872 压成一半再上传），
 * 但列数必须是 8、行数必须 ≥ 9，且每帧得是整数像素——差半个像素切出来的图会带上邻帧的边。
 */
function checkSheet(size) {
  if (!size) return { ok: false, why: "读不出图片尺寸（不是 PNG / WebP？）" };
  const { width, height } = size;
  const fw = width / COLS;
  if (!Number.isInteger(fw)) return { ok: false, why: `宽 ${width} 不是 8 列的整数倍` };
  const scale = fw / FRAME_W;
  const fh = FRAME_H * scale;
  if (!Number.isInteger(fh)) return { ok: false, why: `宽高比对不上 192×208 的单帧（宽 ${width}）` };
  const rows = height / fh;
  if (!Number.isInteger(rows)) return { ok: false, why: `高 ${height} 切不出整数行（单帧高 ${fh}）` };
  if (rows < ROWS.length) return { ok: false, why: `只有 ${rows} 行，至少要 ${ROWS.length} 行` };
  return { ok: true, width, height, cols: COLS, rows, frameW: fw, frameH: fh, scale };
}

/** 我们自己的窝：用户手动拖进来的宠物放这儿，跟着数据目录一起备份 */
function localRoot() {
  try { return dataPath("data", "pets"); } catch { return ""; }
}

/**
 * 宠物窝：自己的排最前（同 id 时用户手动放的赢），然后是 Codex 和 Petdex 各一个。
 * 传 extraRoot 可以覆盖「自己的」那一格——测试时指到临时目录，不碰用户真实的家目录。
 */
function petRoots(extraRoot) {
  const home = os.homedir();
  const mine = extraRoot === undefined ? localRoot() : extraRoot;
  const roots = [
    { dir: path.join(home, ".codex", "pets"), source: "codex" },
    { dir: path.join(home, ".petdex", "pets"), source: "petdex" },
  ];
  if (mine) roots.unshift({ dir: mine, source: "本机" });
  return roots;
}

const SHEET_NAMES = ["spritesheet.webp", "spritesheet.png", "sprite.webp", "sprite.png"];

/** 一个目录是不是一只宠物：得同时有 pet.json 和图集 */
function readPetDir(dir, source) {
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, "pet.json"), "utf8")); } catch { return null; }
  const name = SHEET_NAMES.find((n) => { try { return fs.statSync(path.join(dir, n)).isFile(); } catch { return false; } });
  if (!name) return null;
  const sheet = path.join(dir, name);
  const chk = checkSheet(imageSize(sheet));
  const id = String(meta.id || path.basename(dir)).slice(0, 80);
  return {
    id,
    displayName: String(meta.displayName || id).slice(0, 60),
    description: String(meta.description || "").slice(0, 200),
    dir, sheet, source,
    ok: chk.ok, why: chk.why || "",
    cols: chk.cols || 0, rows: chk.rows || 0, frameW: chk.frameW || 0, frameH: chk.frameH || 0,
  };
}

/**
 * 扫出本机所有能用的精灵图宠物。同名（同 id）时先扫到的赢——
 * petdex install 会同时往 ~/.petdex 和 ~/.codex 各放一份，不去重会看到两只一模一样的。
 */
function scanPets(extraRoot) {
  const out = [];
  const seen = new Set();
  for (const { dir, source } of petRoots(extraRoot)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.sort()) {
      const sub = path.join(dir, n);
      try { if (!fs.statSync(sub).isDirectory()) continue; } catch { continue; }
      const p = readPetDir(sub, source);
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
  }
  return out;
}

/** 按 id 找一只；找不到返回 null（调用方回落到内置猫，但要说清楚为什么） */
function findPet(id, extraRoot) {
  if (!id) return null;
  return scanPets(extraRoot).find((p) => p.id === id && p.ok) || null;
}

/** 图集转 data URL 推给渲染进程。宠物窗口是 loadFile 起来的，不给它开 HTTP 通道。 */
function sheetDataUrl(pet) {
  if (!pet || !pet.sheet) return "";
  const mime = pet.sheet.endsWith(".png") ? "image/png" : "image/webp";
  try { return `data:${mime};base64,` + fs.readFileSync(pet.sheet).toString("base64"); } catch { return ""; }
}

/** 渲染进程要的那份：动画表 + 我们的状态怎么落到行上。图集本身另外走 data URL。 */
function spriteSpec(pet) {
  if (!pet || !pet.ok) return null;
  const byId = Object.fromEntries(ROWS.map((r) => [r.id, r]));
  const map = {};
  for (const [mine, theirs] of Object.entries(STATE_ROW)) {
    const r = byId[theirs];
    if (r && r.row < pet.rows) map[mine] = { row: r.row, frames: r.frames, durationMs: r.durationMs };
  }
  return { id: pet.id, cols: pet.cols, rows: pet.rows, frameW: pet.frameW, frameH: pet.frameH, map };
}

module.exports = {
  FRAME_W, FRAME_H, COLS, ROWS, STATE_ROW,
  pngSize, webpSize, imageSize, checkSheet,
  petRoots, localRoot, readPetDir, scanPets, findPet, sheetDataUrl, spriteSpec,
};
