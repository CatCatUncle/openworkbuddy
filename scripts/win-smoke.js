// SPDX-License-Identifier: MIT
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle)
"use strict";
/**
 * Windows 包冒烟：装上、打开、等到页面加载完。只在 release.yml 的 Windows 腿上跑。
 *
 * 作者手里只有 Mac，Windows 包以前打完就直接上传，从来没在 Windows 上真启动过一次。
 * 用户报「Windows 上装了没反应」时，连「这个包在一台干净的 Windows 上起不起得来」都答不上。
 * 这一步把它答死：装不上、起不来、页面没加载完，这条腿就红，坏包进不了 Release。
 *
 *   · 安装版（-win-setup.exe）：静默装进一个带空格和中文的自选目录，再从装好的位置启动。必须过。
 *   · x64 免安装版：每次启动都要把整包解压到 %TEMP%，慢是已知代价。
 *     日志里写了失败（✗）或者进程自己退了才算红；只是等超时，记一条警告，不拦发版。
 *
 * 每一趟都用自己的临时数据目录（OPENWORKBUDDY_HOME），开隐藏运行（OWB_SHELL_HIDDEN=1）：
 * 起不来时的报错框改成往输出里打一行，不会弹出来挂住流水线。
 * 隐藏运行默认把 stdin 当遥控线，stdin 一断就退（测试宿主没了别留孤儿）。这里没有遥控线：
 * 安装版拿到的是空 stdin，免安装版的解压壳干脆不往下传，两条都是一启动就「断了」、当场退出码 0。
 * 所以加 OWB_SHELL_STDIN=0 关掉这条，收尾靠 taskkill 整棵进程树。
 *
 * 用法：node scripts/win-smoke.js [dist 目录]
 */
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const OK_LINE = "页面加载完成 ✓ 启动成功"; // electron-main.js 里 did-finish-load 那一行
const pkg = require("../package.json");

function tail(s, n = 40) {
  return String(s || "").split(/\r?\n/).slice(-n).join("\n");
}

function killTree(pid) {
  if (!pid) return;
  cp.spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 30000 });
}

/** 起一趟，等日志里出现成功那一行。返回 { ok, why, ms, log, out } */
function boot(exe, label, timeoutMs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-smoke-"));
  const logFile = path.join(home, "logs", "boot.log");
  const env = {
    ...process.env,
    OPENWORKBUDDY_HOME: home,
    OWB_SHELL_HIDDEN: "1",
    OWB_SHELL_STDIN: "0",
    OWB_USER_DATA_DIR: path.join(home, "userdata"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const t0 = Date.now();
  const child = cp.spawn(exe, [], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  let exited = null;
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.on("exit", (code, sig) => { exited = `退出码 ${code}${sig ? " / " + sig : ""}`; });
  child.on("error", (e) => { exited = "没启动起来：" + e.message; });
  console.log(`[冒烟] ${label}：${exe}`);
  let failSeen = 0;
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      let log = "";
      try { log = fs.readFileSync(logFile, "utf8"); } catch {}
      const ms = Date.now() - t0;
      // ✗ 之后再等 15 秒：隐藏运行时窗口不亮相，20 秒的启动看门狗在慢机器上会先叫一声，页面随后照样加载完
      if (!failSeen && /✗ /.test(log)) failSeen = Date.now();
      let res = null;
      if (log.includes(OK_LINE)) res = { ok: true, why: "页面加载完成" };
      else if (failSeen && Date.now() - failSeen > 15000) res = { ok: false, why: "启动日志里记了失败" };
      else if (exited) res = { ok: false, why: "进程自己退了（" + exited + "）" };
      else if (ms > timeoutMs) res = { ok: false, timeout: true, why: `等了 ${Math.round(ms / 1000)} 秒，页面还没加载完` };
      if (!res) return;
      clearInterval(tick);
      killTree(child.pid);
      resolve({ ...res, ms, log, out });
    }, 500);
  });
}

