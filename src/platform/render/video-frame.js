// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 视频封面：ffmpeg 取第 1 秒那一帧，按宽度缩好，出一张 PNG。
 *
 * 取第 1 秒不取第 0 帧：成片的第 0 帧常是黑场或淡入的头一格，当封面就是一块黑。
 * 不到 1 秒的短片第 1 秒没有画面，ffmpeg 照样退 0、只是什么也不写，这时退回第 0 帧再取一次。
 *
 * 没装 ffmpeg、跑挂了、超时了一律回 null（资料库给图标卡）；每一趟都有超时，到点连进程一起杀，
 * 走低优先级（nice -n 10）：封面是锦上添花，不能跟用户手上正在跑的成片抢 CPU。
 */
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");
const { runQuiet, isPng } = require("./ql-thumb");

const VIDEO_EXTS = ["mp4", "mov", "webm", "mkv", "m4v"];
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * @param {string} file
 * @param {{width?: number, timeoutMs?: number, signal?: AbortSignal, spawn?: Function,
 *   ffmpeg?: string, tmpRoot?: string, platform?: string}} [opts]
 *   ffmpeg：给了就用这个，不给就按设置页那一套去找（src/platform/media-probe）；找不到回 null。
 * @returns {Promise<Buffer|null>}
 */
async function videoFrame(file, opts = {}) {
  const signal = opts.signal || null;
  if (signal && signal.aborted) return null;
  const abs = path.resolve(String(file || ""));
  try { if (!(await fsp.stat(abs)).isFile()) return null; } catch { return null; }
  const ffmpeg = opts.ffmpeg != null ? String(opts.ffmpeg) : await findFfmpeg();
  if (!ffmpeg) return null;
  const width = clamp(Math.round(Number(opts.width) || 640), 16, 4096);
  const timeoutMs = clamp(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS, 200, 120000);
  const until = Date.now() + timeoutMs;
  const platform = opts.platform || process.platform;
  let dir = "";
  try {
    dir = await fsp.mkdtemp(path.join(opts.tmpRoot || os.tmpdir(), "owb-vf-"));
    for (const at of ["1", "0"]) {
      const left = until - Date.now();
      if (left < 200 || (signal && signal.aborted)) return null;
      const out = path.join(dir, `frame-${at}.png`);
      const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-ss", at, "-i", abs, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-an", out];
      const [cmd, argv] = platform === "win32" ? [ffmpeg, args] : ["nice", ["-n", "10", ffmpeg, ...args]];
      const r = await runQuiet(opts.spawn, cmd, argv, { timeoutMs: left, signal });
      if (r.timedOut || r.aborted) return null;
      if (r.code !== 0) return null; // 解不开（坏文件、不是视频）：再取一次也一样
      const buf = await fsp.readFile(out).catch(() => null);
      if (isPng(buf)) return buf;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function findFfmpeg() {
  try { return (await require("../media-probe").resolveMediaBins()).ffmpeg.bin || ""; } catch { return ""; }
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

module.exports = { videoFrame, VIDEO_EXTS, DEFAULT_TIMEOUT_MS };
