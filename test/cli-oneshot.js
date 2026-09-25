"use strict";
/**
 * 命令行单发：脚本、编排器、别的 agent 拿它当子进程调的时候会踩的几个坑。
 *
 *   ① 命令行给了任务、stdin 是开着不关的管道：3 秒没来字就照跑，不一直挂着（来了字照旧读到头）
 *   ② --session / resume 给了不存在的 id：退出码 2、给出近似的 id，不悄悄开个空会话照样花钱
 *   ③ sessions / engines 带 --json：一行一个 JSON，不是给人看的表
 *   ④ 列会话先按时间截、再读内容：sessions 2 只读两个文件，-c 只读最新那一个
 *   ⑤ --version / --help 不加载 agent、express 这些大件
 *   ⑥ --json 下依赖里的 console.log（「MCP 已连接」）不许混进 stdout，不然 | jq 第一行就炸
 *   ⑦ 跑到一半被 kill / 关了终端窗口：这一轮落盘、网页上那条标成结束、按信号给退出码，不是悄无声息地没了
 *   ⑧ 跑着的时候网页 / 手机也写了这条会话：两边的对话记录都在，那边的上下文另存一份，不整份盖掉
 *   ⑨ 网页端记着这条正在跑：开跑前提醒一句（只提醒不拦：服务端崩了没清的话这条记录是过期的）
 *   ⑩ 工作目录（往上到 git 根）的 AGENTS.md 真的进了发给模型的请求——以前命令行一个字都不读，/init 白写
 *   ⑪ 没人坐在终端前时碰到要批的一步：当场拒、说清楚怎么放行，不是干等两分钟；--allow 点名放行那一类
 *
 * 模型是本地假的，不出网。
 *   node test/cli-oneshot.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "cli.js");

let pass = 0;
const ok = (cond, name, extra) => {
  assert.ok(cond, name + (extra !== undefined ? "\n" + (typeof extra === "string" ? extra : JSON.stringify(extra)) : ""));
  pass++;
  console.log("  ✅ " + name);
};

// 装进子进程的探针：记下读过哪些会话文件、加载过哪些模块，退出时写给测试看
const HOOK = `
const fs = require("fs"), path = require("path"), Module = require("module");
const reads = [], loaded = new Set();
const orig = fs.readFileSync;
const tag = path.sep + "sessions" + path.sep;
fs.readFileSync = function (p, ...a) {
  const r = orig.call(this, p, ...a); // 读成了才算：新会话开跑前会先试着读一下自己那个还不存在的文件
  if (typeof p === "string" && p.includes(tag) && p.endsWith(".json")) reads.push(path.basename(p));
  return r;
};
const load = Module._load;
Module._load = function (req) { loaded.add(req); return load.apply(this, arguments); };
process.on("exit", () => { try { fs.writeFileSync(process.env.OWB_HOOK_OUT, JSON.stringify({ reads, loaded: [...loaded] })); } catch {} });
`;

const FAKE_MCP = `
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
    if (m.method === "initialize") reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
    else if (m.method === "tools/list") reply({ tools: [{ name: "ping", inputSchema: { type: "object" } }] });
  }
});
`;

async function setup({ mcp = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-oneshot-"));
  const ws = path.join(home, "ws");
  fs.mkdirSync(ws);
  const bodies = [];
  let hold = null; // 让模型「想」多久：设成一个 Promise，回话前先等它
  let reply = null; // 这一轮回什么：(请求体) => message；不设就一句「做完了。」
  const llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      bodies.push(raw);
      if (hold) await hold;
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      const message = reply ? reply(body) : { role: "assistant", content: "做完了。" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    });
  });
  await new Promise((r) => llm.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${llm.address().port}/v1`;
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  cfg.provider = "openai";
  cfg.openai = { base_url: base, api_key: "k", model: "mock", stream: false };
  cfg.models = [{ name: "假模型", provider: "openai", base_url: base, api_key: "k", model: "mock", stream: false }];
  cfg.active_model = "假模型";
  cfg.agent = { ...(cfg.agent || {}), max_steps: 4, llm_retries: 0 };
  cfg.mcp_servers = [];
  if (mcp) {
    const script = path.join(home, "fake-mcp.js");
    fs.writeFileSync(script, FAKE_MCP);
    cfg.mcp_servers = [{ name: "fake", command: process.execPath, args: [script] }];
  }
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg));
  const hook = path.join(home, "hook.js");
  fs.writeFileSync(hook, HOOK);
  const sessDir = path.join(home, "data", "sessions");
  fs.mkdirSync(sessDir, { recursive: true });
  return {
    home, ws, bodies, sessDir,
    setHold(p) { hold = p; },
    setReply(fn) { reply = fn; },
    /** 起一趟 cli.js。stdin：ignore（不接）/ open（开着不关）/ 字符串（写完就关）/ { later, ms }（隔 ms 毫秒才写）。
     *  onSpawn(kid)：进程起来之后测试要对它做点什么（发信号、趁它跑着改文件） */
    run(args, { stdin = "ignore", ms = 30000, env: extraEnv = {}, onSpawn } = {}) {
      const hookOut = path.join(home, `hook-${Math.random().toString(36).slice(2)}.json`);
      return new Promise((resolve) => {
        const t0 = Date.now();
        const kid = spawn(process.execPath, ["--require", hook, CLI, ...args], {
          env: { ...process.env, OPENWORKBUDDY_HOME: home, NO_COLOR: "1", OWB_HOOK_OUT: hookOut, ...extraEnv },
          stdio: [stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
          cwd: ws,
        });
        let out = "", err = "", hung = false;
        kid.stdout.on("data", (d) => (out += d));
        kid.stderr.on("data", (d) => (err += d));
        if (typeof stdin === "string" && stdin !== "open" && stdin !== "ignore") kid.stdin.end(stdin);
        if (stdin && typeof stdin === "object") setTimeout(() => kid.stdin.end(stdin.later), stdin.ms);
        const t = setTimeout(() => { hung = true; kid.kill("SIGKILL"); }, ms);
        if (onSpawn) Promise.resolve(onSpawn(kid)).catch((e) => { err += "\n[onSpawn] " + e.message; });
        kid.on("close", (code) => {
          clearTimeout(t);
          if (kid.stdin) kid.stdin.destroy();
          let probe = { reads: [], loaded: [] };
          try { probe = JSON.parse(fs.readFileSync(hookOut, "utf8")); } catch {}
          resolve({ code, out, err, hung, elapsed: Date.now() - t0, ...probe });
        });
      });
    },
    close() {
      llm.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 30)); } return false; };
