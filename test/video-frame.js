// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 视频封面（video-frame.js）：ffmpeg 取第 1 秒一帧，不到 1 秒的短片退回第 0 帧；没 ffmpeg、解不开、
 * 超时一律 null，临时目录不留，挂住的进程到点杀掉。
 *
 * 跑法：node test/video-frame.js
 *
 * 前几段用假 ffmpeg（一段 node 脚本，按文件名决定表现），哪都能跑。最后一段用本机真 ffmpeg 现生成
 * 一段 2 秒、一段 0.5 秒的测试片来取；没有 ffmpeg 就明说跳过（OWB_REQUIRE_FFMPEG=1 时没有算红）。
 */
const { mod } = require("./lib/mod");
const HOME = require("./lib/own-home")("video-frame");

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const VF = require(mod("video-frame"));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail))); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const names = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
const pngSize = (b) => (b && b.length > 24 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null);

const FIX = path.join(HOME, "fix");
const TMP = path.join(HOME, "tmp");
const SIDE = path.join(HOME, "side");
for (const d of [FIX, TMP, SIDE]) fs.mkdirSync(d, { recursive: true });
// 够 isPng 认的最小 PNG：签名 + 一段填充（假 ffmpeg 只负责把它原样写到输出位置）
const FAKE_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const FIXTURE_PNG = path.join(FIX, "fixture.png");
fs.writeFileSync(FIXTURE_PNG, FAKE_PNG);

