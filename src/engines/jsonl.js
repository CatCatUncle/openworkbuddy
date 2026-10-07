// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 底层 agent CLI 的共用外壳：起子进程、按行读 JSON、收尾。
 *
 * 三个 CLI（claude / codex / 以后别的）长得不一样，但外面这层是一样的：
 *   · 一行一条 JSON，边跑边解析 —— 不能等进程退出再一次性 parse，那样长任务全程没进度。
 *   · stderr 不是 JSON，是人话（"未登录"、"额度用完了"）。它必须留着，
 *     因为进程非零退出时，能告诉用户到底怎么了的只有它。
 *   · 停止 = 杀整棵进程树。CLI 自己还会派生子进程（bash、python、浏览器），
 *     只 kill 父进程会留下一堆孤儿继续跑、继续写文件。
 *     Unix 上 detached 起、按进程组杀；Windows 没有进程组，走 taskkill /T（见 ./win.js）。
 *
 * 一条硬规矩：**行内容坏了不许静默丢弃。** CLI 偶尔会往 stdout 混一行非 JSON
 * （升级提示、warning）。丢是对的，但要记进 junk 里 —— 否则"什么都没发生"
 * 和"我把你的输出吃了"在日志里长得一模一样。
 */

const { spawn } = require("child_process");
const { augmentedPath } = require("../platform/which");
const win = require("../platform/win");
const { buildChildEnv, keyLike } = require("../platform/child-env");
const { appPath } = require("../platform/paths");
const security = require("../core/safety/security");

/** stderr 只留尾巴：CLI 报错前可能刷了几万行日志，全留住等于把内存喂给一次失败 */
const STDERR_KEEP = 8000;

/**
 * 眼下还活着的引擎进程。平时用不上，给硬退出用：第二次 Ctrl+C、关终端窗口、被 kill 的时候，
 * 进程下一刻就没了，等不到各自的 close 回调——不在 exit 之前一把收掉，引擎连同它派生的
 * bash/python 就成了孤儿，接着改文件，时限也没人管了。
 */
const LIVE = new Set();
function killAll(signal = "SIGTERM") {
  for (const c of LIVE) { try { win.killTree(c, signal); } catch {} }
}

/**
 * 调用方追加的变量（引擎设置里的 env、桥给的 PATH）。多人共用时像 Key 的一个不留：
 * 引擎自带 shell，echo 一下就拿走了，而那把 Key 是属主的，不是这个成员的。
 * @param {Record<string, unknown> | undefined} env
 */
function callerEnv(env) {
  /** @type {Record<string, unknown>} */
  const out = {};
  const multi = security.isMultiUser();
  for (const [k, v] of Object.entries(env || {})) if (!(multi && keyLike(k))) out[k] = v;
  return out;
}

/** Windows 上 Path 和 PATH 是同一个变量；别的平台只认 PATH 这一种写法 */
const isPathKey = (k, platform) => (platform === "win32" ? String(k).toUpperCase() === "PATH" : k === "PATH");

/**
 * 两份追加的环境变量叠成一份：后一份照常盖前一份，只有 PATH 是拼——前一份的目录在前，后一份的接在后面。
 * 桥给的 PATH 只有 owb 那一个目录，属主在引擎设置里写了 PATH 也不能把它挤掉，挤掉了模型敲 owb 就找不到
 * @param {Record<string, unknown> | null | undefined} first
 * @param {Record<string, unknown> | null | undefined} second
 * @param {string} [platform] 测试用
 */
function mergeEnv(first, second, platform = process.platform) {
  /** @type {Record<string, unknown>} */
  const out = {};
  /** @type {string[]} */
  const dirs = [];
  for (const src of [first, second]) {
    for (const [k, v] of Object.entries(src || {})) {
      if (isPathKey(k, platform)) { if (v != null && v !== "") dirs.push(String(v)); continue; }
      out[k] = v;
    }
  }
  if (dirs.length) out.PATH = dirs.join(platform === "win32" ? ";" : ":");
  return out;
}

/**
 * 引擎子进程最终用的 PATH：调用方给的目录打头（桥的 owb 目录必须排第一），补全过的完整搜索路径接在后面，
 * 重复的只留第一次出现的那个（Windows 上不分大小写、不管结尾斜杠）。
 * 以前调用方一给 PATH 就整个盖掉补全那份：双击启动的应用自己的 PATH 是残的，借了工具的那趟，
 * 装在 nvm / homebrew 里、开头是 `#!/usr/bin/env node` 的 CLI 连 node 都找不到
 * @param {string} [callerPath]
 * @param {string} [platform] 测试用
 * @param {Record<string, string|undefined>} [env] 测试用
 */
