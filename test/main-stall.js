// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 桌面主进程（= 界面线程）卡顿：常开的卡顿记录说得对不对，缩图三件活是不是真挪出了界面线程。
 *
 * 跑法：node test/main-stall.js
 *
 * 2026-09-29 用户说「多开任务对话就卡」。量下来两件事：
 *   - 浸泡测试报的主线程 2000ms 是合盖睡了 181 秒，不是卡——量迟到的钟睡着也走，于是把睡眠算成了卡顿
 *   - 真卡的是 image.thumb / image.shrinkForVision / image.petPhoto：nativeImage 在主进程里同步解码缩放编码，
 *     一张 6016² 的照片 145–181ms、4032 的 40–61ms。资料库一屏照片封面就是一串这样的卡顿
 *
 * 全部用假钟、数次数，不看墙钟快慢：
 *   【1】卡顿记录：门槛、睡眠不算（★反向对照★ 只有一个钟时 181 秒睡眠被记成卡顿）、刚醒那阵不算、
 *        十秒一行（★反向对照★ 不限流时五次卡五行）、行里只有活的名字没有参数
 *   【2】桥上每件活同步占了多久，卡顿那行点得出名
 *   【3】读图片尺寸只看文件头（EXIF 很长的 JPEG 要接着往后读，★反向对照★ 只读头 64KB 读不出来）
 *   【4】sips 那条路的排队：同时最多两个（★反向对照★ 不限就八个一起上）、排太久的缩略图不做了、参数对
 *   【5】只在 macOS 上用真 sips：三件活主线程上一次 nativeImage 都不调（★反向对照★ 老路子三次），
 *        出来的尺寸、中心、说明文字跟老路子一样；读不出的图退回老路子，结果照旧
 *   【6】网页截图（htmlshot）capturePage 之后的 toPNG 同步 258–272ms（2 倍屏 1242×1656），整页 1.28s：
 *        界面线程上只 toBitmap 拷一次（3ms），PNG 在线程里编。解回来逐像素一样；★反向对照★ 老路子 toPNG 调一次；
 *        线程起不来、不回话、图太大一律退回 toPNG，图照样出
 *   【7】Windows 没有 sips，三件活交给常驻的隐藏网页窗口（browser-render.js createRenderPixels）：
 *        主线程上一次 nativeImage 都不调（★反向对照★ 老路子每件一次），尺寸、格式、说明文字跟老路子一样，
 *        中心裁方、EXIF 转正、同时最多两张（★反向对照★ 不设上限六张一起上）、排太久不做、
 *        坏图 / 读不到 / 不回话退回老路子并留痕、窗口从不亮出来、闲了自己收
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const { EventEmitter } = require("events");
const { mod } = require("./lib/mod");
const { entry } = require("./lib/entry");

const ROOT = path.join(__dirname, "..");
const { createShellBridge, createOpTracker, createStallWatch } = require(mod("bridge-main"));
const PX = require(mod("thumb-sips"));

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-main-stall-"));
let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail))); }
};
process.on("exit", (code) => {
  if (!code && !fail) { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {} }
  else console.log("留着现场：" + HOME);
});

/** 假钟：单调钟 T、墙钟 W，各走各的 */
function clocks() {
  const c = { T: 1000, W: 1_800_000_000_000 };
  return { c, now: () => c.T, wall: () => c.W, step: (mono, wallExtra = 0) => { c.T += mono; c.W += mono + wallExtra; } };
}

/** 一张真能解的 PNG，按 px(x,y) 上色；不靠任何图像库 */
function makePng(w, h, px) {
  const zlib = require("zlib");
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; const [r, g, b] = px(x, y); raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** 自带的 PNG 解码（8 位 RGB / RGBA，五种行滤波），不借被测代码：出 RGBA、每行的滤波号、CRC 对不对 */
function decodePng(buf) {
  const zlib = require("zlib");
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  let p = 8, w = 0, h = 0, ct = 0, crcOk = true;
  const idat = [];
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (crc(buf.subarray(p + 4, p + 8 + len)) !== buf.readUInt32BE(p + 8 + len)) crcOk = false;
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    else if (type === "IDAT") idat.push(d);
    p += 12 + len;
  }
  const ch = ct === 6 ? 4 : 3, stride = w * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(w * h * 4), filters = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    filters.push(f);
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < ch; k++) rgba[(y * w + x) * 4 + k] = line[x * ch + k];
      if (ch === 3) rgba[(y * w + x) * 4 + 3] = 255;
    }
    prev = line;
  }
  return { w, h, ct, rgba, filters, crcOk };
}