function report(label, r) {
  if (r.ok) {
    console.log(`[冒烟] ✓ ${label}：${Math.round(r.ms / 1000)} 秒页面加载完`);
    const bad = String(r.log).split(/\r?\n/).filter((l) => /✗ /.test(l));
    if (bad.length) console.log(`::warning::${label}最后加载完了，但启动途中记过失败：${bad[0].slice(0, 200)}`);
    return;
  }
  console.log(`[冒烟] ✗ ${label}：${r.why}`);
  console.log("—— 启动日志 boot.log（最后 40 行）——\n" + (tail(r.log) || "（没写出来）"));
  console.log("—— 进程输出（最后 40 行）——\n" + (tail(r.out) || "（没有输出）"));
}

async function main() {
  if (process.platform !== "win32") {
    console.log("[冒烟] 不是 Windows，跳过");
    return;
  }
  const dist = path.resolve(process.argv[2] || "dist");
  const files = fs.readdirSync(dist);
  const setup = files.find((f) => /-win-setup\.exe$/i.test(f));
  if (!setup) throw new Error(`${dist} 里没有 *-win-setup.exe。有的是：${files.join(", ")}`);

  // 向导式安装包，静默装：/currentuser 只给自己装（不弹 UAC），/D= 指定位置（NSIS 规定它必须放最后、不加引号）。
  // 位置故意带空格和中文：用户在向导里选「D:\软件 安装\OpenWorkBuddy」这种目录，就是走这条路。
  // 静默装完不会自己启动（要再加 --force-run 才启动），下面自己起
  const dir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), "装 这里", "OpenWorkBuddy");
  console.log(`[冒烟] 静默安装 ${setup} → ${dir}`);
  const t0 = Date.now();
  const inst = cp.spawnSync(path.join(dist, setup), ["/S", "/currentuser", "/D=" + dir], { stdio: "inherit", timeout: 10 * 60 * 1000 });
  if (inst.error) throw new Error("安装包没跑起来：" + inst.error.message);
  if (inst.status !== 0) throw new Error(`安装包退出码 ${inst.status}`);
  console.log(`[冒烟] 安装完成，用了 ${Math.round((Date.now() - t0) / 1000)} 秒`);

  const exe = path.join(dir, "OpenWorkBuddy.exe");
  if (!fs.existsSync(exe)) {
    // 没装进 /D 指的地方：多半是装到默认位置去了，报出来方便看是哪条没吃到
    const progs = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs");
    const elsewhere = [pkg.name, "OpenWorkBuddy"].map((d) => path.join(progs, d, "OpenWorkBuddy.exe")).filter((f) => fs.existsSync(f));
    throw new Error(`装完 ${dir} 里没有 OpenWorkBuddy.exe` + (elsewhere.length ? `，倒是在 ${elsewhere[0]}（/D= 没生效）` : ""));
  }

  // 系统沙箱的小助手得跟着装进去：漏了的话设置页照样有开关，命令却一直不在沙箱里跑
  const helper = path.join(dir, "resources", "app", "native", "bin", `owb-sandbox-${process.arch}.exe`);
  if (!fs.existsSync(helper)) throw new Error(`装完没有沙箱小助手：${helper}`);

  let failed = false;
  const a = await boot(exe, "安装版", 3 * 60 * 1000);
  report("安装版", a);
  if (!a.ok) failed = true;

  const portable = files.find((f) => /-win-x64-portable\.exe$/i.test(f));
  if (!portable) {
    console.log("::error::没找到 x64 免安装版");
    failed = true;
  } else {
    const b = await boot(path.join(dist, portable), "x64 免安装版", 8 * 60 * 1000);
    report("x64 免安装版", b);
    if (!b.ok && b.timeout) console.log(`::warning::x64 免安装版${b.why}（每次启动都要解压整包，慢是已知代价；不拦发版）`);
    else if (!b.ok) failed = true;
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error("[冒烟] ✗ " + ((e && e.message) || e));
  process.exit(1);
});
