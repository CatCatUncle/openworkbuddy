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
    p = WF.parse(JSON.stringify({ name: "  发版前检查 ", description: "跑测试再写说明", steps: [{ name: "test", title: "跑测试", phase: "Build", prompt: "x" }, "y"] }));
    ok(p.name === "发版前检查" && p.description === "跑测试再写说明", "顶层 name / description 给面板顶上用", p);
    ok(p.steps[0].title === "跑测试" && p.steps[0].phase === "Build" && p.steps[1].title === "" && p.steps[1].phase === "", "title / phase 可写可不写", p.steps);
    const long = WF.parse(JSON.stringify({ steps: [{ title: "字".repeat(25), phase: "阶".repeat(21), prompt: "x" }] })).error || "";
    ok(/title.*24/.test(long) && /phase.*20/.test(long), "title、phase 太长直说", long);
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

  console.log("\n【2b】inputs：声明、校验、填值");
  {
    const flow = (inputs, steps) => JSON.stringify({ inputs, steps });
    const IN = [
      { name: "product", label: "产品", required: true },
      { name: "dur", label: "时长", type: "select", options: ["15", "30"], default: "15" },
      { name: "plats", label: "平台", type: "multi", options: ["抖音", "小红书", "B站"], default: ["抖音"] },
    ];
    const p = WF.parse(flow(IN, [{ name: "a", prompt: "做 {{input.product}}，{{ input.dur }} 秒，发 {{input.plats}}" }, "{{input.__json}}\n接着 {{a}}"]));
    ok(!p.error && p.inputs.length === 3, "inputs 认了", p);
    ok(p.inputs[0].type === "text" && p.inputs[0].required === true && p.inputs[1].type === "select" && p.inputs[1].required === false, "type / required 规整好", p.inputs);
    ok(Array.isArray(WF.parse(JSON.stringify({ steps: ["x"] })).inputs) && WF.parse(JSON.stringify({ steps: ["x"] })).inputs.length === 0, "不写 inputs 就是空数组");
    ok(WF.parse(JSON.stringify({ inputs: [{ name: "n", options: ["a"] }], steps: ["x"] })).inputs[0].type === "select", "写了 options 没写 type 当单选");
    ok(WF.refs(p.steps[0].prompt).length === 0, "{{input.x}} 不算步骤引用（refs 不认它）");
    ok(JSON.stringify(WF.inputRefs(p.steps[0].prompt)) === '["product","dur","plats"]', "inputRefs 按出现顺序", WF.inputRefs(p.steps[0].prompt));

    const bad = WF.parse(flow([
      { name: "Bad-name" }, { name: "x" }, { name: "x" }, { name: "s", type: "select" }, { name: "m", type: "multi", options: [] },
      { name: "d", type: "select", options: ["1", "2"], default: "3" }, { name: "md", type: "multi", options: ["a", "b"], default: ["a", "c"] },
      { name: "t", type: "radio" },
    ], ["{{input.ghost}}", "{{input.x}} {{input.__json}}"])).error || "";
    ok(/第 1 项.*Bad-name/.test(bad), "名字不合规（带 - 和大写都不行）", bad);
    ok(/第 3 项.*重了/.test(bad), "重名");
    ok(/第 4 项.*select 要给 options/.test(bad) && /第 5 项.*multi 要给 options/.test(bad), "单选/多选没给 options");
    ok(/第 6 项.*默认值「3」不在 options/.test(bad) && /第 7 项.*默认值「c」不在 options/.test(bad), "默认值不在选项里（单选、多选都查）");
    ok(/第 8 项.*radio/.test(bad), "type 写错");
    ok(/第 1 步用了 \{\{input\.ghost\}\}，inputs 里没有 ghost/.test(bad), "★步骤里用了没声明的 input★", bad);
    ok(!/第 2 步/.test(bad), "（反向对照）声明了的 x、保留的 __json 不报");
    ok(bad.split("\n").length >= 8, "★inputs 的错也一次全列★", bad.split("\n").length);
    const both = WF.parse(JSON.stringify({ inputs: "nope", steps: [{ prompt: "" }] })).error || "";
    ok(/inputs 要写成数组/.test(both) && /没写 prompt/.test(both), "步骤的错和 inputs 的错一起列", both);
    ok(/最多/.test(WF.parse(JSON.stringify({ inputs: Array.from({ length: WF.MAX_INPUTS + 1 }, (_, i) => ({ name: "a" + i })), steps: ["x"] })).error || ""), "inputs 有上限");
    ok(/名字只能/.test(WF.parse(JSON.stringify({ steps: ["{{input.Foo}}"] })).error || ""), "{{input.Foo}} 这种写错的名字也逮到");
    ok(WF.INPUT_RE.test("product_2") && !WF.INPUT_RE.test("a-b") && !WF.INPUT_RE.test("__json"), "INPUT_RE：字母数字和 _，保留名进不来");

    let r = WF.resolveInputs(p.inputs, {});
    ok(JSON.stringify(r.missing) === '["product"]' && r.values.dur === "15" && JSON.stringify(r.values.plats) === '["抖音"]', "★必填没给进 missing，其余补默认★", r);
    r = WF.resolveInputs(p.inputs, { product: "水杯", plats: "B站,抖音" });
    ok(!r.missing.length && !r.errors.length && JSON.stringify(r.values.plats) === '["抖音","B站"]', "多选 a,b：按选项的顺序排", r);
    ok(JSON.stringify(WF.resolveInputs(p.inputs, { product: "x", plats: "小红书、b站" }).values.plats) === '["小红书","B站"]', "多选 a、b 顿号也认，大小写兜一次");
    r = WF.resolveInputs(p.inputs, { product: "x", dur: "45", plats: "快手" });
    ok(r.errors.some((e) => /时长（dur）.*15 \/ 30.*45/.test(e)) && r.errors.some((e) => /平台.*快手/.test(e)), "★选项外的值直说能选什么★", r.errors);
    ok(WF.resolveInputs(p.inputs, { product: "x", dur: "30" }).errors.length === 0, "（反向对照）选项内的值不报");
    ok(/没有叫「zz」/.test(WF.resolveInputs(p.inputs, { product: "x", zz: "1" }).errors.join()), "给了没声明的名字直说");
    ok(/给了 2 次/.test(WF.resolveInputs(p.inputs, { product: ["a", "b"] }).errors.join()), "单值给了两次直说");
    ok(JSON.stringify(WF.resolveInputs(p.inputs, { product: "x", plats: ["抖音", "B站"] }).values.plats) === '["抖音","B站"]', "多选分几次给也合起来");
    ok(WF.resolveInputs(p.inputs, { product: "  " }).missing[0] === "product", "给了空值等于没给");

    const a = WF.inputArgs(["product=a=b", "plats=抖音", "plats=B站", "oops"]);
    ok(a.given.product === "a=b" && JSON.stringify(a.given.plats) === '["抖音","B站"]' && a.errors.length === 1, "inputArgs：值里带 = 照收，同名收成数组，没等号报错", a);

    const vals = WF.resolveInputs(p.inputs, { product: "水杯", plats: "抖音,B站" }).values;
    ok(WF.fillInputs(p.steps[0].prompt, vals) === "做 水杯，15 秒，发 抖音、B站", "多选用顿号连起来", WF.fillInputs(p.steps[0].prompt, vals));
    ok(WF.fillInputs("{{input.product}}|{{input.plats}}", { product: "", plats: [] }) === "（没填）|（没填）", "空的写「（没填）」");
    const js = WF.fillInputs("{{input.__json}}", { product: "多\n行", plats: ["抖音"] });
    ok(!js.includes("\n") && JSON.parse(js).product === "多\n行", "★__json 是一行 JSON★（配方靠 PRESET_RE 认，不许换行）", js);
    ok(WF.fillInputs("{{input.nope}}", vals) === "{{input.nope}}", "没有的名字原样留着");
    const two = WF.fill(WF.fillInputs("{{input.product}} / {{a}}", vals), { a: "上一步说 {{input.product}}" });
    ok(two === "水杯 / 上一步说 {{input.product}}", "★先填 inputs 再贴结果：贴进来的 {{input.x}} 不被填★", two);
    ok(WF.fill("{{input.product}}", { input: "x" }) === "{{input.product}}", "fill 不碰 {{input.x}}");
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

    console.log("\n【3b】inputs 真跑：-i 填值、缺了就停、内置配方");
    const runArgs = (args) => new Promise((resolve) => {
      const kid = spawn(process.execPath, [path.join(ROOT, "cli.js"), ...args, "-C", ws, "--no-mcp"], {
        cwd: home, env: { ...process.env, OPENWORKBUDDY_HOME: home, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let err = "";
      kid.stdout.on("data", () => {});
      kid.stderr.on("data", (b) => (err += b));
      const t = setTimeout(() => kid.kill("SIGKILL"), 60000);
      kid.on("close", (code) => { clearTimeout(t); resolve({ code, err }); });
    });
    const INFLOW = { name: "文案", inputs: [
      { name: "product", label: "产品", required: true },
      { name: "plats", label: "平台", type: "multi", options: ["抖音", "小红书", "B站"], default: ["抖音"] },
    ], steps: [{ name: "a", prompt: "给 {{input.product}} 写标题，发 {{input.plats}}" }, { prompt: "{{input.__json}}\n接着：{{a}}" }] };
    asked.length = 0;
    r = await run(INFLOW, ["-i", "product=智能水杯", "-i", "plats=B站、抖音"]);
    ok(r.code === 0 && asked.length === 2, "带 -i 跑完两步", { code: r.code, err: r.err.slice(-400) });
    ok(/给 智能水杯 写标题，发 抖音、B站/.test((asked[0] || {}).text || ""), "★-i 的值真填进了 prompt★（多选按选项顺序、顿号连）", (asked[0] || {}).text);
    const j = /\{"product":"智能水杯"[^\n]*\}/.exec((asked[1] || {}).text || "");
    ok(!!j && JSON.parse(j[0]).plats.length === 2 && /接着：收到：给 智能水杯/.test(asked[1].text), "{{input.__json}} 是一行 JSON，{{a}} 照样贴", (asked[1] || {}).text);

    asked.length = 0;
    r = await run(INFLOW, []);
    ok(r.code === 2 && asked.length === 0 && /缺 -i product=/.test(r.err) && /一步都没跑/.test(r.err),
      "★必填没给、终端前没人：退出码 2，说清缺哪个 -i★", { code: r.code, err: r.err.slice(-300) });
    r = await run(INFLOW, ["-i", "product=x", "-i", "plats=快手"]);
    ok(r.code === 2 && asked.length === 0 && /快手/.test(r.err) && /抖音 \/ 小红书 \/ B站/.test(r.err), "选项外的值：一步不跑，说能选什么", r.err.slice(-300));
    r = await run(INFLOW, ["-i", "prodcut=x"]);
    ok(r.code === 2 && /没有叫「prodcut」/.test(r.err), "名字拼错了直说", r.err.slice(-300));
    r = await runArgs(["-i", "product=x", "随便问一句"]);
    ok(r.code === 2 && asked.length === 0 && /-i 只配合/.test(r.err), "不是 workflow 却写了 -i：停下，不悄悄丢掉", r.err.slice(-300));

    asked.length = 0;
    r = await runArgs(["workflow", "promo-video", "-i", "product=智能水杯", "-i", "duration=15"]);
    ok(r.code === 0 && asked.length === 3, "★内置配方直接写名字就能跑★ 三步", { code: r.code, n: asked.length, err: r.err.slice(-400) });
    const pre = /【配方表单已填：promo-video】(\{[^\n]*\})/.exec((asked[0] || {}).text || "");
    let preVals = null;
    try { preVals = pre && JSON.parse(pre[1]); } catch {}
    ok(!!preVals && preVals.product === "智能水杯" && preVals.duration === "15" && Array.isArray(preVals.aspects),
      "★表单值一行 JSON 预填进了消息★ 模型那边不用再弹表单", ((asked[0] || {}).text || "").slice(0, 300));
    ok(/【使用技能：promo-video】/.test((asked[0] || {}).text || ""), "技能标记也在");
    asked.length = 0;
    r = await runArgs(["workflow", "promo-video", "-i", "product=x", "-i", "cover=html"]);
    ok(r.code === 2 && asked.length === 0 && /截不了图/.test(r.err), "★命令行用不了的选项直说为什么，不悄悄换一个★", r.err.slice(-300));
    r = await runArgs(["workflow", "promo-video"]);
    ok(r.code === 2 && asked.length === 0 && /缺 -i product=/.test(r.err), "配方的必填项没给也停", r.err.slice(-300));
    r = await runArgs(["workflow", "promo-vidoe"]);
    ok(r.code === 2 && /读不了/.test(r.err) && /promo-video/.test(r.err), "配方名写错：读不了，并列出有哪些配方", r.err.slice(-300));

    // 终端前有人：当场问。「有没有人」看 stdin 是不是终端，管道冒充不了，得真开一个 pty
    const { BRIDGE, havePty } = require("./lib/pty");
    const ttyRun = (keys) => new Promise((resolve) => {
      const f = path.join(home, "flow-tty.json");
      fs.writeFileSync(f, JSON.stringify(INFLOW));
      const kid = spawn("python3", ["-c", BRIDGE, process.execPath, path.join(ROOT, "cli.js"), "workflow", f, "-C", ws, "--no-mcp"], {
        cwd: home, env: { ...process.env, OPENWORKBUDDY_HOME: home, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "", k = 0;
      kid.stdout.on("data", (b) => {
        out += b;
        // 每看到一次提示符就按下一个键：第一次回车空着，看它会不会再问
        const seen = out.split("产品（product）：").length - 1;
        while (k < keys.length && k < seen) kid.stdin.write(keys[k++]);
      });
      kid.stderr.on("data", (b) => (out += b));
      const t = setTimeout(() => kid.kill("SIGTERM"), 60000);
      kid.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
    });
    if (!havePty()) console.log("  （跳过 pty 那两条：这台机器没有 python3 的 pty）");
    else {
      asked.length = 0;
      r = await ttyRun(["\r", "电动牙刷\r"]);
      ok(r.code === 0 && /要填/.test(r.out) && /给 电动牙刷 写标题/.test((asked[0] || {}).text || ""),
        "★终端前有人：当场问必填项，空着回车会再问一次★", { code: r.code, out: r.out.slice(-400) });
      asked.length = 0;
      r = await ttyRun(["\x04"]);
      ok(r.code === 2 && asked.length === 0 && /没填产品/.test(r.out), "（反向对照）Ctrl+D 不答：一步不跑，退出码 2", { code: r.code, out: r.out.slice(-300) });
    }

    llm.close();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${fail ? "挂了" : "全部通过"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
