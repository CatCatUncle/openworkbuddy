// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 收拾 Windows 免安装版留在 %TEMP% 里的解压目录。
 *
 * 免安装版每次启动把整包解压到 %TEMP%\nsXXXX.tmp\app，正常退出时外壳自己删掉；
 * 被任务管理器结束、关机、断电时来不及删，一份就是几百 MB，攒几次能吃掉好几 GB。
 * 0.10.6 及以前解压到一个构建时定死的 27 位随机名目录（%TEMP%\<ksuid>），一样会留。
 *
 * 只删同时满足这几条的：
 *   · 目录名是上面两种形状之一，里面有 OpenWorkBuddy.exe，且 resources/app/package.json 的 name 是本应用；
 *   · 不是自己正在跑的那份；
 *   · 那个 exe 没人在用：正在运行的 exe 在 Windows 上打不开写，打得开才说明它已经退了；
 *   · 建了超过 30 分钟：另一份免安装版可能正解压到一半，exe 已落地但还没启动，这时它看着也「没人用」。
 * 任何一步拿不准就不删。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXE = "OpenWorkBuddy.exe";
const MIN_AGE_MS = 30 * 60 * 1000;

function exeInUse(exe) {
  try {
    fs.closeSync(fs.openSync(exe, "r+"));
    return false;
  } catch {
    return true;
  }
}

function ourApp(appDir) {
  try {
    if (!fs.statSync(path.join(appDir, EXE)).isFile()) return false;
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, "resources", "app", "package.json"), "utf8"));
    return pkg && pkg.name === "openworkbuddy";
  } catch {
    return false;
  }
}

/** 返回可以删的目录（要删的是整个 nsXXXX.tmp / ksuid 目录，不只是里面的 app） */
function staleDirs({ tmp = os.tmpdir(), self = path.dirname(process.execPath), now = Date.now(), inUse = exeInUse } = {}) {
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  let names = [];
  try {
    names = fs.readdirSync(tmp, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    let appDir;
    if (/^ns[0-9a-z]{1,8}\.tmp$/i.test(name)) appDir = path.join(tmp, name, "app");
    else if (/^[0-9a-z]{27}$/i.test(name)) appDir = path.join(tmp, name);
    else continue;
    if (same(appDir, self) || !ourApp(appDir)) continue;
    let st;
    try { st = fs.statSync(path.join(tmp, name)); } catch { continue; }
    const born = st.birthtimeMs > 0 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs;
    if (now - born < MIN_AGE_MS) continue;
    if (inUse(path.join(appDir, EXE))) continue;
    out.push(path.join(tmp, name));
  }
  return out;
}

/** 异步删，删一个算一个；返回删掉的目录 */
async function sweepStale(opts = {}) {
  const done = [];
  for (const dir of staleDirs(opts)) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 2 });
      done.push(dir);
    } catch {}
  }
  return done;
}

module.exports = { staleDirs, sweepStale, exeInUse, MIN_AGE_MS };
