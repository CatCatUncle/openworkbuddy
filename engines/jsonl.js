"use strict";
/**
 * 底层 agent CLI 的共用外壳：起子进程、按行读 JSON、收尾。
 *
 * 三个 CLI（claude / codex / 以后别的）长得不一样，但外面这层是一样的：
 *   · 一行一条 JSON，边跑边解析 —— 不能等进程退出再一次性 parse，那样长任务全程没进度。
 *   · stderr 不是 JSON，是人话（"未登录"、"额度用完了"）。它必须留着，
 *     因为进程非零退出时，能告诉用户到底怎么了的只有它。
 *   · 停止 = 杀整棵进程树。CLI 自己还会派生子进程（bash、python、浏览器），
 *     只 kill 父进程会留下一堆孤儿继续跑、继续写文件。所以 detached 起、按进程组杀。
 *
 * 一条硬规矩：**行内容坏了不许静默丢弃。** CLI 偶尔会往 stdout 混一行非 JSON
 * （升级提示、warning）。丢是对的，但要记进 junk 里 —— 否则"什么都没发生"
 * 和"我把你的输出吃了"在日志里长得一模一样。
 */

const { spawn } = require("child_process");

/** stderr 只留尾巴：CLI 报错前可能刷了几万行日志，全留住等于把内存喂给一次失败 */
const STDERR_KEEP = 8000;

/**
 * @param {object}   o
 * @param {string}   o.bin           可执行文件路径
 * @param {string[]} o.args
 * @param {string}   o.cwd           在哪个目录干活
 * @param {object}   [o.env]         追加的环境变量
 * @param {string}   [o.stdin]       要写进 stdin 的内容（写完即关）
 * @param {function} o.onLine        每解析出一条 JSON 调一次
 * @param {number}   [o.deadline]    墙上时间截止（Date.now() 口径），到点杀进程
 * @param {object}   [o.stopSignal]  { aborted: boolean } —— 轮询式，和 agent.js 里那套一致
 * @returns {Promise<{code:number, killed:string|null, stderr:string, junk:string[]}>}
 *          killed: null=正常退出 | "deadline" | "stopped"
 */
function runJsonl({ bin, args, cwd, env, stdin, onLine, deadline, stopSignal }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true, // 自成进程组，收尾时才杀得干净
      });
    } catch (e) {
      return reject(new Error(`起不来 ${bin}：${e.message}`));
    }

    let killed = null;
    let stderr = "";
    const junk = [];
    let buf = "";
    let settled = false;

    const killTree = (why) => {
      if (killed || settled) return;
      killed = why;
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
      // 给它 3 秒体面退出（写完文件、关掉浏览器），之后不客气
      setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 3000).unref();
    };

    // 时限与手动停止都靠这一个轮询：2 秒一次，比起给每种情况各挂一套定时器更好收尾
    const tick = setInterval(() => {
      if (stopSignal && stopSignal.aborted) killTree("stopped");
      else if (deadline && Date.now() >= deadline) killTree("deadline");
    }, 2000);

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
      clearInterval(tick);
      reject(new Error(`${bin} 跑不起来：${e.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      // 最后一行可能没有换行符结尾，收尾时补一次解析，别把 result 那行丢了
      const tail = buf.trim();
      if (tail) {
        try { onLine(JSON.parse(tail)); } catch { junk.push(tail.slice(0, 300)); }
      }
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
    try { child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] }); }
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

function firstVersionLine(raw) {
  const line = String(raw || "").split("\n").map((s) => s.trim()).find(Boolean) || "";
  return line.slice(0, 80);
}

module.exports = { runJsonl, probeVersion };