function enginePath(callerPath = "", platform = process.platform, env = process.env) {
  const w = platform === "win32";
  const sep = w ? ";" : ":";
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const raw of [...String(callerPath || "").split(sep), ...augmentedPath(platform, env).split(sep)]) {
    const d = w ? raw.trim() : raw;
    if (!d) continue;
    const k = w ? d.toLowerCase().replace(/[\\/]+$/, "") : d;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out.join(sep);
}

/**
 * 程序自带的 node_modules 打头：引擎在对话目录里写的 node 脚本 require("pptxgenjs" / "docx" / "exceljs") 靠它找到。
 * 打包版的数据目录跟程序目录分开，从对话目录往上找不到程序那份。用户自己设过的接在后面
 * @param {Record<string, string|undefined>} [env]
 */
function engineNodePath(env = process.env) {
  const sep = process.platform === "win32" ? ";" : ":";
  const mine = appPath("node_modules");
  return [mine, ...String(env.NODE_PATH || "").split(sep).filter((d) => d && d !== mine)].join(sep);
}

/**
 * @param {object}   o
 * @param {string}   o.bin           可执行文件路径
 * @param {string[]} o.args
 * @param {string}   o.cwd           在哪个目录干活
 * @param {object}   [o.env]         追加的环境变量
 * @param {string}   [o.stdin]       要写进 stdin 的内容（写完即关）
 * @param {function} o.onLine        每解析出一条 JSON 调一次
 * @param {number}   [o.deadline]    墙上时间截止（Date.now() 口径），到点杀进程
 * @param {object}   [o.stopSignal]  AbortSignal 当场生效；只有 { aborted: boolean } 的老式对象按 2 秒轮询
 * @returns {Promise<{code:number, killed:string|null, stderr:string, junk:string[]}>}
 *          killed: null=正常退出 | "deadline" | "stopped"
 */
