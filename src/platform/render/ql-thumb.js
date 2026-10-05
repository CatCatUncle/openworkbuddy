// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 文档封面：PDF、Word、Excel、PPT、Keynote、Pages、Numbers、RTF 的第一页，借 macOS 自带的 Quick Look
 * （qlmanage -t）出一张缩略图。本机实测一个 docx / pdf 约 0.3 秒，不用装任何东西。
 *
 * 只在 macOS 上有；别的系统、跑挂了、超时了、没出图，一律回 null，资料库那边就给图标卡。
 *
 * 为什么每一趟都要有超时并且到点连进程一起杀：2026-09-29 在本机量的，qlmanage 碰上不存在的文件、
 * 或者认不出类型的 1 字节文件，既不报错也不退出，一挂就是两分钟以上。资料库一屏就可能排上几十个文档，
 * 挂住一个，后面的封面全等着它。
 * 走 nice -n 10：封面是锦上添花，出图时不能抢用户手上正在干的活。
 */
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");

const QL_EXTS = ["pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "key", "pages", "numbers", "rtf"];
const QLMANAGE = "/usr/bin/qlmanage";
const NICE = "/usr/bin/nice";
const DEFAULT_TIMEOUT_MS = 8000;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @param {string} file 要出封面的文档（绝对路径最稳，相对路径按当前目录算）
 * @param {{size?: number, timeoutMs?: number, signal?: AbortSignal, spawn?: Function,
 *   platform?: string, tmpRoot?: string}} [opts]
 *   size：缩略图长边的像素上限（qlmanage 的 -s）。spawn / platform / tmpRoot 给测试换假的。
 * @returns {Promise<Buffer|null>} PNG；出不来就是 null
 */
async function qlThumb(file, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== "darwin") return null;
  const signal = opts.signal || null;
  if (signal && signal.aborted) return null;
  const abs = path.resolve(String(file || ""));
  // 文件不在就别起 qlmanage：它不报错，会一直挂到超时
  try { if (!(await fsp.stat(abs)).isFile()) return null; } catch { return null; }
  const size = clamp(Math.round(Number(opts.size) || 640), 16, 2048);
  const timeoutMs = clamp(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS, 200, 120000);
  let dir = "";
  try {
    dir = await fsp.mkdtemp(path.join(opts.tmpRoot || os.tmpdir(), "owb-ql-"));
    const r = await runQuiet(opts.spawn, NICE, ["-n", "10", QLMANAGE, "-t", "-s", String(size), "-o", dir, abs], { timeoutMs, signal });
    if (r.code !== 0) return null;
    // qlmanage 的产物名是「原文件名.png」，出不来时它照样退 0，只是目录里什么也没有
    const buf = await fsp.readFile(path.join(dir, path.basename(abs) + ".png")).catch(() => null);
    return isPng(buf) ? buf : null;
  } catch {
    return null;
  } finally {
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 起一个低优先级子进程跑完，最多 timeoutMs；到点或叫停就连整个进程组 SIGKILL，等它真退了才回来
 * （不然外面删临时目录时它可能还在往里写）。起不来算 code -1。
 * @param {Function|undefined} spawnFn 缺省是 child_process.spawn
 * @param {string} cmd @param {string[]} args
 * @param {{timeoutMs: number, signal?: AbortSignal|null}} o
 * @returns {Promise<{code: number, timedOut: boolean, aborted: boolean}>}
 */
function runQuiet(spawnFn, cmd, args, { timeoutMs, signal = null }) {
  const spawn = spawnFn || require("child_process").spawn;
  const win = process.platform === "win32";
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawn(cmd, args, { stdio: "ignore", detached: !win, windowsHide: true });
      // Windows 没有 nice：起来以后自己把优先级降到「低于正常」
      if (win && child && child.pid) { try { os.setPriority(child.pid, 10); } catch {} }
    } catch {
      resolve({ code: -1, timedOut: false, aborted: false });
      return;
    }
    let settled = false, timedOut = false, aborted = false, timer = null, grace = null;
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ code: timedOut || aborted ? -1 : code, timedOut, aborted });
    };
    const kill = () => {
      try { if (!win && child.pid) process.kill(-child.pid, "SIGKILL"); } catch {}
      try { child.kill("SIGKILL"); } catch {}
      // 杀了还等不到 exit（进程卡在内核里之类）：最多再等 1 秒，不能让调用方陪着挂
      grace = setTimeout(() => done(-1), 1000);
    };
    const onAbort = () => { if (!settled) { aborted = true; kill(); } };
    child.on("error", () => done(-1));
    child.on("exit", (code) => done(code == null ? -1 : code));
    timer = setTimeout(() => { if (!settled) { timedOut = true; kill(); } }, timeoutMs);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isPng(buf) {
  return !!(buf && buf.length > 100 && buf.subarray(0, 8).equals(PNG_SIG));
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

module.exports = { qlThumb, runQuiet, isPng, QL_EXTS, DEFAULT_TIMEOUT_MS };
