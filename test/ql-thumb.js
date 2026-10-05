// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 文档封面（ql-thumb.js）：qlmanage 出缩略图，出不来一律 null，临时目录一个不留，挂住的进程连根杀。
 *
 * 跑法：node test/ql-thumb.js
 *
 * 前几段用一个假 qlmanage（一段 node 脚本，按文件名决定这一趟怎么表现：出图 / 退非 0 / 退 0 不出图 /
 * 出一个不是 PNG 的文件 / 挂住不走还带一个孙进程），任何系统上都能跑，CI 的 Linux 那条腿也跑。
 * 最后一段只在 macOS 上用真 qlmanage：一个现写的小 RTF 要出得来图；一个认不出类型的 1 字节文件
 * （2026-09-29 本机实测真 qlmanage 碰上它挂两分钟不走）到点要回 null，而且不留下 qlmanage 进程。
 */
const { mod } = require("./lib/mod");
const HOME = require("./lib/own-home")("ql-thumb");

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const QL = require(mod("ql-thumb"));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail))); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const names = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };

/** 一张真能解的 PNG（w×h 纯色），自己拼：不靠任何图像库 */
function makePng(w, h, rgb = [200, 40, 40]) {
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const pngSize = (b) => (b && b.length > 24 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null);

const FIX = path.join(HOME, "fix");
const TMP = path.join(HOME, "tmp");     // 交给 qlThumb 的临时根：跑完必须是空的
const SIDE = path.join(HOME, "side");   // 假 qlmanage 往这儿报它看到了什么
for (const d of [FIX, TMP, SIDE]) fs.mkdirSync(d, { recursive: true });
const FIXTURE_PNG = path.join(FIX, "fixture.png");
fs.writeFileSync(FIXTURE_PNG, makePng(64, 48));

// 假 qlmanage：参数跟真的一样（nice -n 10 /usr/bin/qlmanage -t -s N -o 目录 文件），按文件名决定表现
const FAKE = path.join(FIX, "fake-qlmanage.js");
fs.writeFileSync(FAKE, `
const fs = require("fs"), path = require("path"), cp = require("child_process");
const a = process.argv.slice(2);
const out = a[a.indexOf("-o") + 1], file = a[a.length - 1], base = path.basename(file);
const side = ${JSON.stringify(SIDE)};
fs.writeFileSync(path.join(side, base + ".seen"), JSON.stringify({ out, outExisted: fs.existsSync(out), args: a, pid: process.pid }));
const png = () => fs.copyFileSync(${JSON.stringify(FIXTURE_PNG)}, path.join(out, base + ".png"));
if (/^ok/.test(base)) { png(); process.exit(0); }
if (/^fail/.test(base)) { png(); process.exit(3); }          // 退非 0：哪怕目录里有图也不认
if (/^empty/.test(base)) process.exit(0);                      // 真 qlmanage 出不来时就是这样：退 0、什么都没写
if (/^junk/.test(base)) { fs.writeFileSync(path.join(out, base + ".png"), "not a png".repeat(40)); process.exit(0); }
if (/^hang/.test(base)) {
  // 挂住不走，外加一个同进程组的孙进程：只杀自己的话它会被 init 收养接着转
  const g = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(side, base + ".pids"), JSON.stringify([process.pid, g.pid]));
  setInterval(() => {}, 1000);
} else process.exit(9);
`);
const calls = [];
const fakeSpawn = (cmd, args, o) => {
  calls.push({ cmd, args: [...args], detached: o && o.detached });
  // 顶替的是 nice 后面那个 qlmanage：nice 自己的参数原样记下，真正跑的是假脚本
  return cp.spawn(process.execPath, [FAKE, ...args.slice(3)], o);
};
const fx = (name, body = "x") => { const f = path.join(FIX, name); fs.writeFileSync(f, body); return f; };
const seen = (name) => { try { return JSON.parse(fs.readFileSync(path.join(SIDE, name + ".seen"), "utf8")); } catch { return null; } };
const base = { spawn: fakeSpawn, platform: "darwin", tmpRoot: TMP };

(async () => {
  console.log("【1】出得来：nice -n 10 起 qlmanage，读「原文件名.png」，临时目录用完就删");
  {
    calls.length = 0;
    const f = fx("ok-report.docx");
    const buf = await QL.qlThumb(f, { ...base, size: 320, timeoutMs: 5000 });
    ok(buf && buf.equals(fs.readFileSync(FIXTURE_PNG)), "回来的就是 qlmanage 写出的那张 PNG", buf && buf.length);
    const c = calls[0] || { args: [] };
    ok(calls.length === 1 && c.cmd === "/usr/bin/nice" && c.args.slice(0, 3).join(" ") === "-n 10 /usr/bin/qlmanage",
      "走 nice -n 10 /usr/bin/qlmanage（绝对路径：从访达启动时 PATH 很短）", calls);
    ok(c.args.includes("-t") && c.args[c.args.indexOf("-s") + 1] === "320" && c.args[c.args.length - 1] === f, "-t -s 320，最后一个参数是文件的绝对路径", c.args);
    ok(c.detached === true, "单独一个进程组起：到点能连孙进程一起杀", c);
    const s = seen("ok-report.docx");
    ok(s && s.outExisted && path.dirname(s.out) === TMP, "★反向对照★ 跑的时候临时目录真建在给定的临时根里", s);
    ok(s && !fs.existsSync(s.out) && names(TMP).length === 0, "跑完那个目录没了，临时根是空的", names(TMP));
  }

  console.log("\n【2】出不来一律 null，临时目录照样删");
  for (const [name, why] of [["fail-a.pdf", "退了非 0（目录里就算有图也不认）"], ["empty-a.pptx", "退 0 但什么都没写"], ["junk-a.xlsx", "写出来的不是 PNG"]]) {
    calls.length = 0;
    const r = await QL.qlThumb(fx(name), { ...base, timeoutMs: 5000 });
    const s = seen(name);
    ok(r === null && calls.length === 1 && s && s.outExisted, `${why}：null（假 qlmanage 确实跑了一趟）`, { r: r && r.length, calls: calls.length });
    ok(names(TMP).length === 0 && s && !fs.existsSync(s.out), `  └ 临时目录删了`, names(TMP));
  }

  console.log("\n【3】挂住不走：到点连进程组一起 SIGKILL，回 null，不陪着等");
  {
    calls.length = 0;
    const f = fx("hang-a.pdf");
    const t0 = Date.now();
    const p = QL.qlThumb(f, { ...base, timeoutMs: 900 });
    let pids = null;
    for (let i = 0; i < 40 && !pids; i++) { await sleep(20); try { pids = JSON.parse(fs.readFileSync(path.join(SIDE, "hang-a.pdf.pids"), "utf8")); } catch {} }
    ok(pids && pids.every(alive), "★反向对照★ 到点之前：假 qlmanage 和它的孙进程都活着（真在挂）", pids);
    const r = await p;
    const ms = Date.now() - t0;
    await sleep(100);
    ok(r === null && ms >= 850 && ms < 2500, `timeoutMs=900：${ms}ms 回 null`, ms);
    ok(pids && !pids.some(alive), "到点后两个进程都没了（进程组一起杀，孙进程没被落下）", pids && pids.map((x) => [x, alive(x)]));
    ok(names(TMP).length === 0, "  └ 临时目录删了", names(TMP));
    // ★反向对照★ 只杀它自己（不杀进程组）：孙进程被落下，还活着——所以非得按进程组杀
    const out = path.join(TMP, "manual");
    fs.mkdirSync(out, { recursive: true });
    const c = cp.spawn(process.execPath, [FAKE, "-t", "-o", out, fx("hang-c.pdf")], { stdio: "ignore", detached: true });
    let pc = null;
    for (let i = 0; i < 100 && !pc; i++) { await sleep(20); try { pc = JSON.parse(fs.readFileSync(path.join(SIDE, "hang-c.pdf.pids"), "utf8")); } catch {} }
    c.kill("SIGKILL");
    await sleep(200);
    ok(pc && !alive(pc[0]) && alive(pc[1]), "★反向对照★ 只 kill 它自己：它死了，孙进程还在转", pc && pc.map((x) => [x, alive(x)]));
    try { process.kill(-c.pid, "SIGKILL"); } catch {}
    try { if (pc) process.kill(pc[1], "SIGKILL"); } catch {}
    fs.rmSync(out, { recursive: true, force: true });
  }

  console.log("\n【4】叫停（signal）：立刻收手，不等到超时");
  {
    const f = fx("hang-b.key");
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 250);
    const r = await QL.qlThumb(f, { ...base, timeoutMs: 20000, signal: ac.signal });
    const ms = Date.now() - t0;
    let pids = []; try { pids = JSON.parse(fs.readFileSync(path.join(SIDE, "hang-b.key.pids"), "utf8")); } catch {}
    await sleep(100);
    ok(r === null && ms < 2000, `超时给了 20 秒，250ms 叫停：${ms}ms 就回来`, ms);
    ok(pids.length === 2 && !pids.some(alive), "  └ 挂着的两个进程都杀了", pids);
    calls.length = 0;
    const r2 = await QL.qlThumb(fx("ok-pre.pdf"), { ...base, signal: AbortSignal.abort() });
    ok(r2 === null && calls.length === 0, "进来之前就叫停了：不起进程", calls.length);
  }

  console.log("\n【5】不是 macOS、文件不在：不起 qlmanage");
  {
    calls.length = 0;
    const f = fx("ok-linux.pdf");
    const r = await QL.qlThumb(f, { ...base, platform: "linux" });
    ok(r === null && calls.length === 0, "platform=linux：null，一个进程都没起", calls.length);
    const r2 = await QL.qlThumb(f, { ...base, platform: "win32" });
    ok(r2 === null && calls.length === 0, "platform=win32：同样", calls.length);
    const r3 = await QL.qlThumb(f, { ...base });
    ok(r3 && calls.length === 1, "★反向对照★ 同一个文件换成 darwin：起了一趟、出了图", calls.length);
    calls.length = 0;
    const r4 = await QL.qlThumb(path.join(FIX, "ok-missing.pdf"), { ...base });
    ok(r4 === null && calls.length === 0, "文件不在：null 且不起 qlmanage（真 qlmanage 碰上不存在的文件不退出，会一直挂到超时）", calls.length);
    const r5 = await QL.qlThumb(FIX, { ...base });
    ok(r5 === null && calls.length === 0, "给的是目录：同样", calls.length);
  }

  console.log("\n【6】起不来（命令不存在）：null，不抛");
  {
    const r = await QL.qlThumb(fx("ok-nobin.pdf"), { ...base, spawn: (c, a, o) => cp.spawn("/definitely/not/here/qlmanage", a, o) });
    ok(r === null && names(TMP).length === 0, "spawn 报 ENOENT：null，临时目录删了", names(TMP));
    const r2 = await QL.qlThumb(fx("ok-throw.pdf"), { ...base, spawn: () => { throw new Error("boom"); } });
    ok(r2 === null && names(TMP).length === 0, "spawn 直接抛：同样", names(TMP));
  }

  console.log("\n【7】真 qlmanage（只在 macOS 上）");
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/qlmanage")) {
    console.log("  跳过：不是 macOS（Quick Look 只有 macOS 有，别的系统上资料库一律给文档出图标卡）");
  } else {
    const rtf = fx("tiny.rtf", "{\\rtf1\\ansi{\\fonttbl\\f0\\fswiss Helvetica;}\\f0\\fs48 Cover smoke\\par}");
    const t0 = Date.now();
    const buf = await QL.qlThumb(rtf, { size: 128, timeoutMs: 8000, tmpRoot: TMP });
    const ms = Date.now() - t0;
    const sz = pngSize(buf);
    ok(QL.isPng(buf) && sz && Math.max(sz.w, sz.h) <= 128 && Math.max(sz.w, sz.h) >= 64, `现写的 RTF 出了图：${sz && sz.w}×${sz && sz.h}，${ms}ms`, sz);
    ok(names(TMP).length === 0, "  └ 临时目录删了", names(TMP));
    // 认不出类型的 1 字节文件：本机实测真 qlmanage 碰上它不退出。不管这台机器上它这回挂不挂，结果都得是 null、不留进程
    const odd = fx("odd.owbnotatype", "x");
    const t1 = Date.now();
    const r = await QL.qlThumb(odd, { size: 128, timeoutMs: 1500, tmpRoot: TMP });
    const ms1 = Date.now() - t1;
    await sleep(200);
    const left = cp.spawnSync("ps", ["-A", "-ww", "-o", "pid=,args="], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.includes(odd));
    ok(r === null && ms1 < 3500, `认不出类型的文件：${ms1}ms 回 null`, ms1);
    ok(left.length === 0, "  └ 没留下 qlmanage 进程", left);
    ok(names(TMP).length === 0, "  └ 临时目录删了", names(TMP));
  }

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