(async () => {
  console.log("【1】卡顿记录（假钟）");
  {
    const k = clocks();
    const lines = [];
    const sw = createStallWatch({ thresholdMs: 250, tickMs: 100, now: k.now, wall: k.wall, write: (l) => lines.push(l) });
    k.step(100); sw.tick();
    k.step(100 + 249); sw.tick();
    ok(sw.counts.stalls === 0 && lines.length === 0, "迟到 249ms（门槛 250）不算卡", sw.counts);
    k.step(100 + 250); sw.tick();
    ok(sw.counts.stalls === 1 && lines.length === 1 && /界面线程卡了 250ms/.test(lines[0]) && /没有$/.test(lines[0]),
      "迟到 250ms 记一行；桥上没活就写「没有」", lines);

    // 合盖睡 181 秒：单调钟不走，墙钟走了 181 秒（2026-09-29 那个 2000ms 就是这么来的）
    const before = sw.counts.stalls;
    k.step(100, 181000); sw.tick();
    ok(sw.counts.stalls === before && sw.counts.slept === 1 && lines.length === 1, "睡过一觉（墙钟比单调钟多走 181 秒）：不算卡、不写行", sw.counts);
    // ★反向对照★ 老的量法只有一个钟（Date.now）：同一段睡眠就是一次 181 秒的「卡顿」
    const k2 = clocks();
    const old = createStallWatch({ thresholdMs: 250, now: k2.wall, wall: k2.wall });
    k2.step(100, 181000); old.tick();
    ok(old.counts.stalls === 1 && old.maxMs >= 180000, "★反向对照★ 只拿墙钟量：同一段睡眠被记成一次 181 秒的卡顿", { stalls: old.counts.stalls, max: old.maxMs });

    // 刚醒那阵系统压着 CPU：pause 期间不记
    sw.pause(30000);
    k.step(100 + 600); sw.tick();
    ok(sw.counts.paused === 1 && sw.counts.stalls === before, "刚醒来（pause 30 秒）这一拍迟到 600ms 不算", sw.counts);
    for (let t = 0; t < 30000; t += 100) { k.step(100); sw.tick(); }   // 准点走 30 秒
    k.step(100 + 600); sw.tick();
    ok(sw.counts.stalls === before + 1, "pause 过了照常记", sw.counts);
  }
  {
    // 十秒一行：连卡五次只写一行，下一行带上中间没单独记的次数
    const k = clocks();
    const lines = [];
    const sw = createStallWatch({ thresholdMs: 250, now: k.now, wall: k.wall, write: (l) => lines.push(l) });
    const idle = (kk, w, ms) => { for (let t = 0; t < ms; t += 100) { kk.step(100); w.tick(); } };   // 准点走
    for (let i = 0; i < 5; i++) { k.step(100 + 300); sw.tick(); idle(k, sw, 600); }
    ok(sw.counts.stalls === 5 && lines.length === 1 && sw.counts.suppressed === 4, "十秒内连卡 5 次只写 1 行，其余 4 次计数", { ...sw.counts, lines: lines.length });
    idle(k, sw, 10000);
    k.step(100 + 300); sw.tick();
    ok(lines.length === 2 && /上一行之后还卡过 4 次没单独记/.test(lines[1]), "十秒后下一行带上「还卡过 4 次」", lines[1]);
    const k2 = clocks();
    const all = [];
    const noLimit = createStallWatch({ thresholdMs: 250, minGapMs: 0, now: k2.now, wall: k2.wall, write: (l) => all.push(l) });
    for (let i = 0; i < 5; i++) { k2.step(100 + 300); noLimit.tick(); idle(k2, noLimit, 600); }
    ok(all.length === 5, "★反向对照★ 不限流（minGapMs 0）：同样 5 次卡顿写 5 行", all.length);
  }

  console.log("\n【2】桥上的活：同步占了多久、卡顿那行点得出名、参数一个字不留");
  {
    const k = clocks();
    const ops = createOpTracker({ now: k.now });
    const lines = [];
    const sw = createStallWatch({ thresholdMs: 100, minGapMs: 0, now: k.now, wall: k.wall, ops, write: (l) => lines.push(l) });
    const shell = createShellBridge({
      electron: {}, ops,
      impl: {
        // 同步啃了 180ms 的活（老的 image.thumb 就是这个样子）
        "image.thumb": () => { k.step(180); return Buffer.from("x"); },
        // 同步那截几乎为零、异步等了很久：不该算它卡界面
        "shot.html": async () => { await new Promise((r) => setTimeout(r, 5)); k.step(400); return 1; },
      },
    });
    const call = (op, args) => new Promise((res) => shell.handle({ t: "call", id: 1, op, args }, res));
    k.step(100); sw.tick();
    const secret = "/Users/someone/Pictures/私密相册/IMG_0001.jpg";
    const r = await call("image.thumb", { abs: secret, w: 320 });
    k.step(100); sw.tick();
    const st = ops.stats()["image.thumb"];
    ok(r.ok && st && st.n === 1 && Math.round(st.syncMax) === 180 && st.over100 === 1, "同步段记下来：image.thumb 180ms、超 100 的一次", st);
    ok(lines.length === 1 && /卡了 180ms/.test(lines[0]) && /image\.thumb/.test(lines[0]), "卡顿那行点名 image.thumb", lines);
    ok(!lines.some((l) => l.includes("私密相册") || l.includes("IMG_0001") || l.includes("/Users/")), "行里只有活的名字，路径一个字都没有", lines);
    const r2 = await call("shot.html", { htmlPath: secret });
    const s2 = ops.stats()["shot.html"];
    ok(r2.ok && s2 && s2.syncMax < 1 && s2.over50 === 0, "异步等着的活（400ms 都在 await 里）同步段记 0，不背卡顿的锅", s2);
    ok(ops.live === 0, "做完的活都收了账", ops.live);
  }

  console.log("\n【3】读图片尺寸只看文件头");
  {
    const png = makePng(37, 21, () => [1, 2, 3]);
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([0x2c, 0x01, 0x90, 0x00]), Buffer.alloc(20)]);
    const bmp = Buffer.alloc(60); bmp.write("BM"); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(640, 18); bmp.writeInt32LE(-480, 22);
    const webp = (kind, body) => { const b = Buffer.alloc(40); b.write("RIFF"); b.write("WEBP", 8); b.write(kind, 12); body(b); return b; };
    const vp8 = webp("VP8 ", (b) => { b.writeUInt16LE(1000, 26); b.writeUInt16LE(750, 28); });
    const vp8x = webp("VP8X", (b) => { b.writeUIntLE(4031, 24, 3); b.writeUIntLE(3023, 27, 3); });
    // VP8L：14 位宽-1、14 位高-1 紧挨着塞在 21 起的四个字节里
    const vp8l = webp("VP8L", (b) => { const v = (800 - 1) | ((600 - 1) << 14); b[20] = 0x2f; b.writeUInt32LE(v >>> 0, 21); });
    const got = [png, gif, bmp, vp8, vp8x, vp8l].map((b) => PX.parseSize(b));
    ok(JSON.stringify(got) === JSON.stringify([{ width: 37, height: 21 }, { width: 300, height: 144 }, { width: 640, height: 480 },
      { width: 1000, height: 750 }, { width: 4032, height: 3024 }, { width: 800, height: 600 }]), "PNG / GIF / BMP / WebP 三种都读得出", got);
    // JPEG：SOF 前面隔着一段 70KB 的 APP1（手机照片的 EXIF + 内嵌预览图就这个量级）
    const app1 = Buffer.alloc(4 + 65000); app1[0] = 0xff; app1[1] = 0xe1; app1.writeUInt16BE(65002, 2);
    const app2 = Buffer.alloc(4 + 9000); app2[0] = 0xff; app2[1] = 0xe2; app2.writeUInt16BE(9002, 2);
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xd0, 0x0f, 0xc0, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, app2, sof, Buffer.from([0xff, 0xda]), Buffer.alloc(100)]);
    const f = path.join(HOME, "exif-heavy.jpg");
    fs.writeFileSync(f, jpg);
    const sz = await PX.imageSize(f);
    ok(sz && sz.width === 4032 && sz.height === 3024, "EXIF 70KB 的 JPEG：接着往后读，读到 4032×3024", sz);
    const head = PX.parseSize(jpg.subarray(0, 64 * 1024));
    ok(head && "jpegAt" in head && !("width" in head), "★反向对照★ 只看头 64KB：读不出尺寸（只知道该从哪儿接着读）", head);
    fs.writeFileSync(path.join(HOME, "junk.png"), Buffer.from("definitely not an image"));
    ok((await PX.imageSize(path.join(HOME, "junk.png"))) === null && (await PX.imageSize(path.join(HOME, "nope.jpg"))) === null,
      "认不出的、不存在的：回 null（调用方退回老路子）");
  }

  console.log("\n【4】sips 那条路的排队（假 sips，哪个系统都跑）");
  {
    // 假 spawn：记下参数，等外面放行才写产物、退 0。放行前数一数同时有几个在跑。
    // 产物照真 sips 的样子写：真 PNG / JPEG，还带着从原图抄来的定位（GPS）——交出去之前得洗掉
    const GPS = "GPS 31.2304N 121.4737E";
    const CLEAN_PNG = makePng(2, 2, () => [9, 9, 9]);
    const pngChunk = (type, data) => { const n = Buffer.alloc(4); n.writeUInt32BE(data.length); return Buffer.concat([n, Buffer.from(type), data, Buffer.alloc(4)]); };
    const DIRTY_PNG = Buffer.concat([CLEAN_PNG.subarray(0, 33), pngChunk("tEXt", Buffer.from("Comment\0" + GPS)), pngChunk("eXIf", Buffer.from(GPS)), CLEAN_PNG.subarray(33)]);
    const jseg = (m, data) => { const h = Buffer.from([0xff, m, 0, 0]); h.writeUInt16BE(data.length + 2, 2); return Buffer.concat([h, data]); };
    const JFIF = jseg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"));
    const SCAN = Buffer.concat([Buffer.from([0xff, 0xda]), Buffer.alloc(16, 7), Buffer.from([0xff, 0xd9])]);
    const CLEAN_JPG = Buffer.concat([Buffer.from([0xff, 0xd8]), JFIF, SCAN]);
    const DIRTY_JPG = Buffer.concat([Buffer.from([0xff, 0xd8]), JFIF, jseg(0xe1, Buffer.from("Exif\0\0" + GPS, "latin1")), jseg(0xfe, Buffer.from(GPS)), SCAN]);
    let junkNext = false; // 下一趟吐一份认不出结构的产物（sips 换了输出格式、写了一半之类）
    const mk = () => {
      const runs = [];
      let live = 0, peak = 0;
      const spawn = (cmd, args) => {
        const child = new EventEmitter();
        /** @type {any} */ (child).pid = 0;
        /** @type {any} */ (child).kill = () => {};
        live++; peak = Math.max(peak, live);
        const out = args[args.indexOf("--out") + 1];
        const junk = junkNext; junkNext = false;
        runs.push({ cmd, args, finish: () => { fs.writeFileSync(out, junk ? Buffer.from("PNGDATA") : /\.jpg$/.test(out) ? DIRTY_JPG : DIRTY_PNG); live--; child.emit("exit", 0); } });
        return child;
      };
      return { spawn, runs, peak: () => peak };
    };
    const sizes = { "/big.jpg": { width: 4032, height: 3024 }, "/small.jpg": { width: 200, height: 100 }, "/wide.png": { width: 900, height: 300 }, "/tall.png": { width: 300, height: 900 } };
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const drain = async (f) => { for (let i = 0; i < 50 && f.runs.some((r) => !r.done); i++) { for (const r of f.runs) if (!r.done) { r.done = true; r.finish(); } await settle(); } };

    const f = mk();
    const px = PX.createSipsPixels({ spawn: f.spawn, sizeOf: async (a) => sizes[a] || null, tmpRoot: HOME });
    const all = Promise.all(Array.from({ length: 8 }, () => px.thumb("/big.jpg", 320)));
    await settle();
    const early = f.runs.length;
    await drain(f);
    const res = await all;
    ok(early === 2 && f.peak() === 2 && f.runs.length === 8 && res.every((r) => r && r.value && r.value.equals(CLEAN_PNG)),
      "8 张一起要：同时只跑 2 个 sips，8 张都出来", { early, peak: f.peak(), runs: f.runs.length, ok: res.filter((r) => r && r.value).length });
    const g = mk();
    const wide = PX.createSipsPixels({ spawn: g.spawn, sizeOf: async (a) => sizes[a] || null, tmpRoot: HOME, max: 99 });
    const all2 = Promise.all(Array.from({ length: 8 }, () => wide.thumb("/big.jpg", 320)));
    await settle();
    ok(g.peak() === 8, "★反向对照★ 不限并发：8 个 sips 一起上", g.peak());
    await drain(g); await all2;

    const a0 = f.runs.length;
    const small = await px.thumb("/small.jpg", 320);
    ok(small && small.value === null && f.runs.length === a0, "本来就不比 320 大：不起 sips，回「发原图」", small);
    const t = px.thumb("/big.jpg", 320); await settle(); await drain(f); await t;
    const v1 = px.shrinkForVision("/big.jpg", 1568, 82); await settle(); await drain(f);
    const vr = await v1;
    const v2 = px.shrinkForVision("/small.jpg", 1568, 82); await settle(); await drain(f); await v2;
    const p1 = px.petPhoto("/wide.png"); await settle(); await drain(f);
    const pr = await p1;
    const p2 = px.petPhoto("/tall.png"); await settle(); await drain(f); await p2;
    const args = f.runs.slice(a0).map((r) => r.args.slice(3, -2).join(" "));
    ok(f.runs.slice(a0).every((r) => r.cmd === "/usr/bin/nice" && r.args[0] === "-n" && r.args[1] === "10"), "sips 走 nice -n 10（背景活不抢前台）", f.runs.slice(a0).map((r) => r.cmd));
    ok(JSON.stringify(args) === JSON.stringify([
      "-s format png -Z 320 /big.jpg",
      "-s format jpeg -s formatOptions 82 -Z 1568 /big.jpg",
      "-s format jpeg -s formatOptions 82 /small.jpg",
      "-s format png --resampleHeight 320 -c 320 320 /wide.png",
      "-s format png --resampleWidth 320 -c 320 320 /tall.png",
    ]), "参数：缩略图 -Z、压图只在超长时 -Z、宠物先把短边缩到 320 再中心裁", args);
    ok(vr && vr.value.width === 4032 && vr.value.height === 3024 && pr && /原图 900×300 不是正方形/.test(pr.value.note), "压图带回原图宽高；宠物说明写原图尺寸", { vr: vr && [vr.value.width, vr.value.height], note: pr && pr.value.note });
    ok(vr && vr.value.jpg.equals(CLEAN_JPG) && pr && pr.value.png.equals(CLEAN_PNG),
      "sips 从原图抄来的 EXIF / 文字块（里头有定位）洗掉了：JPEG 只剩 JFIF 和图像数据，PNG 只剩图像块",
      { jpg: vr && vr.value.jpg.includes(GPS), png: pr && pr.value.png.includes(GPS) });
    ok((await px.thumb("/unknown.jpg", 320)) === null && px.counts.fallbacks === 1, "读不出尺寸：回 null，记一次退回老路子", px.counts);
    junkNext = true;
    const jk = px.thumb("/big.jpg", 320); await settle(); await drain(f);
    ok((await jk) === null && px.counts.fallbacks === 2, "产物认不出结构（洗不了）：回 null 退回老路子，不把没洗干净的图交出去", px.counts);

    // 排太久的缩略图：服务进程那头 10 秒就不等了，轮到时已过 9 秒就不做
    const h = mk();
    let T = 0;
    const slow = PX.createSipsPixels({ spawn: h.spawn, sizeOf: async (a) => sizes[a] || null, tmpRoot: HOME, now: () => T });
    const q = [slow.thumb("/big.jpg", 320), slow.thumb("/big.jpg", 320), slow.thumb("/big.jpg", 320)];
    await settle();
    T += 9500;
    await drain(h);
    const qr = await Promise.all(q);
    ok(h.runs.length === 2 && slow.counts.stale === 1 && qr[2] && qr[2].value === null, "第 3 张排了 9.5 秒才轮到：不起 sips，回「发原图」", { runs: h.runs.length, ...slow.counts });
    const i2 = mk();
    let T2 = 0;
    const patient = PX.createSipsPixels({ spawn: i2.spawn, sizeOf: async (a) => sizes[a] || null, tmpRoot: HOME, now: () => T2, staleMs: 1e9 });
    const q2 = [patient.thumb("/big.jpg", 320), patient.thumb("/big.jpg", 320), patient.thumb("/big.jpg", 320)];
    await settle(); T2 += 9500; await drain(i2); await Promise.all(q2);
    ok(i2.runs.length === 3, "★反向对照★ 不看排队时长：没人收的那张照样缩", i2.runs.length);
    for (const p of [px, wide, slow, patient]) p.close();
  }

  console.log("\n【5】真 sips：三件活不在主线程上碰 nativeImage（只在 macOS 上）");
  if (process.platform !== "darwin" || !fs.existsSync(PX.SIPS)) {
    console.log("  跳过：不是 macOS（sips 只有 macOS 有，别的系统上这三件活还是 nativeImage）");
  } else {
    // 900×300 三段色：左红中绿右蓝。中心裁方以后整张都该是绿的
    const src = path.join(HOME, "bands.png");
    fs.writeFileSync(src, makePng(900, 300, (x) => (x < 300 ? [255, 0, 0] : x < 600 ? [0, 255, 0] : [0, 0, 255])));
    const jpg = path.join(HOME, "photo-2400x1800.jpg");
    fs.writeFileSync(path.join(HOME, "p.png"), makePng(2400, 1800, (x, y) => [(x * 7) & 255, (y * 3) & 255, 128]));
    cp.spawnSync("/usr/bin/sips", ["-s", "format", "jpeg", path.join(HOME, "p.png"), "--out", jpg], { stdio: "ignore" });
    const broken = path.join(HOME, "broken.png");
    fs.writeFileSync(broken, Buffer.concat([makePng(900, 300, () => [0, 0, 0]).subarray(0, 40), Buffer.alloc(200)]));

    const made = [];
    const fakeElectron = () => FAKE_E;
    const FAKE_E = (() => {
      const img = (w, h) => ({
        isEmpty: () => !(w > 0 && h > 0),
        getSize: () => ({ width: w, height: h }),
        crop: (r) => img(r.width, r.height),
        resize: (o) => img(o.width || Math.round((w * o.height) / h), o.height || Math.round((h * o.width) / w)),
        toPNG: () => Buffer.from(`png ${w}x${h}`),
        toJPEG: () => Buffer.from(`jpg ${w}x${h}`),
      });
      return { nativeImage: { createFromPath: (p) => {
        made.push(path.basename(p));
        if (p === broken) return img(0, 0);
        const s = p === src ? [900, 300] : [2400, 1800];
        return img(s[0], s[1]);
      } } };
    })();
    // 老路子的 image.thumb 走 thumb.js makeThumb，它自己 require("electron")：纯 node 里那是个路径字符串，
    // 换成同一个假的，老路子的三件活才都数得到
    let ePath = "";
    try { ePath = require.resolve("electron"); } catch {}
    const eWas = ePath ? require.cache[ePath] : undefined;
    if (ePath) require.cache[ePath] = /** @type {any} */ ({ id: ePath, filename: ePath, loaded: true, exports: FAKE_E });
    const run = async (pixels) => {
      const shell = createShellBridge({ electron: fakeElectron(), pixels });
      const call = (op, args) => new Promise((res) => shell.handle({ t: "call", id: 1, op, args }, res));
      made.length = 0;
      const pet = await call("image.petPhoto", { abs: src });
      const vis = await call("image.shrinkForVision", { abs: jpg, maxEdge: 1568, quality: 82 });
      const thumb = await call("image.thumb", { abs: jpg, w: 320 });
      return { pet, vis, thumb, made: made.slice() };
    };
    const pixels = PX.createSipsPixels({ tmpRoot: HOME });
    const now = await run(pixels);
    const old = await run(null);
    if (ePath) { if (eWas) require.cache[ePath] = eWas; else delete require.cache[ePath]; }
    ok(now.pet.ok && now.vis.ok && now.thumb.ok && now.made.length === 0, "sips 那条路：三件活主线程上一次 nativeImage 都没调", now.made);
    ok(old.made.length === 3 && old.thumb.ok && String(old.thumb.value) === "png 320x240", "★反向对照★ 不给 pixels（老路子）：三件活三次 nativeImage，全在界面线程上", { made: old.made, thumb: String(old.thumb.value) });

    const dims = (buf) => PX.parseSize(buf);
    const petPng = Buffer.from(now.pet.value.png);
    const thumbPng = Buffer.from(now.thumb.value);
    const visJpg = Buffer.from(now.vis.value.jpg);
    ok(JSON.stringify(dims(petPng)) === JSON.stringify({ width: 320, height: 320 }) && now.pet.value.note === old.pet.value.note,
      "宠物头像 320×320，说明文字跟老路子一字不差", { size: dims(petPng), now: now.pet.value.note, old: old.pet.value.note });
    // 裁得是不是中心：转成 BMP 看中间和四角的颜色，都该是绿的
    const bmpOut = path.join(HOME, "pet.bmp");
    fs.writeFileSync(path.join(HOME, "pet.png"), petPng);
    cp.spawnSync("/usr/bin/sips", ["-s", "format", "bmp", path.join(HOME, "pet.png"), "--out", bmpOut], { stdio: "ignore" });
    const b = fs.readFileSync(bmpOut);
    const off = b.readUInt32LE(10), w = b.readInt32LE(18), hh = b.readInt32LE(22), bpp = b.readUInt16LE(28) / 8;
    const row = Math.ceil((w * bpp) / 4) * 4, H = Math.abs(hh);
    const at = (x, y) => { const o = off + (hh < 0 ? y : H - 1 - y) * row + x * bpp; return [b[o + 2], b[o + 1], b[o]]; };
    const green = [at(2, 2), at(160, 160), at(317, 317)].every(([r, g, bl]) => g > 200 && r < 40 && bl < 40);
    ok(green, "中心裁方：左上、正中、右下全是中间那段绿（裁歪了会见红或蓝）", [at(2, 2), at(160, 160), at(317, 317)]);
    ok(JSON.stringify(dims(thumbPng)) === JSON.stringify({ width: 320, height: 240 }), "缩略图长边 320、比例不变", dims(thumbPng));
    ok(JSON.stringify(dims(visJpg)) === JSON.stringify({ width: 1568, height: 1176 }) && now.vis.value.width === 2400 && now.vis.value.height === 1800,
      "压图长边 1568、带回原图 2400×1800（跟老路子口径一样）", { out: dims(visJpg), orig: [now.vis.value.width, now.vis.value.height] });

    made.length = 0;
    const shell = createShellBridge({ electron: fakeElectron(), pixels });
    const r = await new Promise((res) => shell.handle({ t: "call", id: 1, op: "image.petPhoto", args: { abs: broken } }, res));
    ok(r.ok && r.value && r.value.empty === true && made.length === 1, "sips 解不了的坏图：退回老路子，照旧回 {empty:true}", { r, made });
    const tmpLeft = fs.readdirSync(HOME).filter((n) => n.startsWith("owb-px-")).flatMap((d) => fs.readdirSync(path.join(HOME, d)));
    ok(tmpLeft.length === 0, "临时产物读完就删，一个不留", tmpLeft);
    pixels.close();
    await new Promise((r2) => setTimeout(r2, 50));
    ok(fs.readdirSync(HOME).filter((n) => n.startsWith("owb-px-")).length === 0, "close() 收掉临时目录");
  }

  console.log("\n【6】网页截图的 PNG 编码不在界面线程上做（假 nativeImage，哪个系统都跑）");
  {
    const { encodeRaw, MAX_PIXELS } = require(mod("thumb-png"));
    // 直的 RGBA → 某种排布（可选乘过透明度），模拟 toBitmap 吐出来的样子
    const layoutOf = (rgba, order, premul) => {
      const out = Buffer.alloc(rgba.length);
      for (let i = 0; i < rgba.length; i += 4) {
        const a = rgba[i + 3];
        const v = { r: rgba[i], g: rgba[i + 1], b: rgba[i + 2], a };
        if (premul) for (const c of ["r", "g", "b"]) v[c] = Math.round((v[c] * a) / 255);
        for (let k = 0; k < 4; k++) out[i + k] = v[order[k]];
      }
      return out;
    };
    const grad = (w, h, alpha) => {
      const b = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        b[o] = (x * 7 + y) & 255; b[o + 1] = (y * 11) & 255; b[o + 2] = (x * y) & 255; b[o + 3] = alpha ? alpha(x, y) : 255;
      }
      return b;
    };
    const opaque = grad(37, 23);
    const bgra = layoutOf(opaque, "bgra", true);
    const d0 = decodePng(encodeRaw(bgra, 37, 23, { order: "bgra", premul: true }));
    ok(d0.crcOk && d0.w === 37 && d0.h === 23 && d0.ct === 2 && d0.rgba.equals(opaque), "不透明的图：解回来逐像素一样，存成 RGB（少存一个通道）", { ct: d0.ct, crc: d0.crcOk });
    const each = [0, 1, 2, 3, 4].map((f) => decodePng(encodeRaw(bgra, 37, 23, { order: "bgra", premul: true, filter: f })));
    ok(each.every((d, f) => d.rgba.equals(opaque) && d.filters.every((x) => x === f)), "五种行滤波各自解回来都一样", each.map((d) => d.filters[1]));
    const flat = Buffer.alloc(16 * 6 * 4, 0x80);
    ok(decodePng(encodeRaw(flat, 16, 6, { order: "bgra" })).filters.slice(1).every((f) => f === 2), "跟上一行一样的行直接用「上」滤波，不再挨个比");
    const half = grad(20, 9, (x) => (x === 0 ? 0 : x * 12));
    const dh = decodePng(encodeRaw(layoutOf(half, "bgra", true), 20, 9, { order: "bgra", premul: true }));
    let premulOk = dh.ct === 6;
    for (let i = 0; i < half.length && premulOk; i += 4) {
      const a = half[i + 3];
      if (dh.rgba[i + 3] !== a) premulOk = false;
      for (let k = 0; k < 3 && premulOk; k++) {
        const want = a === 0 ? 0 : Math.min(255, Math.round((Math.round((half[i + k] * a) / 255) * 255) / a));
        if (dh.rgba[i + k] !== want) premulOk = false;
      }
    }
    ok(premulOk, "半透明的图：乘过透明度的像素还原回去，透明度原样，存成 RGBA");
    ok(encodeRaw(layoutOf(opaque, "rgba", false), 37, 23, { order: "rgba" }).equals(encodeRaw(layoutOf(opaque, "argb", false), 37, 23, { order: "argb" })),
      "排布不同、像素相同：编出来一个字节都不差");
    ok([encodeRaw(bgra, 36, 23, {}), encodeRaw(bgra, 0, 23, {}), encodeRaw(bgra, 37, 23, { order: "bgrx" }),
      encodeRaw(Buffer.alloc(8), 10000, Math.ceil(MAX_PIXELS / 10000) + 1, {})].every((x) => x === null),
    "尺寸对不上、排布认不出、超过像素上限：一律 null（调用方退回老路）");

    // 假 electron：createFromBuffer(png).toBitmap() 按 BGRA、乘过透明度吐——跟 macOS 上一样，htmlshot 得自己认出来
    const counts = { toPNG: 0, toBitmap: 0 };
    let lastPx = null;
    const shotImg = (rgba, w, h, dip = 1) => ({
      getSize: () => ({ width: Math.round(w / dip), height: Math.round(h / dip) }),
      toBitmap: () => { counts.toBitmap++; lastPx = layoutOf(rgba, "bgra", true); return lastPx; },
      toPNG: () => { counts.toPNG++; return Buffer.from("old-png"); },
    });
    const FAKE = { nativeImage: { createFromBuffer: (png) => ({ toBitmap: () => layoutOf(decodePng(png).rgba, "bgra", true) }) } };
    let ePath = "";
    try { ePath = require.resolve("electron"); } catch {}
    const eWas = ePath ? require.cache[ePath] : undefined;
    if (ePath) require.cache[ePath] = /** @type {any} */ ({ id: ePath, filename: ePath, loaded: true, exports: FAKE });
    const H = require(mod("htmlshot"));
    const I = H._internals;
    const ctl = () => ({ dead: null, check() { if (this.dead) throw this.dead; } });
    const st = () => I.state().stats;
    const reset = () => { counts.toPNG = 0; counts.toBitmap = 0; };
    try {
      I.setEncoder({ relayout: true, idleMs: 60000 });
      const img = grad(64, 40, (x, y) => (y < 20 ? 255 : 90));
      reset();
      const s0 = st();
      const png = await I.pngOf(shotImg(img, 64, 40), 5000, ctl());
      const dd = decodePng(png);
      const exact = (() => {
        for (let i = 0; i < img.length; i += 4) {
          const a = img[i + 3];
          for (let k = 0; k < 3; k++) {
            const want = Math.min(255, Math.round((Math.round((img[i + k] * a) / 255) * 255) / a));
            if (dd.rgba[i + k] !== want || dd.rgba[i + 3] !== a) return false;
          }
        }
        return true;
      })();
      ok(counts.toPNG === 0 && counts.toBitmap === 1 && st().pngOff === s0.pngOff + 1 && exact,
        "新路子：界面线程上只拷一次像素（toBitmap），toPNG 一次不调，编码在线程里，解回来就是那张图", { counts, layout: I.encodeState().layout });
      ok(lastPx && lastPx.buffer.byteLength === 0, "像素是转交给编码线程的，不是复制（界面线程上那份当场变空）", lastPx && lastPx.buffer.byteLength);
      ok(JSON.stringify(I.encodeState().layout) === JSON.stringify({ order: "bgra", premul: true }), "排布是拿一张 2×1 的已知颜色图问出来的：BGRA、乘过透明度", I.encodeState().layout);

      reset();
      const dip = decodePng(await I.pngOf(shotImg(grad(74, 46), 74, 46, 2), 5000, ctl()));
      reset();
      const big = shotImg(grad(8, 8), 8, 8);
      big.getSize = () => ({ width: 10000, height: Math.ceil(MAX_PIXELS / 10000) + 1 });
      const bigOut = await I.pngOf(big, 5000, ctl());
      ok(dip.w === 74 && dip.h === 46 && dip.rgba.equals(grad(74, 46)), "2 倍屏时尺寸按点给（37×23）也认得出真实像素 74×46", [dip.w, dip.h]);
      ok(String(bigOut) === "old-png" && counts.toBitmap === 0 && counts.toPNG === 1, "超过像素上限的图：先看尺寸就退回老路，不白拷几百 MB", counts);

      reset();
      const s1 = st();
      I.setEncoder({ native: true });
      const old = await I.pngOf(shotImg(img, 64, 40), 5000, ctl());
      ok(String(old) === "old-png" && counts.toPNG === 1 && counts.toBitmap === 0 && st().pngSync === s1.pngSync + 1,
        "★反向对照★ 老路子（OWB_MAIN_PIXELS=native）：toPNG 在界面线程上调一次", { counts, sync: st().pngSync - s1.pngSync });

      reset();
      I.setEncoder({ file: path.join(HOME, "no-such-worker.js"), relayout: true });
      const s2 = st();
      const miss = await I.pngOf(shotImg(img, 64, 40), 5000, ctl());
      ok(String(miss) === "old-png" && st().pngSync === s2.pngSync + 1 && !I.encodeState().worker, "编码线程起不来：退回 toPNG，图照样出", { counts });

      const hang = path.join(HOME, "hang-worker.js");
      fs.writeFileSync(hang, "require('worker_threads').parentPort.on('message', () => {});\n");
      I.setEncoder({ file: hang });
      reset();
      const s3 = st();
      const slow = await I.pngOf(shotImg(img, 64, 40), 150, ctl());
      ok(String(slow) === "old-png" && st().timeouts === s3.timeouts + 1 && !I.encodeState().worker && I.encodeState().pending === 0,
        "线程不回话：到点收掉线程、退回 toPNG，不会因为换了编法反倒截不出图", { counts, st: I.encodeState() });
      const dead = ctl();
      dead.dead = Object.assign(new Error("叫停"), { stopped: true });
      reset();
      I.setEncoder({ file: mod("thumb-worker") });
      const threw = await I.pngOf(shotImg(img, 64, 40), 5000, dead).then(() => null, (e) => e);
      ok(threw === dead.dead && counts.toPNG === 0, "这一单已经被叫停：不再退回老路编一遍", { threw: threw && threw.message, counts });

      I.setEncoder({ idleMs: 40 });
      await I.pngOf(shotImg(img, 64, 40), 5000, ctl());
      const armed = I.encodeState();
      await new Promise((r) => setTimeout(r, 120));
      ok(armed.worker && armed.idleArmed && !I.encodeState().worker, "编完空闲一阵线程自己收掉", { armed, now: I.encodeState() });
    } finally {
      I.dropEncoder();
      if (ePath) { if (eWas) require.cache[ePath] = eWas; else delete require.cache[ePath]; }
    }
  }

  console.log("\n【7】Windows：三件活交给隐藏网页窗口（假窗口里用 vm 跑真的页面代码，哪个系统都跑）");
  {
    const vm = require("vm");
    const BR = require(mod("browser-render"));
    const until = async (fn, ms = 3000) => {
      const t0 = Date.now();
      while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 5)); }
      return true;
    };
    // 文件名 → 这张图（转正以后）的宽高。不在表里的当坏图，nope.jpg 当读不到
    const SIZES = { "bands.png": [900, 300], "photo.jpg": [2400, 1800], "tall.jpg": [600, 1800], "small.png": [200, 100], "anim.gif": [500, 500], "图 #1 a%b.png": [640, 480] };
    const seen = { firstOpts: [], crops: [] };
    // 页面那边用到的几样：fetch / createImageBitmap / OffscreenCanvas / FileReader。都是假的，但入参口径照真的
    const pageGlobals = () => ({
      setTimeout,
      fetch: async (url) => {
        const name = decodeURIComponent(String(url).split("/").pop());
        if (name === "nope.jpg") throw new TypeError("Failed to fetch");
        return { blob: async () => ({ name }) };
      },
      createImageBitmap: async (src, ...rest) => {
        if (src && src.name !== undefined) {
          seen.firstOpts.push(rest[0]);
          const s = SIZES[src.name];
          if (!s) throw Object.assign(new Error("The source image could not be decoded."), { name: "InvalidStateError" });
          return { width: s[0], height: s[1], close() {} };
        }
        const [sx, sy, sw, sh, o] = rest;
        seen.crops.push([sx, sy, sw, sh, o.resizeWidth, o.resizeHeight]);
        return { width: o.resizeWidth, height: o.resizeHeight, close() {} };
      },
      OffscreenCanvas: class {
        constructor(w, h) { this.w = w; this.h = h; }
        getContext() { return { drawImage() {} }; }
        async convertToBlob(o) { return { text: `${o.type} ${this.w}x${this.h}` + (o.quality ? ` q${o.quality}` : "") }; }
      },
      FileReader: class {
        readAsDataURL(b) { this.result = "data:x;base64," + Buffer.from(b.text).toString("base64"); setTimeout(() => this.onload(), 0); }
      },
    });
    /** 假 electron：只有 BrowserWindow。hold = 页面活先压着、手动放；hang = 永远不回话 */
    const mkElectron = ({ hold = false, hang = false } = {}) => {
      const st = { wins: [], opts: [], shows: 0, destroyed: 0, held: [], jsRuns: 0 };
      class BrowserWindow {
        constructor(o) {
          st.opts.push(o); st.wins.push(this);
          this.dead = false;
          const ee = new EventEmitter();
          this.webContents = {
            on: (...a) => ee.on(...a),
            stopPainting() {},
            executeJavaScript: (code) => {
              st.jsRuns++;
              if (hang) return new Promise(() => {});
              const go = () => vm.runInNewContext(code, pageGlobals());
              if (!hold) return Promise.resolve(go());
              return new Promise((res) => st.held.push(() => res(go())));
            },
          };
        }
        async loadFile() {}
        isDestroyed() { return this.dead; }
        destroy() { if (!this.dead) { this.dead = true; st.destroyed++; } }
        show() { st.shows++; }
        showInactive() { st.shows++; }
        focus() { st.shows++; }
      }
      return { st, electron: { BrowserWindow } };
    };
    const W = (n) => path.join(HOME, "win", n); // 不用真有这些文件：读文件那一步是假的
    const dims = (v) => { const m = /(\d+)x(\d+)/.exec(String(v)); return m ? `${m[1]}x${m[2]}` : null; };

    // 主线程这边的 nativeImage（老路子）：每调一次记一笔
    const made = [];
    const img = (w, h) => ({
      isEmpty: () => !(w > 0 && h > 0),
      getSize: () => ({ width: w, height: h }),
      crop: (r) => img(r.width, r.height),
      resize: (o) => img(o.width || Math.round((w * o.height) / h), o.height || Math.round((h * o.width) / w)),
      toPNG: () => Buffer.from(`png ${w}x${h}`),
      toJPEG: (q) => Buffer.from(`jpg ${w}x${h} q${q}`),
    });
    const MAIN_E = { nativeImage: { createFromPath: (p) => {
      made.push(path.basename(p));
      const s = SIZES[path.basename(p)];
      return s ? img(s[0], s[1]) : img(0, 0);
    } } };
    let ePath = "";
    try { ePath = require.resolve("electron"); } catch {}
    const eWas = ePath ? require.cache[ePath] : undefined;
    if (ePath) require.cache[ePath] = /** @type {any} */ ({ id: ePath, filename: ePath, loaded: true, exports: MAIN_E });
    const logs = [];
    try {
      const run = async (pixels) => {
        const shell = createShellBridge({ electron: MAIN_E, pixels });
        const call = (op, args) => new Promise((res) => shell.handle({ t: "call", id: 1, op, args }, res));
        made.length = 0;
        const out = {
          pet: await call("image.petPhoto", { abs: W("bands.png") }),
          gif: await call("image.petPhoto", { abs: W("anim.gif") }),
          vis: await call("image.shrinkForVision", { abs: W("photo.jpg"), maxEdge: 1568, quality: 82 }),
          thumb: await call("image.thumb", { abs: W("photo.jpg"), w: 320 }),
          tall: await call("image.thumb", { abs: W("tall.jpg"), w: 320 }),
          small: await call("image.thumb", { abs: W("small.png"), w: 320 }),
        };
        out.made = made.slice();
        return out;
      };
      const E1 = mkElectron();
      const P1 = BR.createRenderPixels({ electron: E1.electron, log: (s) => logs.push(s) });
      const now = await run(P1);
      const old = await run(null);
      const allOk = ["pet", "gif", "vis", "thumb", "tall", "small"].every((k) => now[k].ok);
      ok(allOk && now.made.length === 0, "Windows 那条路：六件活主线程上一次 nativeImage 都没调", { made: now.made, logs });
      ok(old.made.length === 6, "★反向对照★ 不给 pixels（老路子）：每件都在界面线程上 nativeImage 一次", old.made);
      ok(dims(now.pet.value.png) === "320x320" && now.pet.value.note === old.pet.value.note && /900×300/.test(now.pet.value.note),
        "宠物头像 320×320，说明文字跟老路子一字不差", { now: now.pet.value.note, old: old.pet.value.note });
      ok(now.gif.value.note === old.gif.value.note && /GIF/.test(now.gif.value.note), "GIF 那句也一样", now.gif.value.note);
      ok(JSON.stringify(seen.crops[0]) === JSON.stringify([300, 0, 300, 300, 320, 320]), "900×300 取中间那块 300×300 再缩到 320（中心裁方）", seen.crops[0]);
      ok(String(now.pet.value.png).startsWith("image/png") && String(now.thumb.value).startsWith("image/png") && /^image\/jpeg .* q0\.82$/.test(String(now.vis.value.jpg)),
        "格式跟老路子一样：头像、缩略图 PNG，压图 JPEG、质量 82", [String(now.pet.value.png), String(now.thumb.value), String(now.vis.value.jpg)]);
      ok(dims(now.thumb.value) === dims(old.thumb.value) && dims(now.thumb.value) === "320x240" && dims(now.tall.value) === dims(old.tall.value),
        "缩略图尺寸跟老路子一样（横图 320×240，竖图按高缩）", { now: [dims(now.thumb.value), dims(now.tall.value)], old: [dims(old.thumb.value), dims(old.tall.value)] });
      ok(now.small.value === null && old.small.value === null, "本来就比 320 小的图：两条路都回 null（发原图）", [now.small.value, old.small.value]);
      ok(dims(now.vis.value.jpg) === dims(old.vis.value.jpg) && now.vis.value.width === 2400 && now.vis.value.height === 1800 && old.vis.value.width === 2400,
        "压图长边 1568、带回原图 2400×1800（跟老路子口径一样）", { now: [dims(now.vis.value.jpg), now.vis.value.width, now.vis.value.height], old: dims(old.vis.value.jpg) });
      ok(seen.firstOpts.length > 0 && seen.firstOpts.every((o) => o && o.imageOrientation === "from-image"), "解图时按 EXIF 转正（手机竖拍的不会躺着）", seen.firstOpts);
      const o1 = E1.st.opts[0] || {};
      const wp = o1.webPreferences || {};
      ok(E1.st.wins.length === 1 && o1.show === false && wp.offscreen === true && wp.sandbox === true && wp.nodeIntegration === false && wp.contextIsolation === true,
        "只建了一个窗口、常驻复用；show:false + 离屏、沙箱、不给 node", { n: E1.st.wins.length, o1 });
      ok(E1.st.shows === 0, "窗口一次都没亮出来", E1.st.shows);
      const cjk = await P1.petPhoto(W("图 #1 a%b.png"));
      ok(cjk && /640×480/.test(cjk.value.note), "文件名带中文、空格、#、% 也读得到（地址按 file:// 规矩转义）", cjk && cjk.value.note);

      // 坏图 / 读不到：退回老路子，而且留痕
      const shell = createShellBridge({ electron: MAIN_E, pixels: P1 });
      const call = (op, args) => new Promise((res) => shell.handle({ t: "call", id: 1, op, args }, res));
      made.length = 0; logs.length = 0;
      const bad = await call("image.petPhoto", { abs: W("broken.png") });
      ok(bad.ok && bad.value && bad.value.empty === true && made.length === 1, "解不出的图：退回老路子，照旧回 {empty:true}", { bad, made });
      ok(logs.some((l) => /缩图窗口没做成（宠物头像）/.test(l) && /解不出这张图/.test(l)), "  └ 日志里留了一句：哪件活、为什么退回", logs);
      made.length = 0; logs.length = 0;
      const miss = await call("image.thumb", { abs: W("nope.jpg"), w: 320 });
      ok(miss.ok && made.length === 1 && logs.some((l) => /缩略图/.test(l) && /读不到这个文件/.test(l)), "读不到的文件：退回老路子，日志里写明读不到", { made, logs });
      ok(P1.counts.fallbacks === 2 && P1.counts.fails === 2, "退回几次就记几次", P1.counts);
      P1.close();
      await new Promise((r) => setTimeout(r, 0)); // 窗口是建好那一刻（Promise）之后收的
      ok(E1.st.destroyed === 1, "close() 把窗口收掉", E1.st.destroyed);
      made.length = 0;
      const after = await P1.thumb(W("photo.jpg"), 320);
      ok(after === null && E1.st.wins.length === 1, "收掉以后不再建窗口，回 null 让调用方走老路子", { after, wins: E1.st.wins.length });

      // 同时最多两个
      const E2 = mkElectron({ hold: true });
      const P2 = BR.createRenderPixels({ electron: E2.electron });
      const six = Array.from({ length: 6 }, () => P2.thumb(W("photo.jpg"), 320));
      await until(() => E2.st.held.length >= 2);
      await new Promise((r) => setTimeout(r, 20));
      ok(E2.st.held.length === 2 && P2.active === 2 && P2.queued === 4, "六张一起来：同时只做两张，其余排队", { held: E2.st.held.length, active: P2.active, queued: P2.queued });
      while ((await Promise.race([Promise.all(six).then(() => true), new Promise((r) => setTimeout(() => r(false), 10))])) === false) {
        const f = E2.st.held.shift();
        if (f) f();
      }
      const sixR = await Promise.all(six);
      ok(sixR.every((r) => r && dims(r.value) === "320x240") && P2.counts.peak === 2, "六张都做完，最多同时两张", P2.counts);
      P2.close();
      const E3 = mkElectron({ hold: true });
      const P3 = BR.createRenderPixels({ electron: E3.electron, max: 99 });
      const six3 = Array.from({ length: 6 }, () => P3.thumb(W("photo.jpg"), 320));
      await until(() => E3.st.held.length >= 6, 500);
      ok(E3.st.held.length === 6, "★反向对照★ 不设上限：六张一起压上去", E3.st.held.length);
      for (const f of E3.st.held.splice(0)) f();
      await Promise.all(six3);
      P3.close();

      // 排太久的缩略图不做了（服务进程那头 10 秒就不等了）
      let T = 0;
      const E4 = mkElectron({ hold: true });
      const P4 = BR.createRenderPixels({ electron: E4.electron, now: () => T });
      const q = [P4.thumb(W("photo.jpg"), 320), P4.thumb(W("photo.jpg"), 320), P4.thumb(W("photo.jpg"), 320)];
      await until(() => E4.st.held.length >= 2);
      T += 9500;
      for (const f of E4.st.held.splice(0)) f();
      const qr = await Promise.all(q);
      ok(E4.st.jsRuns === 2 && P4.counts.stale === 1 && qr[2] && qr[2].value === null, "第 3 张排了 9.5 秒才轮到：不做了，回「发原图」", { runs: E4.st.jsRuns, ...P4.counts });
      P4.close();

      // 窗口不回话：到点放弃、关掉这个窗口，下一张重建
      const E5 = mkElectron({ hang: true });
      const logs5 = [];
      const P5 = BR.createRenderPixels({ electron: E5.electron, timeoutMs: 60, log: (s) => logs5.push(s) });
      const hung = await P5.shrinkForVision(W("photo.jpg"), 1568, 82);
      await new Promise((r) => setTimeout(r, 10));
      ok(hung === null && E5.st.destroyed === 1 && logs5.some((l) => /压图/.test(l) && /没做完/.test(l)), "窗口不回话：到点回 null、关掉窗口、日志写明", { hung, destroyed: E5.st.destroyed, logs5 });
      await P5.thumb(W("photo.jpg"), 320);
      ok(E5.st.wins.length === 2, "  └ 下一张换一个新窗口，不在卡住的那个上接着等", E5.st.wins.length);
      P5.close();

      // 闲下来自己收窗口
      const E6 = mkElectron();
      const P6 = BR.createRenderPixels({ electron: E6.electron, idleMs: 40 });
      await P6.thumb(W("photo.jpg"), 320);
      ok(E6.st.destroyed === 0, "刚做完：窗口还在（一批图接着来不用重建）", E6.st.destroyed);
      await until(() => E6.st.destroyed === 1, 500);
      ok(E6.st.destroyed === 1, "闲了一阵：窗口自己收掉，不常驻占内存", E6.st.destroyed);
      P6.close();
    } finally {
      if (ePath) { if (eWas) require.cache[ePath] = eWas; else delete require.cache[ePath]; }
    }

    // electron-main.js 按平台选谁来做
    const mainSrc = fs.readFileSync(entry("electron-main"), "utf8");
    const at = mainSrc.indexOf("function pixelsKind(");
    const pixelsKind = new Function(mainSrc.slice(at, mainSrc.indexOf("\n}\n", at) + 2) + "\nreturn pixelsKind;")();
    ok(pixelsKind("win32", {}) === "render" && pixelsKind("darwin", {}) === "sips", "Windows 交给隐藏窗口，mac 照旧交给 sips");
    ok(pixelsKind("linux", {}) === null && pixelsKind("win32", { OWB_MAIN_PIXELS: "native" }) === null && pixelsKind("darwin", { OWB_MAIN_PIXELS: "native" }) === null,
      "★反向对照★ Linux、OWB_MAIN_PIXELS=native：走回主线程 nativeImage");
    const brSpec = JSON.stringify(mod.spec("electron-main", "browser-render")).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    ok(new RegExp(`pk === "render"\\) return require\\(${brSpec}\\)\\.createRenderPixels\\(`).test(mainSrc) && /pixelsKind\(process\.platform, process\.env\)/.test(mainSrc),
      "主进程真按 pixelsKind 注入了隐藏窗口那一份");
  }

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