const readSess = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
const jsonLines = (s) => s.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return { $bad: l }; } });
const seedSession = (dir, id, mtimeSec, title) => {
  const f = path.join(dir, id + ".json");
  fs.writeFileSync(f, JSON.stringify({ title, history: [{ role: "user", content: "前文 " + title }, { role: "assistant", content: "好" }], transcript: [{ type: "user", text: "前文" }] }));
  fs.utimesSync(f, mtimeSec, mtimeSec);
};

async function run() {
  const env = await setup();
  try {
    console.log("\n— ① 开着不关的 stdin —");
    {
      const r = await env.run(["说一句", "--no-mcp"], { stdin: "open", ms: 20000 });
      ok(!r.hung, "★命令行给了任务，stdin 开着不关也照跑★ 以前一直挂着，一个字不打", r.err.slice(-500));
      ok(r.code === 0 && /做完了/.test(r.out), "跑完了、答案在 stdout", r.out.slice(-500));
      ok(/3 秒没有内容/.test(r.err), "不等了要说一声", r.err.slice(-300));
    }
    {
      const before = env.bodies.length;
      const r = await env.run(["看看这段", "--no-mcp"], { stdin: { later: "迟到的材料XYZ", ms: 1000 } });
      ok(r.code === 0 && env.bodies.slice(before).some((b) => b.includes("迟到的材料XYZ")), "反向对照：3 秒内来了字，照旧读到头、带给模型", r.err.slice(-300));
    }
    {
      const before = env.bodies.length;
      const r = await env.run(["--no-mcp"], { stdin: "只有管道里的任务QQ" });
      ok(r.code === 0 && env.bodies.slice(before).some((b) => b.includes("只有管道里的任务QQ")), "反向对照：没给任务时管道就是任务", r.err.slice(-300));
    }

    console.log("\n— ② 点名的会话不存在 —");
    const now = Math.floor(Date.now() / 1000);
    seedSession(env.sessDir, "cli_20260925_101010_abc", now - 50, "真会话");
    {
      const before = env.bodies.length;
      const r = await env.run(["--session", "nope_typo", "接着做", "--no-mcp"]);
      ok(r.code === 2 && /没有这个会话：nope_typo/.test(r.err), "★--session 打错：退出码 2、说清楚★", { code: r.code, err: r.err.slice(-300) });
      ok(env.bodies.length === before, "一个请求都没发给模型（没花钱）", env.bodies.length - before);
      ok(!fs.existsSync(path.join(env.sessDir, "nope_typo.json")), "也没悄悄建一个空会话");
    }
    {
      const r = await env.run(["resume", "cli_20260925_101010_ab", "接着做", "--no-mcp"]);
      ok(r.code === 2 && r.err.includes("cli_20260925_101010_abc"), "少粘了一位：把近似的那个 id 报出来", r.err.slice(-300));
    }
    {
      const before = env.bodies.length;
      const r = await env.run(["--session", "cli_20260925_101010_abc", "接着做", "--no-mcp"]);
      ok(r.code === 0 && env.bodies.slice(before).some((b) => b.includes("前文 真会话")), "反向对照：存在的会话照常接上、带着前文", r.err.slice(-300));
    }

    console.log("\n— ③④ 列会话 —");
    for (const f of fs.readdirSync(env.sessDir)) fs.rmSync(path.join(env.sessDir, f));
    const ids = ["cli_20260920_090000_aa1", "s_desk_old", "cli_20260921_090000_aa2", "cli_20260922_090000_aa3", "s_desk_new", "cli_20260923_090000_aa4"];
    ids.forEach((id, i) => seedSession(env.sessDir, id, now - 1000 + i * 100, "标题" + i));
    {
      const r = await env.run(["sessions", "2", "--json"]);
      const rows = jsonLines(r.out);
      ok(r.code === 0 && rows.length === 2 && rows.every((x) => !x.$bad), "★sessions --json 一行一个 JSON★", r.out);
      ok(rows[0].id === "cli_20260923_090000_aa4" && rows[1].id === "s_desk_new", "新的在前", rows.map((x) => x.id));
      ok(rows[1].from === "desktop" && rows[0].from === "cli" && rows[0].turns === 1 && /^\d{4}-\d\d-\d\dT/.test(rows[0].mtime), "字段齐：from / turns / mtime", rows[0]);
      ok(r.reads.length === 2, "★只读了要列的那两个文件★ 以前全读一遍再截", r.reads);
    }
    {
      const r = await env.run(["--list", "--json"]);
      ok(jsonLines(r.out).length === 6, "--list --json 也一样", r.out);
    }
    {
      const r = await env.run(["-c", "接着", "--json", "--no-mcp"]);
      const done = jsonLines(r.out).find((e) => e.type === "done") || {};
      ok(done.session === "cli_20260923_090000_aa4", "-c 接的是最新的命令行会话（不接桌面的）", done);
      const listed = r.reads.filter((f) => f !== "cli_20260923_090000_aa4.json");
      ok(listed.length === 0, "★-c 只读最新那一个★ 以前全读两遍", r.reads);
    }
    {
      const r = await env.run(["engines", "--json"]);
      const rows = jsonLines(r.out);
      ok(r.code === 0 && rows.length >= 1 && rows.every((x) => !x.$bad && typeof x.installed === "boolean"), "★engines --json 一行一个 JSON★", r.out);
      ok(rows.some((x) => x.id === "builtin" && x.current), "当前用的引擎标出来", rows);
    }

    console.log("\n— ⑤ --version / --help —");
    for (const flag of ["--version", "--help"]) {
      const r = await env.run([flag]);
      ok(r.code === 0 && r.out.trim(), `${flag} 照常打印到 stdout`, r.err);
      const heavy = r.loaded.filter((m) => /^(\.\/)?(agent|mcp|llm|tools|account)$|^express$/.test(m));
      ok(!heavy.length, `★${flag} 不加载 agent / express 这些大件★`, heavy);
    }

    console.log("\n— ⑦ 跑到一半被 kill / 关终端 —");
    for (const [sig, code] of [["SIGTERM", 143], ["SIGHUP", 129]]) {
      for (const f of fs.readdirSync(env.sessDir)) fs.rmSync(path.join(env.sessDir, f), { recursive: true, force: true });
      let release;
      env.setHold(new Promise((r) => (release = r)));
      const before = env.bodies.length;
      const r = await env.run(["慢活" + sig, "--no-mcp"], {
        env: { OPENWORKBUDDY_CLI_LIVE: "1" },
        onSpawn: async (kid) => { await until(() => env.bodies.length > before); kid.kill(sig); },
      });
      release();
      env.setHold(null);
      ok(r.code === code && !r.hung, `★${sig}：按信号给退出码 ${code}★ 以前直接被信号带走、什么都不收`, { code: r.code, err: r.err.slice(-300) });
      const files = fs.readdirSync(env.sessDir).filter((f) => f.endsWith(".json"));
      const tr = files.length === 1 ? readSess(path.join(env.sessDir, files[0])).transcript || [] : [];
      ok(tr.some((t) => t.type === "user" && t.text === "慢活" + sig) && tr.some((t) => t.type === "assistant" && JSON.stringify(t.events || []).includes("任务被中断")),
        `★${sig}：这一轮落盘了★ 以前用户那句话连同说到一半的全没了`, { files, tr });
      const meta = files.length === 1 ? readSess(path.join(env.home, "data", "cli-live", files[0])) : {};
      ok(meta.endedAt > 0, `${sig}：网页 / 手机上那条标成结束，不会一直挂着「在跑」`, meta);
    }

    console.log("\n— ⑧ 跑着的时候网页也写了这条会话 —");
    for (const f of fs.readdirSync(env.sessDir)) fs.rmSync(path.join(env.sessDir, f), { recursive: true, force: true });
    const MID = "cli_20260925_121212_mrg";
    const mf = path.join(env.sessDir, MID + ".json");
    seedSession(env.sessDir, MID, now, "合并");
    {
      const r = await env.run(["--session", MID, "先来一句", "--no-mcp"]);
      ok(r.code === 0 && !fs.existsSync(path.join(env.sessDir, ".conflicts")) && !/别处也写过/.test(r.err), "反向对照：没人动过这条，就不另存、不多嘴", r.err.slice(-300));
    }
    {
      let release;
      env.setHold(new Promise((r) => (release = r)));
      const before = env.bodies.length;
      const r = await env.run(["--session", MID, "终端这句TERM", "--no-mcp"], {
        onSpawn: async () => {
          await until(() => env.bodies.length > before);
          // 网页那头这时候跑完了一轮、存了盘
          const disk = readSess(mf);
          disk.transcript.push({ type: "user", text: "网页那句WEB" }, { type: "assistant", events: [{ type: "text", delta: "网页的回答" }] });
          disk.history.push({ role: "user", content: "网页那句WEB" }, { role: "assistant", text: "网页的回答" });
          fs.writeFileSync(mf, JSON.stringify(disk));
          release();
        },
      });
      env.setHold(null);
      const users = (readSess(mf).transcript || []).filter((t) => t.type === "user").map((t) => t.text);
      ok(r.code === 0 && users.includes("网页那句WEB") && users.includes("终端这句TERM") && users.includes("先来一句"),
        "★两边的对话记录都在★ 以前终端存盘整份盖回去，网页那一轮凭空消失", users);
      ok(users.indexOf("网页那句WEB") < users.indexOf("终端这句TERM"), "网页那轮排在前面（它先存的）", users);
      const kept = fs.existsSync(path.join(env.sessDir, ".conflicts")) ? fs.readdirSync(path.join(env.sessDir, ".conflicts")) : [];
      ok(kept.length === 1 && fs.readFileSync(path.join(env.sessDir, ".conflicts", kept[0]), "utf8").includes("网页那句WEB"), "网页那边的上下文另存了一份，没悄悄丢", kept);
      ok(/别处也写过/.test(r.err), "说了一声", r.err.slice(-300));
      const listed = await env.run(["sessions", "--json"]);
      ok(jsonLines(listed.out).length === 1, "另存的那份不会被当成一条会话列出来", listed.out);
    }

    console.log("\n— ⑨ 网页端记着这条正在跑 —");
    {
      const running = path.join(env.home, "data", "running.json");
      fs.writeFileSync(running, JSON.stringify([MID]));
      const r = await env.run(["--session", MID, "再来一句", "--no-mcp"]);
      ok(r.code === 0 && /网页端记着这条会话有任务在跑/.test(r.err), "★开跑前提醒：两头同时跑会互相盖★（只提醒，照跑）", r.err.slice(-300));
      fs.writeFileSync(running, JSON.stringify(["s_别的会话"]));
      const r2 = await env.run(["--session", MID, "又一句", "--no-mcp"]);
      ok(r2.code === 0 && !/网页端记着/.test(r2.err), "反向对照：网页在跑的是别的会话，不提醒", r2.err.slice(-300));
    }

    console.log("\n— ⑩ 项目规范 AGENTS.md —");
    {
      const repo = path.join(env.home, "repo");
      fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
      fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
      fs.writeFileSync(path.join(repo, "AGENTS.md"), "仓库根的规矩 ROOTMARK_R1");
      fs.writeFileSync(path.join(repo, "sub", "AGENTS.md"), "子目录的规矩 SUBMARK_S1");
      fs.writeFileSync(path.join(env.home, "AGENTS.md"), "仓库外面的 OUTSIDE_O1");
      const before = env.bodies.length;
      const r = await env.run(["-C", path.join(repo, "sub"), "看看", "--no-mcp"]);
      const sent = env.bodies.slice(before).join("\n");
      ok(r.code === 0 && sent.includes("SUBMARK_S1"), "★工作目录里的 AGENTS.md 进了发给模型的请求★ 以前命令行一个字都不读", r.err.slice(-300));
      ok(sent.includes("ROOTMARK_R1"), "★往上走到 git 仓库根，根上那份也带上★");
      ok(sent.indexOf("ROOTMARK_R1") < sent.indexOf("SUBMARK_S1"), "  └ 根在前、子目录在后（越靠后越具体）");
      ok(!sent.includes("OUTSIDE_O1"), "  └ 仓库根再往上的不带（那不是这个项目的规矩）");
      const b2 = env.bodies.length;
      const r2 = await env.run(["还是看看", "--no-mcp"]);
      const sent2 = env.bodies.slice(b2).join("\n");
      ok(r2.code === 0 && sent2.length > 0 && !/ROOTMARK_R1|SUBMARK_S1|OUTSIDE_O1/.test(sent2) && !/项目既定规范/.test(sent2),
         "反向对照：工作目录不在仓库里、自己也没放规范，提示词里就没有这一段", r2.err.slice(-300));
    }

    console.log("\n— ⑪ 没人在终端前时要批的一步 —");
    {
      // 模型第一轮要删一个文件（删除保护：要批），看到工具结果就收工
      env.setReply((b) => ((b.messages || []).some((m) => m.role === "tool")
        ? { role: "assistant", content: "收工。" }
        : { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "run_shell", arguments: JSON.stringify({ command: "rm a.txt", purpose: "清理" }) } }] }));
      const victim = path.join(env.ws, "a.txt");
      fs.writeFileSync(victim, "a");
      const b0 = env.bodies.length;
      const r = await env.run(["-C", env.ws, "清理一下", "--no-mcp"], { ms: 60000 });
      ok(!r.hung && r.code === 0 && r.elapsed < 20000, "★没人批就当场拒，不干等两分钟★ 以前 cron 里每碰一条要批的就白卡 120 秒", { elapsed: r.elapsed, hung: r.hung, err: r.err.slice(-400) });
      ok(fs.existsSync(victim), "  └ rm 没跑");
      ok(/直接拒了/.test(r.err) && /rm a\.txt/.test(r.err), "  └ 说清楚哪一步被拒了", r.err.slice(-400));
      ok(/--allow "rm"/.test(r.err) && /--ask-remote/.test(r.err), "  └ 下回怎么放行：给出能直接抄的 --allow，和从手机上批的开关", r.err.slice(-400));
      ok(env.bodies.slice(b0).join("\n").includes("未获批准"), "  └ 模型收到的是「没批准」，接着换办法或者说明卡在哪");
      const rq = await env.run(["-C", env.ws, "清理一下", "--no-mcp", "-q"], { ms: 60000 });
      ok(/直接拒了/.test(rq.err), "★-q 下也说★ 活儿少干了一步不能一声不吭", rq.err.slice(-300));
      const r2 = await env.run(["-C", env.ws, "清理一下", "--no-mcp", "--allow", "rm"], { ms: 60000 });
      ok(r2.code === 0 && !fs.existsSync(victim), "★--allow rm：点名的这一类不用批，真删了★", r2.err.slice(-400));
      ok(/预先放行：rm/.test(r2.err) && !/直接拒了/.test(r2.err), "  └ 开头那行写着放行了什么", r2.err.slice(-400));
      fs.writeFileSync(victim, "a");
      const r2b = await env.run(["-C", env.ws, "清理一下", "--no-mcp", "--allow", "rmdir"], { ms: 60000 });
      ok(fs.existsSync(victim) && /直接拒了/.test(r2b.err), "  └ 按整词比：放行 rmdir 不等于放行 rm", r2b.err.slice(-300));
      const b3 = env.bodies.length;
      const r3 = await env.run(["-C", env.ws, "x", "--no-mcp", "--allow", "danger:force-push"]);
      ok(r3.code === 2 && /git-force-push/.test(r3.err) && env.bodies.length === b3, "★--allow 写错：退出码 2、列出有哪些，一分钱不花★ 写错等于没放行，跑到半夜被拒才发现就晚了", r3.err.slice(-300));
      const r4 = await env.run(["-C", env.ws, "x", "--no-mcp", "--allow", "npm test && rm -rf ."]);
      ok(r4.code === 2 && /拆开/.test(r4.err) && env.bodies.length === b3, "  └ 带 && 的规则永远比不中：当场说", r4.err.slice(-300));
      env.setReply(null);
    }
  } finally {
    env.close();
  }

  console.log("\n— ⑥ --json 下依赖的 console.log —");
  const menv = await setup({ mcp: true });
  try {
    const r = await menv.run(["说一句", "--json"]);
    const bad = jsonLines(r.out).filter((x) => x.$bad);
    ok(r.code === 0 && !bad.length, "★stdout 里全是 JSON★ 以前「[MCP] 已连接」混在第一行", bad);
    ok(/MCP/.test(r.err), "那句改走 stderr，人照样看得见", r.err.slice(-300));
  } finally {
    menv.close();
  }

  console.log(`\ncli-oneshot：通过（${pass} 条）`);
}

module.exports = { run };
if (require.main === module) run().catch((e) => { console.error(e); process.exit(1); });