function runJsonl({ bin, args, cwd, env, stdin, onLine, deadline, stopSignal }) {
  return new Promise((resolve, reject) => {
    let junkWarn = ""; // 兜底路径的「参数超长」预警，等收尾时跟别的杂音一起交出去
    // Windows 上 npm 装出来的是 claude.cmd 这种垫片，Node 18.20.2 起直接 spawn 它会 EINVAL；
    // 而经 cmd.exe 转发又扛不住上万字的系统提示词（8191 上限）。plan 负责挑一条真能走通的路
    const plan = win.launchPlan(bin, args);
    const extra = mergeEnv(plan.env, callerEnv(env));
    let child;
    try {
      child = spawn(plan.bin, plan.args, {
        cwd,
        // PATH 得补全：CLI 自己还要去调 node / git / ripgrep，双击启动的 GUI 进程
        // 那份残废 PATH 传下去，claude 起来了照样在第一个工具调用上死掉。调用方给的 PATH 拼在前面，不是盖掉（见 enginePath）。
        // 别的变量只给白名单里的：引擎自带 shell，环境里的 Key 它一句 echo 就拿走了。
        // 属主清单照样生效——单人用「环境变量 Key」登 claude / codex 的，把那个名字写进清单
        env: buildChildEnv({ NODE_PATH: engineNodePath(), ...extra, PATH: enginePath(/** @type {string} */ (extra.PATH)) }),
        stdio: ["pipe", "pipe", "pipe"],
        ...plan.opts,
      });
    } catch (e) {
      return reject(new Error(`起不来 ${bin}：${e.message}`));
    }
    // 兜底那条路参数超长时先把话说在前头：失败了报出来的会是 cmd 的乱码错，跟真实原因对不上
    if (plan.warn) junkWarn = plan.warn;
    LIVE.add(child);

    let killed = null;
    let stderr = "";
    const junk = [];
    let buf = "";
    let settled = false;

    const killTree = (why) => {
      if (killed || settled) return;
      killed = why;
      win.killTree(child, "SIGTERM");
      // 给它 3 秒体面退出（写完文件、关掉浏览器），之后不客气
      setTimeout(() => win.killTree(child, "SIGKILL"), 3000).unref();
    };

    // 时限靠这一个轮询：2 秒一次，比起给每种情况各挂一套定时器更好收尾。
    // 手动停止不能等这一跳：是真 AbortSignal 就直接挂监听，一按就杀——以前最多晚 2 秒，
    // 而人按完第一下 Ctrl+C 没见动静，第二下紧跟着就来了。纯 { aborted } 对象挂不上监听，照旧靠轮询
    const tick = setInterval(() => {
      if (stopSignal && stopSignal.aborted) killTree("stopped");
      else if (deadline && Date.now() >= deadline) killTree("deadline");
    }, 2000);
    const onAbort = () => killTree("stopped");
    const listens = !!stopSignal && typeof stopSignal.addEventListener === "function";
    if (listens) {
      if (stopSignal.aborted) onAbort();
      else stopSignal.addEventListener("abort", onAbort, { once: true });
    }
    // 收尾要拆干净：同一个信号一趟任务里可能跑好几次引擎，不拆的话监听越堆越多
    const unhook = () => {
      clearInterval(tick);
      LIVE.delete(child);
      if (listens) stopSignal.removeEventListener("abort", onAbort);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { junk.push(line.slice(0, 300)); continue; }
        try { onLine(obj); } catch (e) { junk.push("[onLine] " + e.message); }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      stderr += c;
      if (stderr.length > STDERR_KEEP) stderr = stderr.slice(-STDERR_KEEP);
    });

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      unhook();
      reject(new Error(`${bin} 跑不起来：${e.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      unhook();
      // 最后一行可能没有换行符结尾，收尾时补一次解析，别把 result 那行丢了
      const tail = buf.trim();
      if (tail) {
        try { onLine(JSON.parse(tail)); } catch { junk.push(tail.slice(0, 300)); }
      }
      if (junkWarn && code !== 0) junk.push(junkWarn);
      resolve({ code: code == null ? -1 : code, killed, stderr: stderr.trim(), junk });
    });

    if (stdin != null) {
      child.stdin.on("error", () => {}); // CLI 提前退出时 EPIPE，不是我们的错
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

/** 探测一个 CLI 装没装：只跑 --version，不花任何额度 */
function probeVersion(bin, args = ["--version"], timeoutMs = 8000) {
  return new Promise((resolve) => {
    let child;
    const p = win.launchPlan(bin, args);
    try { child = spawn(p.bin, p.args, { stdio: ["ignore", "pipe", "pipe"], env: buildChildEnv({ PATH: augmentedPath(), ...p.env }), ...p.opts }); }
    catch { return resolve({ installed: false, version: "" }); }
    let out = "";
    const done = (ok) => { try { child.kill("SIGKILL"); } catch {} resolve({ installed: ok, version: firstVersionLine(out) }); };
    const t = setTimeout(() => done(false), timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c)); // 有的 CLI 把版本号打到 stderr
    child.on("error", () => { clearTimeout(t); done(false); });
    child.on("close", (code) => { clearTimeout(t); done(code === 0); });
  });
}

/**
 * 探一个「选项存不存在」——不花额度、不连网、不碰用户会话。
 *
 * 为什么需要探：claude 对**不认识的**命令行选项是静默忽略的
 * （实测 `claude --nosuchflag x --version` 照样退出 0），所以直接把 --thinking 发过去，
 * 老版本上什么也不会发生，用户点了「关闭思考」却毫无效果，还看不出为什么。
 *
 * 手法：给这个选项一个绝不可能合法的值。选项存在 → 值校验不过、非零退出并且报错里点了它的名字；
 * 选项不存在 → 整个参数被当垃圾吞掉，照常退出 0。两种结果泾渭分明。
 *
 * @returns {Promise<boolean>} 支持则 true。探测本身出错一律当"不支持"——宁可少发一个参数
 */
function probeOption(bin, flag, bogus = "__owb_probe__", timeoutMs = 8000) {
  return new Promise((resolve) => {
    let child;
    const p = win.launchPlan(bin, [flag, bogus, "--version"]);
    try { child = spawn(p.bin, p.args, { stdio: ["ignore", "pipe", "pipe"], env: buildChildEnv({ PATH: augmentedPath(), ...p.env }), ...p.opts }); }
    catch { return resolve(false); }
    let out = "";
    const done = (v) => { try { child.kill("SIGKILL"); } catch {} resolve(v); };
    const t = setTimeout(() => done(false), timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("error", () => { clearTimeout(t); done(false); });
    child.on("close", (code) => { clearTimeout(t); done(code !== 0 && out.includes(flag)); });
  });
}

/**
 * 看 `bin --help` 里有没有某个选项名。
 *
 * 给 probeOption 探不出来的选项用：--add-dir 这种"给个不存在的目录也照样 exit 0"的选项，
 * 塞假值那一招判不出支持与否。--help 是最老实的：印出来就是认，没印就是不认。
 */
function probeHelp(bin, needle, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let child;
    const p = win.launchPlan(bin, ["--help"]);
    try { child = spawn(p.bin, p.args, { stdio: ["ignore", "pipe", "pipe"], env: buildChildEnv({ PATH: augmentedPath(), ...p.env }), ...p.opts }); }
    catch { return resolve(false); }
    let out = "";
    const done = (v) => { try { child.kill("SIGKILL"); } catch {} resolve(v); };
    const t = setTimeout(() => done(false), timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("error", () => { clearTimeout(t); done(false); });
    child.on("close", () => { clearTimeout(t); done(out.includes(needle)); });
  });
}

function firstVersionLine(raw) {
  const line = String(raw || "").split("\n").map((s) => s.trim()).find(Boolean) || "";
  return line.slice(0, 80);
}

module.exports = { runJsonl, killAll, probeVersion, probeOption, probeHelp, callerEnv, mergeEnv, enginePath };
