"use strict";
/**
 * 钩子：在 config.json 的 agent.hooks 里写几条命令，agent 干活的三个节点上自动跑。
 *
 *   before_shell  它要跑命令之前。退出码不是 0 就拦下，输出当理由交给它
 *   after_edit    它改完一个文件之后（write_file / edit_file / multi_edit）。输出接在改动回执后面，
 *                 格式化、lint 报的错它下一步就看得见；失败不撤销改动
 *   done          它说做完了、要收尾之前（只在改过文件的 craft 任务里跑）。不是 0 就打回去接着改，
 *                 最多打回两次——「测试没过不许交差」
 *
 * 写法：
 *   "hooks": {
 *     "after_edit":   [{ "match": "\\.(js|ts)$", "run": "npx prettier --write \"$OWB_FILE\"" }],
 *     "before_shell": [{ "match": "^git push", "run": "echo 推送要人来做; exit 1" }],
 *     "done":         [{ "run": "npm test", "timeout": 300 }]
 *   }
 *
 * 只认 config.json，不读项目目录里的任何文件：钩子是直接在本机跑的 shell，
 * 要是仓库里放一份就能生效，clone 一个陌生仓库、让 agent 在里面干活，就等于替那个仓库的作者跑了命令。
 *
 * 文件名、命令一律走环境变量（OWB_FILE / OWB_COMMAND），不往命令字符串里拼：
 * 文件名里带个 `;` 或 `$()` 就能变成第二条命令。
 */
const { spawn } = require("child_process");

const KINDS = ["before_shell", "after_edit", "done"];
const DEFAULT_TIMEOUT = 60;   // 秒
const MAX_TIMEOUT = 600;
const OUT_MAX = 4000;         // 交给模型的输出上限，测试一刷几万行全塞进去就把上下文吃光了

/**
 * 把配置收拾成 { before_shell: [], after_edit: [], done: [] }，外加 problems（写错了的每条都说为什么）。
 * 写错的那条不生效，别的照常——一条正则写坏了不该让所有钩子一起失灵。
 */
function normalize(raw) {
  const out = { before_shell: [], after_edit: [], done: [], problems: [] };
  if (!raw || typeof raw !== "object") return out;
  for (const k of Object.keys(raw)) {
    if (!KINDS.includes(k)) { out.problems.push(`hooks.${k}：不认识，只有 ${KINDS.join(" / ")}`); continue; }
    const list = Array.isArray(raw[k]) ? raw[k] : [raw[k]];
    list.forEach((h, i) => {
      const where = `hooks.${k}[${i}]`;
      const run = h && typeof h === "object" ? String(h.run || "").trim() : typeof h === "string" ? h.trim() : "";
      if (!run) { out.problems.push(`${where}：没写 run`); return; }
      let match = null;
      if (h && typeof h === "object" && h.match != null && String(h.match) !== "") {
        try { match = new RegExp(String(h.match)); }
        catch (e) { out.problems.push(`${where}：match 不是合法的正则（${e.message}）`); return; }
      }
      const t = Number(h && h.timeout);
      const timeout = t > 0 ? Math.min(t, MAX_TIMEOUT) : DEFAULT_TIMEOUT;
      out[k].push({ run, match, timeout, where });
    });
  }
  return out;
}

/** 这一条该不该跑：没写 match 就是都跑 */
function pick(list, text) {
  return (list || []).filter((h) => !h.match || h.match.test(String(text || "")));
}

function clip(s) {
  const t = String(s || "").trim();
  return t.length > OUT_MAX ? t.slice(0, OUT_MAX / 2) + `\n…（中间省略 ${t.length - OUT_MAX} 字符）…\n` + t.slice(-OUT_MAX / 2) : t;
}

