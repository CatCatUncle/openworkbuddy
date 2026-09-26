"use strict";
/**
 * HTML 动画出片（桌面版那条路）：离屏窗口 + 虚拟时钟，逐帧截图喂 ffmpeg。
 *
 * 跑法：npx electron test/motion-render.js
 *
 * 纯逻辑和无头 Chrome 那条路在 test/motion.js；这里只验离屏窗口特有的几件事：
 *   - 同一页渲两次，36 帧的指纹逐帧一样（时间、随机数、字体都被钉住了，不是碰巧）；
 *   - 截回来的每帧恰好 W×H×4 字节：Retina 上不是 2 倍图；
 *   - 离屏截图是 BGRA，按错通道喂 ffmpeg 的话红变蓝 —— 截图里、成片里各量一次；
 *   - 定时器、CSS 动画、rAF、片段显隐、100vw 都对得上虚拟时间轴；
 *   - 点停止：不留半截文件，离屏窗口一个不剩；两条同时来：一次只开一个窗口。
 * 本机没有 ffmpeg 时，帧这一层照样验（拿一个把字节原样存下来的假 ffmpeg 顶上），成片那几条跳过。
 */

// 离屏窗口只有 Electron 里才有：被 node 直接拉起来时（npm test 就是这么拉的）自己换一身皮再跑一遍；
// 没装 electron 就跳过不算失败——纯服务端部署走的是无头 Chrome，那条路在 test/motion.js
if (!process.versions.electron) {
  const fs0 = require("fs");
  let bin = null;
  try { bin = require("electron"); } catch {}
  if (typeof bin !== "string" || !fs0.existsSync(bin)) {
    console.log("跳过：没装 electron，离屏窗口这条路验不了（纯服务端部署走无头 Chrome）");
    process.exit(0);
  }
  const r = require("child_process").spawnSync(bin, [__filename], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
    timeout: 300000, killSignal: "SIGKILL",
  });
  process.exit(r.status == null ? 1 : r.status);
}

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { app, BrowserWindow } = require("electron");

// 离屏窗口人眼看不见，但 macOS 照样往程序坞塞一个跳动的图标，跑一次测试抢一次注意力
if (process.platform === "darwin" && app.dock && app.dock.hide) app.dock.hide();
// 渲完一段就销毁窗口：没有这一句的话 Linux / Windows 上「窗口全关了」会把整个测试进程带走
app.on("window-all-closed", () => {});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-motion-render-"));
// 不碰真数据目录
process.env.OPENWORKBUDDY_HOME = TMP;
// 用户机器上要是设了强制走 Chrome，这一套就验不到离屏窗口了
delete process.env.OWB_MOTION_BACKEND;

let pass = 0, fail = 0;
const ok = (v, m, extra) => {
  if (v) { pass++; return; }
  fail++;
  console.log(`  × ${m}${extra !== undefined ? "  " + String(extra).slice(0, 300) : ""}`);
};
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m, `实际: ${JSON.stringify(a)} 期望: ${JSON.stringify(b)}`);
const errOf = (p) => p.then(() => null, (e) => e);