// 假 ffmpeg：收到的参数就是真 ffmpeg 的那一串，最后一个是输出文件
const FAKE = path.join(FIX, "fake-ffmpeg.js");
fs.writeFileSync(FAKE, `
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
const out = a[a.length - 1], input = a[a.indexOf("-i") + 1], ss = a[a.indexOf("-ss") + 1], base = path.basename(input);
fs.appendFileSync(path.join(${JSON.stringify(SIDE)}, base + ".log"), JSON.stringify({ ss, out, args: a, pid: process.pid }) + "\\n");
const png = () => fs.copyFileSync(${JSON.stringify(FIXTURE_PNG)}, out);
if (/^ok/.test(base)) { png(); process.exit(0); }
if (/^short/.test(base)) { if (ss === "0") png(); process.exit(0); }  // 不到 1 秒：-ss 1 退 0 但不出文件（本机真 ffmpeg 就是这样）
if (/^never/.test(base)) process.exit(0);
if (/^bad/.test(base)) process.exit(1);
if (/^hang/.test(base)) setInterval(() => {}, 1000);
else process.exit(9);
`);
const calls = [];
const fakeSpawn = (cmd, args, o) => {
  calls.push({ cmd, args: [...args] });
  return cp.spawn(process.execPath, [FAKE, ...args.slice(3)], o); // 顶替 nice -n 10 <ffmpeg> 里的 ffmpeg
};
const fx = (name) => { const f = path.join(FIX, name); fs.writeFileSync(f, "v"); return f; };
const log = (name) => { try { return fs.readFileSync(path.join(SIDE, name + ".log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } };
const base = { spawn: fakeSpawn, ffmpeg: "/fake/ffmpeg", tmpRoot: TMP, platform: "linux" };

(async () => {
  console.log("【1】取第 1 秒那一帧，按宽度缩，低优先级跑");
  {
    calls.length = 0;
    const buf = await VF.videoFrame(fx("ok-a.mp4"), { ...base, width: 320 });
    const a = (calls[0] || { args: [] }).args;
    ok(buf && buf.equals(FAKE_PNG), "回来的就是 ffmpeg 写出的那张 PNG", buf && buf.length);
    ok(calls.length === 1 && calls[0].cmd === "nice" && a.slice(0, 3).join(" ") === "-n 10 /fake/ffmpeg", "nice -n 10 起给定的 ffmpeg", calls);
    ok(a[a.indexOf("-ss") + 1] === "1" && a.indexOf("-ss") < a.indexOf("-i") && a[a.indexOf("-frames:v") + 1] === "1", "-ss 1 放在 -i 前面（快速定位），只要 1 帧", a);
    ok(a[a.indexOf("-vf") + 1] === "scale=320:-2" && a.includes("-nostdin"), "按宽 320 缩、高度自适应取偶数；-nostdin 不抢终端", a);
    ok(names(TMP).length === 0, "临时目录删了", names(TMP));
  }

  console.log("\n【2】不到 1 秒的短片：第 1 秒没画面就退回第 0 帧");
  {
    calls.length = 0;
    const buf = await VF.videoFrame(fx("short-a.mov"), { ...base });
    const l = log("short-a.mov");
    ok(buf && buf.equals(FAKE_PNG) && l.map((x) => x.ss).join(",") === "1,0", "先 -ss 1（没出文件）再 -ss 0（出了）", l.map((x) => x.ss));
    calls.length = 0;
    const r = await VF.videoFrame(fx("never-a.webm"), { ...base });
    ok(r === null && calls.length === 2, "两次都不出文件：null，不再试第三次", calls.length);
    calls.length = 0;
    const r2 = await VF.videoFrame(fx("bad-a.mkv"), { ...base });
    ok(r2 === null && calls.length === 1, "★反向对照★ ffmpeg 退非 0（解不开）：null，也不退回第 0 帧再白跑一趟", calls.length);
    ok(names(TMP).length === 0, "  └ 临时目录都删了", names(TMP));
  }

  console.log("\n【3】挂住：到点杀掉、回 null；叫停立刻回");
  {
    const t0 = Date.now();
    const p = VF.videoFrame(fx("hang-a.mp4"), { ...base, timeoutMs: 800 });
    let pid = 0;
    for (let i = 0; i < 40 && !pid; i++) { await sleep(20); pid = (log("hang-a.mp4")[0] || {}).pid || 0; }
    ok(pid && alive(pid), "★反向对照★ 到点之前假 ffmpeg 活着（真在挂）", pid);
    const r = await p;
    const ms = Date.now() - t0;
    await sleep(100);
    ok(r === null && ms >= 750 && ms < 2500 && !alive(pid), `timeoutMs=800：${ms}ms 回 null，进程没了`, { ms, alive: alive(pid) });
    ok(log("hang-a.mp4").length === 1, "超时以后不再退回第 0 帧重跑（时间已经用完了）", log("hang-a.mp4").length);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const t1 = Date.now();
    const r2 = await VF.videoFrame(fx("hang-b.mp4"), { ...base, timeoutMs: 20000, signal: ac.signal });
    const pid2 = (log("hang-b.mp4")[0] || {}).pid;
    await sleep(100);
    ok(r2 === null && Date.now() - t1 < 2000 && pid2 && !alive(pid2), `超时给 20 秒、200ms 叫停：${Date.now() - t1}ms 回来，进程没了`, pid2);
    ok(names(TMP).length === 0, "  └ 临时目录删了", names(TMP));
  }

  console.log("\n【4】没有 ffmpeg、文件不在：不起进程");
  {
    calls.length = 0;
    const f = fx("ok-b.mp4");
    const r = await VF.videoFrame(f, { ...base, ffmpeg: "" });
    ok(r === null && calls.length === 0, "ffmpeg 找不到：null，一个进程都没起", calls.length);
    const r2 = await VF.videoFrame(f, { ...base });
    ok(r2 && calls.length === 1, "★反向对照★ 同一个文件给了 ffmpeg：起了一趟、出了图", calls.length);
    calls.length = 0;
    const r3 = await VF.videoFrame(path.join(FIX, "ok-missing.mp4"), { ...base });
    ok(r3 === null && calls.length === 0, "文件不在：null，不起进程", calls.length);
    const r4 = await VF.videoFrame(fx("ok-c.mp4"), { ...base, spawn: (c, a, o) => cp.spawn("/definitely/not/here/nice", a, o) });
    ok(r4 === null && names(TMP).length === 0, "命令起不来（ENOENT）：null，不抛，临时目录删了", names(TMP));
  }

  console.log("\n【5】真 ffmpeg");
  const mb = await require(mod("media-probe")).resolveMediaBins().catch(() => null);
  const ffmpeg = mb && mb.ffmpeg && mb.ffmpeg.bin;
  if (!ffmpeg) {
    if (process.env.OWB_REQUIRE_FFMPEG === "1") ok(false, "OWB_REQUIRE_FFMPEG=1 却找不到 ffmpeg", mb && mb.ffmpeg);
    else console.log("  跳过：本机找不到 ffmpeg（资料库这时给视频出图标卡）");
  } else {
    const mk = (name, sec) => {
      const f = path.join(FIX, name);
      const r = cp.spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10",
        "-t", String(sec), "-pix_fmt", "yuv420p", f], { timeout: 30000 });
      return r.status === 0 ? f : "";
    };
    const long = mk("real-long.mp4", 2), short = mk("real-short.mp4", 0.5);
    ok(long && short, "现生成两段测试片（2 秒、0.5 秒）", { long, short });
    const t0 = Date.now();
    const a = await VF.videoFrame(long, { width: 160, timeoutMs: 8000, tmpRoot: TMP });
    const ms = Date.now() - t0;
    ok(pngSize(a) && pngSize(a).w === 160 && pngSize(a).h === 90, `2 秒的片子：${JSON.stringify(pngSize(a))}，${ms}ms（找 ffmpeg 走设置页那一套）`, pngSize(a));
    const b = await VF.videoFrame(short, { width: 160, timeoutMs: 8000, tmpRoot: TMP });
    ok(pngSize(b) && pngSize(b).w === 160, "0.5 秒的片子：第 1 秒没画面，退回第 0 帧出了图", pngSize(b));
    const bad = path.join(FIX, "real-bad.mp4");
    fs.writeFileSync(bad, "not a video at all");
    ok((await VF.videoFrame(bad, { width: 160, timeoutMs: 8000, tmpRoot: TMP })) === null, "★反向对照★ 不是视频的 .mp4：null");
    ok(names(TMP).length === 0, "  └ 临时目录都删了", names(TMP));
  }

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
