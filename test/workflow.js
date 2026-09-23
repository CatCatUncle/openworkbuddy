"use strict";
/**
 * openworkbuddy workflow <文件.json>：
 *   - 文件写错的地方一次全列出来，一步都不跑
 *   - {{名字}} 只能指前面的步骤，贴进去的是那一步的最终回复，不会二次展开
 *   - 真跑一遍（真 cli.js + 假模型）：按顺序跑、{{plan}} 真贴进了下一步、没写 mode 的跟 -m 走、
 *     一步失败后面就停、continue_on_error 的那步失败了照跑
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const WF = require(path.join(ROOT, "workflow"));

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m + (extra !== undefined ? "  ← " + JSON.stringify(extra).slice(0, 400) : "")); } };

(async () => {
  console.log("\n【1】读文件");
  {
    let p = WF.parse(JSON.stringify({ steps: [{ name: "plan", mode: "plan", prompt: "想方案" }, { prompt: "照做：{{plan}}" }, "审一下"] }));
    ok(!p.error && p.steps.length === 3, "三步都认", p);
    ok(p.steps[1].name === "step2" && p.steps[2].prompt === "审一下", "没写名字的按位置起名；一句话也算一步");
    ok(p.steps[0].mode === "plan" && p.steps[1].mode === null, "写了 mode 的照写，没写的留空（跟 -m 走）");
    ok(!WF.parse(JSON.stringify(["a", "b"])).error, "直接给数组也认");
    ok(/JSON/.test(WF.parse("{oops").error), "JSON 坏了直说");
    ok(/steps/.test(WF.parse("{}").error), "没有 steps 直说");
    ok(/空/.test(WF.parse('{"steps":[]}').error), "空 steps 直说");
    const bad = WF.parse(JSON.stringify({ steps: [
      { name: "A b", prompt: "x" }, { prompt: "" }, { name: "x", mode: "fly", prompt: "y" },
      { name: "x", prompt: "z" }, { prompt: "{{later}} {{nope}}" }, { name: "later", prompt: "{{later}}" },
    ] })).error || "";
    ok(/第 1 步.*名字/.test(bad), "名字不合规", bad);
    ok(/第 2 步.*没写 prompt/.test(bad), "没写 prompt");
    ok(/第 3 步.*mode「fly」/.test(bad) && /craft/.test(bad), "mode 写错了，并列出能写哪些");
    ok(/第 4 步.*重了/.test(bad), "重名");
    ok(/第 5 步.*\{\{later\}\}.*还没结果/.test(bad) && /第 5 步.*\{\{nope\}\}.*没有这一步/.test(bad), "指后面的、指不存在的都说");
    ok(/第 6 步.*\{\{later\}\}.*自己/.test(bad), "指自己的也说");
    ok(bad.split("\n").length >= 7, "★错处一次全列出来★ 不让人改一条跑一次", bad.split("\n").length);
    ok(/最多/.test(WF.parse(JSON.stringify({ steps: Array(WF.MAX_STEPS + 1).fill("x") })).error), "步数有上限");
  }

  console.log("\n【2】填模板");
  {
    ok(WF.fill("照做：{{plan}}", { plan: "先 A 再 B" }) === "照做：先 A 再 B", "贴进去了");
    ok(WF.fill("{{ plan }}", { plan: "x" }) === "x", "花括号里带空格也认");
    ok(WF.fill("{{plan}}", { plan: "里面有 {{plan}} 和 $1" }) === "里面有 {{plan}} 和 $1", "★贴进来的内容不二次展开★");
    ok(/没有文字回复/.test(WF.fill("{{plan}}", { plan: "" })), "那一步没说话：写明白，不留空");
    ok(WF.fill("{{other}}", { plan: "x" }) === "{{other}}", "没有结果的名字原样留着");
    const long = WF.fill("{{plan}}", { plan: "字".repeat(WF.PASTE_MAX + 10) });
    ok(long.length < WF.PASTE_MAX + 100 && /没贴进来/.test(long), "太长截断并说明");
  }

  console.log("\n【3】真跑一遍：真 cli.js + 假模型");
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-wf-"));
    const ws = path.join(home, "ws");
    fs.mkdirSync(ws);
    const asked = []; // 每一问最后那条用户消息
    const llm = http.createServer((req, res) => {
      let raw = ""; req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (!req.url.includes("/chat/completions")) { res.writeHead(404); return res.end("{}"); }
        let body = {}; try { body = JSON.parse(raw); } catch {}
        const users = (body.messages || []).filter((m) => m.role === "user");
        const last = users.length ? users[users.length - 1] : {};
        const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content || "");
        asked.push({ text, tools: (body.tools || []).map((t) => (t.function || t).name) });
        if (/请失败/.test(text)) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "bad request（测试故意的）" } })); }
        const reply = /想方案/.test(text) ? "方案：先加 export.js 再接按钮" : "收到：" + text.slice(0, 60);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3 } }));
      });
    });
    await new Promise((r) => llm.listen(0, "127.0.0.1", r));
    const port = llm.address().port;
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
    cfg.provider = "openai";
    cfg.openai = { base_url: `http://127.0.0.1:${port}/v1`, api_key: "k", model: "mock", stream: false };
    cfg.models = [{ name: "假模型", provider: "openai", base_url: `http://127.0.0.1:${port}/v1`, api_key: "k", model: "mock", stream: false }];
    cfg.active_model = "假模型";
    cfg.agent = { ...(cfg.agent || {}), max_steps: 4, tool_timeout_ms: 8000, llm_timeout_ms: 20000, llm_retries: 0 };
    cfg.mcp_servers = [];
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg, null, 2));

    const run = (flow, extra = []) => new Promise((resolve) => {
      const f = path.join(home, "flow-" + Math.random().toString(36).slice(2, 7) + ".json");
      fs.writeFileSync(f, typeof flow === "string" ? flow : JSON.stringify(flow));
      const kid = spawn(process.execPath, [path.join(ROOT, "cli.js"), "workflow", f, "-C", ws, "--no-mcp", ...extra], {
        env: { ...process.env, OPENWORKBUDDY_HOME: home, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "", err = "";
      kid.stdout.on("data", (b) => (out += b));
      kid.stderr.on("data", (b) => (err += b));
      const t = setTimeout(() => kid.kill("SIGKILL"), 60000);
      kid.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
    });

    asked.length = 0;
    let r = await run({ steps: [{ name: "plan", mode: "ask", prompt: "想方案" }, { name: "build", prompt: "照这个做：{{plan}}" }, { prompt: "第三步" }] });
    ok(r.code === 0, "三步跑完退出码 0", { code: r.code, err: r.err.slice(-600) });
    ok(asked.length === 3, "一步一问，按顺序", asked.map((a) => a.text.slice(0, 30)));
    ok(/照这个做：方案：先加 export\.js 再接按钮/.test((asked[1] || {}).text || ""), "★{{plan}} 真贴进了第二步★", (asked[1] || {}).text);
    ok(!((asked[0] || {}).tools || []).includes("write_file") && ((asked[1] || {}).tools || []).includes("write_file"),
      "第一步 mode=ask 手里没有写文件的工具，第二步没写 mode 走默认 craft 有", asked.map((a) => a.tools.length));
    ok(/1\/3/.test(r.err) && /3\/3/.test(r.err), "每一步都标了第几步", r.err.slice(0, 400));

    asked.length = 0;
    r = await run({ steps: [{ prompt: "请失败" }, { prompt: "不该跑到这" }] });
    ok(r.code === 1 && asked.length === 1, "★一步失败后面就停★ 退出码 1", { code: r.code, n: asked.length });
    ok(/后面 1 步不跑了/.test(r.err), "停下时说清楚", r.err.slice(-400));

    asked.length = 0;
    r = await run({ steps: [{ prompt: "请失败", continue_on_error: true }, { prompt: "照样跑" }] });
    ok(asked.length === 2 && r.code === 1, "continue_on_error：失败了后面照跑，退出码仍如实是 1", { code: r.code, n: asked.length });

    asked.length = 0;
    r = await run({ steps: [{ prompt: "{{nope}}" }] });
    ok(r.code === 2 && asked.length === 0 && /一步都没跑/.test(r.err), "文件有错：一步都不跑，退出码 2", { code: r.code, err: r.err.slice(-300) });
    r = await new Promise((resolve) => {
      const kid = spawn(process.execPath, [path.join(ROOT, "cli.js"), "workflow", path.join(home, "没有这个.json"), "--no-mcp"], { env: { ...process.env, OPENWORKBUDDY_HOME: home, NO_COLOR: "1" } });
      let err = ""; kid.stderr.on("data", (b) => (err += b)); kid.on("close", (code) => resolve({ code, err }));
    });
    ok(r.code === 2 && /读不了/.test(r.err), "文件不存在：直说，退出码 2", r);

    llm.close();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${fail ? "挂了" : "全部通过"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