const W = 320, H = 240, FPS = 30;
// 1.2 秒 × 30 帧 = 36 帧。每样东西各验一件事：
// 红块 = CSS 动画按虚拟时间走；绿块 = 600ms 的 setTimeout 恰好在第 19 帧生效；灰条 = rAF 拿到的是虚拟时刻；
// 黄块贴着 100vw 的右边 = 视口真是 320 宽；蓝块 = data-start/data-duration 片段只在自己的窗口里；
// 白块横坐标由 Math.random 决定 = 两次渲出来一样才说明随机数带了种子
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100vw;height:100vh;overflow:hidden;background:#000}
#box{position:absolute;left:0;top:0;width:40px;height:40px;background:#f00;animation:mv 1.2s linear forwards}
@keyframes mv{from{transform:translateX(0)}to{transform:translateX(280px)}}
#late{position:absolute;left:0;top:100px;width:20px;height:20px;background:#0f0;opacity:0}
#edge{position:absolute;left:calc(100vw - 10px);top:60px;width:10px;height:10px;background:#ff0}
#clip{position:absolute;left:60px;top:130px;width:30px;height:30px;background:#00f}
#rnd{position:absolute;left:0;top:60px;width:12px;height:12px;background:#fff}
</style></head><body data-duration="1.2">
<div id="box"></div><div id="late"></div><div id="edge"></div><div id="rnd"></div>
<div id="clip" data-start="0.8" data-duration="0.4"></div>
<canvas id="c" width="320" height="60" style="position:absolute;left:0;top:180px"></canvas>
<script>
setTimeout(function () { document.getElementById("late").style.opacity = "1"; }, 600);
var c = document.getElementById("c").getContext("2d");
function f(t) { var g = Math.min(255, Math.round(t / 1200 * 255)); c.fillStyle = "rgb(" + g + "," + g + "," + g + ")"; c.fillRect(0, 0, 320, 60); requestAnimationFrame(f); }
requestAnimationFrame(f);
document.getElementById("rnd").style.left = Math.floor(100 + Math.random() * 150) + "px";
</script></body></html>`;

const is = {
  red: ([r, g, b]) => r > 180 && g < 80 && b < 80,
  green: ([r, g, b]) => g > 180 && r < 80 && b < 80,
  blue: ([r, g, b]) => b > 180 && r < 80 && g < 80,
  yellow: ([r, g, b]) => r > 180 && g > 180 && b < 80,
  black: ([r, g, b]) => r < 40 && g < 40 && b < 40,
};

// 整套最多 4 分钟：离屏窗口卡死时别让 CI 干等到外层超时
const guard = setTimeout(() => {
  console.error("测试超时：4 分钟还没跑完，离屏窗口可能卡死了");
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  app.exit(1);
}, 240000);

app.whenReady().then(async () => {
  const HV = require("../htmlvideo");
  const M = require("../motion-clock");
  const MP = require("../lib/media-probe");

  console.log("【1】桌面版优先用离屏窗口");
  eq(HV.available(), { ok: true, backend: "electron", why: "" }, "Electron 里 available() 选 electron");

  // 真 ffmpeg 有就用；没有的话帧这一层拿假 ffmpeg 照验（它只把喂进来的字节原样存下），成片那几条跳过
  const bins = await MP.resolveMediaBins();
  const ffReal = bins.ffmpeg && bins.ffmpeg.bin, fp = bins.ffprobe && bins.ffprobe.bin;
  const realOk = !!(ffReal && fp && (await HV.prepareFfmpeg(ffReal)).ok);
  let ffBin = realOk ? ffReal : "";
  if (!realOk) {
    if (process.env.OWB_REQUIRE_FFMPEG === "1") ok(false, "OWB_REQUIRE_FFMPEG=1 却找不到能出 H.264 的 ffmpeg/ffprobe", JSON.stringify(bins));
    if (process.platform !== "win32") {
      ffBin = path.join(TMP, "fake-ffmpeg");
      fs.writeFileSync(ffBin, '#!/bin/sh\nfor a in "$@"; do last="$a"; if [ "$a" = "-encoders" ]; then echo " V....D libx264   假编码器"; exit 0; fi; done\ncat > "$last"\n');
      fs.chmodSync(ffBin, 0o755);
      console.log("    本机没有 ffmpeg：帧这一层拿假 ffmpeg 验，成片那几条跳过");
    }
  }
  if (!ffBin) {
    console.log("跳过：本机没有 ffmpeg");
    fs.rmSync(TMP, { recursive: true, force: true });
    clearTimeout(guard);
    app.exit(process.env.OWB_REQUIRE_FFMPEG === "1" ? 1 : 0);
    return;
  }

  const fx = path.join(TMP, "fx.html");
  fs.writeFileSync(fx, FIXTURE);
  const baseline = BrowserWindow.getAllWindows().length;

  console.log("【2】同一页渲两次：逐帧一致；每帧 W×H×4 字节的 BGRA");
  const once = async (name) => {
    const hashes = [], sizes = [], formats = [];
    /** @type {Map<number, Buffer>} */
    const keep = new Map();
    const out = path.join(TMP, name);
    const r = await HV.renderMotion([{ path: fx }], {
      width: W, height: H, fps: FPS, out, ffmpegBin: ffBin, stills: 1,
      onFrame: (f) => {
        hashes.push(f.hash); sizes.push(f.buf.length); formats.push(f.format);
        if ([0, 17, 18, 22, 27].includes(f.index)) keep.set(f.index, Buffer.from(f.buf));
      },
    });
    return { r, hashes, sizes, formats, keep, out };
  };
  const a = await once("a.mp4").catch((e) => e);
  const b = await once("b.mp4").catch((e) => e);
  ok(!(a instanceof Error) && !(b instanceof Error), "离屏窗口渲两次都成功", (a && a.stack) || (b && b.stack));
  if (!(a instanceof Error) && !(b instanceof Error)) {
    eq([a.r.backend, a.r.frames, a.r.width, a.r.height, a.r.fps], ["electron", 36, W, H, FPS], "走的离屏窗口：36 帧、320x240、30 帧/秒");
    ok(a.hashes.length === 36 && JSON.stringify(a.hashes) === JSON.stringify(b.hashes), "同一页渲两次：36 帧的指纹逐帧一模一样");
    ok(a.r.distinctFrames >= 30, "画面真在动：不同的帧 ≥ 30", a.r.distinctFrames);
    eq(a.r.warnings, [], "没溢出、没报错：没有提醒");
    ok(a.sizes.every((n) => n === W * H * 4), "每帧恰好 320×240×4 字节：Retina 上也不是 2 倍图", JSON.stringify([...new Set(a.sizes)]));
    ok(a.formats.every((f) => f === "bgra"), "离屏截图报的格式是 bgra");
    eq(a.r.stills.map((s) => s.frame), [14], "封面默认取 40% 处（第 15 帧）");
    const png = a.r.stills[0] && a.r.stills[0].png;
    ok(!!png && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "封面是 PNG");
    eq(png ? [png.readUInt32BE(16), png.readUInt32BE(20)] : null, [W, H], "封面 PNG 也是 320x240");

    console.log("【3】截图里的像素对得上时间轴（BGRA 按 B、G、R 读）");
    const px = (n, x, y) => {
      const buf = a.keep.get(n);
      if (!buf) return [-1, -1, -1];
      const o = (y * W + x) * 4;
      return [buf[o + 2], buf[o + 1], buf[o]];
    };
    const probe = (n, x, y, kind, what) => ok(is[kind](px(n, x, y)), what, JSON.stringify(px(n, x, y)));
    probe(0, 20, 20, "red", "第 1 帧：红块在最左边（按 BGRA 读是红，通道没读反）");
    probe(0, 160, 20, "black", "第 1 帧：中间还没有红块");
    probe(18, 160, 20, "red", "第 19 帧（600ms）：红块走到正中（CSS 动画按虚拟时间走）");
    probe(18, 20, 20, "black", "第 19 帧：左边已经空了");
    probe(17, 10, 110, "black", "第 18 帧（567ms）：600ms 的定时器还没到");
    probe(18, 10, 110, "green", "第 19 帧（600ms）：定时器恰好生效");
    const gray = px(18, 100, 210);
    ok(Math.abs(gray[0] - 128) <= 3 && gray[0] === gray[1] && gray[1] === gray[2], "第 19 帧：rAF 拿到的是 600ms，画出 50% 灰", JSON.stringify(gray));
    probe(18, 315, 65, "yellow", "贴着 100vw 右边的黄块在画面最右 10px 里：视口就是 320 宽");
    probe(22, 75, 145, "black", "第 23 帧（733ms）：0.8 秒起的片段还没露面");
    probe(27, 75, 145, "blue", "第 28 帧（900ms）：片段在自己的窗口里");

    if (realOk) {
      console.log("【4】成片：h264 / yuv420p / 320x240 / 36 帧，红还是红");
      const pr = spawnSync(fp, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=codec_name,pix_fmt,width,height,nb_read_frames", "-of", "json", a.out], { encoding: "utf8", timeout: 30000 });
      let st = {};
      try { st = JSON.parse(pr.stdout).streams[0]; } catch { st = { err: pr.stderr }; }
      eq([st.codec_name, st.pix_fmt, st.width, st.height, st.nb_read_frames], ["h264", "yuv420p", W, H, "36"], "成片参数");
      const raw = spawnSync(ffReal, ["-v", "error", "-i", a.out, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { timeout: 60000, maxBuffer: 64 << 20 }).stdout || Buffer.alloc(0);
      eq(raw.length, 36 * W * H * 3, "解码出 36 帧完整画面");
      const vpx = (n, x, y) => { const o = (n * W * H + y * W + x) * 3; return [raw[o], raw[o + 1], raw[o + 2]]; };
      ok(is.red(vpx(0, 20, 20)), "成片第 1 帧左上是红的：BGRA 喂给 ffmpeg 没按 RGBA 读（按错了红会变蓝）", JSON.stringify(vpx(0, 20, 20)));
      ok(is.green(vpx(18, 10, 110)) && is.black(vpx(17, 10, 110)), "成片里绿块也是第 19 帧才出现：编码没丢帧、没错位", JSON.stringify([vpx(17, 10, 110), vpx(18, 10, 110)]));
    } else {
      console.log("【4】跳过：本机没有 ffmpeg，成片验不了");
    }
  }
  for (const n of ["a.mp4", "b.mp4"]) fs.rmSync(path.join(TMP, n), { force: true });
  eq(BrowserWindow.getAllWindows().length, baseline, "渲完离屏窗口都收走了");

  console.log("【5】点停止：不留半截文件，窗口收走；两条同时来：一次只开一个窗口");
  const ctl = new AbortController();
  const outS = path.join(TMP, "stop.mp4");
  let framesSeen = 0;
  const errS = await errOf(HV.renderMotion([{ path: fx }], {
    width: W, height: H, fps: FPS, out: outS, ffmpegBin: ffBin, signal: ctl.signal,
    onFrame: (f) => { framesSeen = f.index + 1; if (f.index === 3) ctl.abort(); },
  }));
  ok(!!errS && errS.stopped === true, "停止：抛带 stopped 的错", errS && errS.message);
  eq(framesSeen, 4, "点了停止，下一帧就不截了");
  ok(!fs.existsSync(outS) && !fs.existsSync(M.partPath(outS)), "停止后成片和 .part 都没有");
  eq(BrowserWindow.getAllWindows().length, baseline, "停止后离屏窗口收走了");

  let maxWin = 0;
  const watchWin = () => { maxWin = Math.max(maxWin, BrowserWindow.getAllWindows().length - baseline); };
  const q = await Promise.allSettled(["q1.mp4", "q2.mp4"].map((n) => HV.renderMotion([{ path: fx, duration: 0.5 }], {
    width: W, height: H, fps: FPS, out: path.join(TMP, n), ffmpegBin: ffBin, onFrame: watchWin,
  })));
  ok(q.every((x) => x.status === "fulfilled"), "两条同时来都渲完了", q.map((x) => x.status === "rejected" ? String(x.reason && x.reason.message) : "ok").join(" | "));
  eq(maxWin, 1, "排队渲：任何时刻只开着一个离屏窗口");
  eq(BrowserWindow.getAllWindows().length, baseline, "都渲完窗口一个不剩");

  clearTimeout(guard);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `\n× motion-render：${pass} 条通过，${fail} 条失败` : `\n√ motion-render：${pass} 条通过，0 条失败`);
  app.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error("测试自己崩了：", (e && e.stack) || e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  app.exit(1);
});