/** 跑一条。返回 { code, out, timedOut }；code 为 null 表示没跑起来或被掐了 */
function runOne(hook, { cwd, env, stopSignal } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let child;
    try {
      child = spawn(hook.run, {
        shell: true, cwd, detached: process.platform !== "win32",
        env: { ...process.env, ...(env || {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) { resolve({ code: null, out: e.message, timedOut: false }); return; }
    const kill = () => {
      try {
        if (process.platform === "win32") {
          // shell:true 时 child 是 cmd.exe；只杀它会留下仍在执行的 Node/npm 等后代进程。
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          killer.on("error", () => { try { child.kill("SIGKILL"); } catch {} });
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch { try { child.kill("SIGKILL"); } catch {} }
    };
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); if (stopSignal) stopSignal.removeEventListener?.("abort", onAbort); resolve(r); };
    const timer = setTimeout(() => { kill(); finish({ code: null, out: clip(out), timedOut: true }); }, hook.timeout * 1000);
    const onAbort = () => { kill(); finish({ code: null, out: clip(out) + "\n（任务被停了，钩子一起停）", timedOut: false }); };
    if (stopSignal) { if (stopSignal.aborted) onAbort(); else stopSignal.addEventListener?.("abort", onAbort); }
    const eat = (b) => { if (out.length < OUT_MAX * 4) out += b.toString("utf8"); };
    child.stdout.on("data", eat);
    child.stderr.on("data", eat);
    child.on("error", (e) => finish({ code: null, out: clip(out + "\n" + e.message), timedOut: false }));
    child.on("close", (code) => finish({ code, out: clip(out), timedOut: false }));
  });
}

/** 按顺序跑，第一条失败就停：后面那条多半依赖前面那条（先格式化再 lint） */
async function runAll(list, ctx) {
  const ran = [];
  for (const h of list) {
    const r = await runOne(h, ctx);
    ran.push({ hook: h, ...r });
    if (r.code !== 0) return { ok: false, ran, failed: ran[ran.length - 1] };
  }
  return { ok: true, ran, failed: null };
}

function why(f) {
  if (f.timedOut) return `超时（${f.hook.timeout} 秒）被掐了`;
  if (f.code === null) return "没跑起来";
  return `退出码 ${f.code}`;
}

/** before_shell：null = 放行；否则是拦下时交给模型的那句话 */
async function beforeShell(hooks, command, ctx) {
  const list = pick(hooks && hooks.before_shell, command);
  if (!list.length) return null;
  const r = await runAll(list, { ...ctx, env: { OWB_HOOK: "before_shell", OWB_COMMAND: command } });
  if (r.ok) return null;
  return `这条命令被 before_shell 钩子（${r.failed.hook.where}）拦下了，${why(r.failed)}，没有执行。` +
    (r.failed.out ? `钩子的输出：\n${r.failed.out}` : "") +
    "\n钩子是用户在配置里写的规矩：换个做法，或者在最终回复里说明这一步要用户自己来。";
}

/** after_edit：返回接在改动回执后面的一段话；没钩子或都没输出就是空串 */
async function afterEdit(hooks, file, ctx) {
  const list = pick(hooks && hooks.after_edit, file);
  if (!list.length) return "";
  const r = await runAll(list, { ...ctx, env: { OWB_HOOK: "after_edit", OWB_FILE: file } });
  if (r.ok) {
    const said = r.ran.map((x) => x.out).filter(Boolean).join("\n");
    return said ? `\n\n[after_edit 钩子跑过了]\n${said}` : "";
  }
  return `\n\n[after_edit 钩子（${r.failed.hook.where}）${why(r.failed)}——改动已经写进去了，但钩子报了问题，看一下再往下走]\n${r.failed.out || "（没有输出）"}`;
}

/** done：null = 可以收尾；否则 { hook, text } 是打回去时交给模型的话 */
async function beforeDone(hooks, ctx) {
  const list = (hooks && hooks.done) || [];
  if (!list.length) return null;
  const r = await runAll(list, { ...ctx, env: { OWB_HOOK: "done" } });
  if (r.ok) return null;
  return {
    hook: r.failed.hook,
    why: why(r.failed),
    text: `【系统·收尾钩子】你要收尾了，但用户配的 done 钩子没过：\`${r.failed.hook.run}\` ${why(r.failed)}。输出：\n\n` +
      "```\n" + (r.failed.out || "（没有输出）") + "\n```\n\n" +
      "接着改到它通过为止。确实改不了（要用户拍板、缺环境），就在最终回复里明说钩子没过、卡在哪。严禁说成已经通过。",
  };
}

module.exports = { KINDS, normalize, pick, runOne, runAll, beforeShell, afterEdit, beforeDone, OUT_MAX, MAX_TIMEOUT };
