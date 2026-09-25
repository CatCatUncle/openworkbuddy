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
  const llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "做完了。" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
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
    /** 起一趟 cli.js。stdin：ignore（不接）/ open（开着不关）/ 字符串（写完就关）/ { later, ms }（隔 ms 毫秒才写） */
    run(args, { stdin = "ignore", ms = 30000 } = {}) {
      const hookOut = path.join(home, `hook-${Math.random().toString(36).slice(2)}.json`);
      return new Promise((resolve) => {
        const t0 = Date.now();
        const kid = spawn(process.execPath, ["--require", hook, CLI, ...args], {
          env: { ...process.env, OPENWORKBUDDY_HOME: home, NO_COLOR: "1", OWB_HOOK_OUT: hookOut },
          stdio: [stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
          cwd: ws,
        });
        let out = "", err = "", hung = false;
        kid.stdout.on("data", (d) => (out += d));
        kid.stderr.on("data", (d) => (err += d));
        if (typeof stdin === "string" && stdin !== "open" && stdin !== "ignore") kid.stdin.end(stdin);
        if (stdin && typeof stdin === "object") setTimeout(() => kid.stdin.end(stdin.later), stdin.ms);
        const t = setTimeout(() => { hung = true; kid.kill("SIGKILL"); }, ms);
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
