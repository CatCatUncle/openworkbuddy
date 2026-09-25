"use strict";
/**
 * 终端里一次工具调用的样子：「● Shell(npm test)」+ 下面挂「└ 输出」，跟 Claude Code / Codex 一个读法。
 *
 * 钉三件事：
 *   1. 看得见**跑了哪条命令、动了哪个文件**，不是只看见一个工具名
 *   2. 输出露头几行、剩下的说还有多少——不刷屏，也不假装没了
 *   3. 一行都不超过给的宽度（中文按两列算），折行会把缩进搅乱
 */
const assert = require("assert");
const tv = require("../cli-toolview");
const { cols } = require("../text-width");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

/**
 * 真起一趟 openworkbuddy，模型是本地假的：按轮次吐 calls[i] 里的工具调用，吐完说一句收工。
 * calls[i] 也可以是 { text, tools }：这一轮先说一段话再调工具（tools 省掉就是只说话、收尾）。
 * 默认只回 stderr（进度和工具行都在那儿）；withOut 为真时回 { err, out }，out 是正文
 */
async function cliRun(calls, withOut) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-toolview-"));
  const ws = path.join(home, "ws");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "a.txt"), "hello\nworld\n");
  let n = 0;
  const llm = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const step = calls[n++];
      const call = Array.isArray(step) ? step : step && step.tools;
      const message = call
        ? { role: "assistant", content: (step && step.text) || "", tool_calls: call.map(([name, args], i) => ({ id: `c${n}_${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) }
        : { role: "assistant", content: (step && step.text) || "收工。" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    });
  });
  await new Promise((r) => llm.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${llm.address().port}/v1`;
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.example.json"), "utf8"));
  cfg.provider = "openai";
  cfg.openai = { base_url: base, api_key: "k", model: "mock", stream: false };
  cfg.models = [{ name: "假模型", provider: "openai", base_url: base, api_key: "k", model: "mock", stream: false }];
  cfg.active_model = "假模型";
  cfg.agent = { ...(cfg.agent || {}), max_steps: 8, llm_retries: 0 };
  cfg.mcp_servers = [];
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg));
  try {
    return await new Promise((resolve, reject) => {
      const kid = spawn(process.execPath, [path.join(__dirname, "..", "cli.js"), "干活", "-C", ws, "--no-mcp"], {
        env: { ...process.env, OPENWORKBUDDY_HOME: home, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let err = "", out = "";
      kid.stderr.on("data", (d) => (err += d));
      kid.stdout.on("data", (d) => (out += d));
      const t = setTimeout(() => { kid.kill(); reject(new Error("跑了 60 秒没完：\n" + err)); }, 60000);
      kid.on("close", () => { clearTimeout(t); resolve(withOut ? { err, out } : err); });
    });
  } finally {
    llm.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function run() {
  // ---- ① 调用那一行 ----
  assert.strictEqual(tv.callLine({ name: "run_shell", input_preview: "npm test" }), "● Shell(npm test)");
  assert.strictEqual(tv.callLine({ name: "run_shell", input_preview: "\n  cd a\nnpm test\n" }), "● Shell(cd a …)", "多行脚本只露第一行，后面标 …");
  assert.strictEqual(tv.callLine({ name: "edit_file", input_preview: JSON.stringify({ path: "src/app.js", old_text: "a", new_text: "b" }) }), "● Edit(src/app.js)", "★改文件看得见改的是哪个★");
  assert.strictEqual(tv.callLine({ name: "search_files", input_preview: JSON.stringify({ query: "  hello\n world " }) }), "● Search(hello world)", "空白压成一格");
  assert.strictEqual(tv.callLine({ name: "fetch_url", input_preview: '{"url":"https://example.com/a very long' , purpose: "看官网" }), "● Fetch(看官网)", "半截 JSON 解析不了就退回 purpose");
  assert.strictEqual(tv.callLine({ name: "mcp__x__y", input_preview: "{}" }), "● mcp__x__y", "没列的照原名，没对象就不带括号");
  assert.strictEqual(tv.callLine({ name: "read_file", expert: "测试员", input_preview: '{"path":"a.txt"}' }), "● 测试员 · Read(a.txt)", "专家调的要看得出是谁");
  const painted = tv.callLine({ name: "run_shell", input_preview: "ls" }, { paint: (s, k) => `<${k}>${s}` });
  assert.strictEqual(painted, "<bullet>● <name>Shell<arg>(ls)");
  for (const w of [30, 50, 80]) {
    const l = tv.callLine({ name: "run_shell", input_preview: "echo " + "很长的中文参数".repeat(30) }, { width: w });
    assert.ok(cols(l) <= w, `宽 ${w}：调用行 ${cols(l)} 列，超了`);
    assert.ok(l.endsWith("…)"), "截掉的要标出来");
  }

  // ---- ② 命令的输出 ----
  assert.deepStrictEqual(tv.splitShell("stdout:\nhi\nthere\nstderr:\noops\nexit code: 0"), { out: "hi\nthere", err: "oops", code: "0", note: "" });
  assert.strictEqual(tv.splitShell("读了 3 行"), null, "不是命令输出的格式就别硬拆");
  assert.deepStrictEqual(tv.resultLines({ name: "run_shell", preview: "stdout:\nhi\nexit code: 0" }), ["  └ hi"]);
  assert.deepStrictEqual(tv.resultLines({ name: "run_shell", preview: "exit code: 0" }), ["  └ （没有输出）"]);
  assert.deepStrictEqual(tv.resultLines({ name: "run_shell", isError: true, preview: "stderr:\nboom\nexit code: 2" }), ["  └ exit code 2", "    boom"], "★退出码非 0 放第一行★");
  const stopped = tv.resultLines({ name: "run_shell", isError: true, preview: "stdout:\npart\n(用户已停止任务，脚本被终止)\nexit code: null" });
  assert.strictEqual(stopped.filter((l) => l.includes("用户已停止")).length, 1, "停止说明只出现一次：" + JSON.stringify(stopped));
  const many = tv.resultLines({ name: "run_shell", preview: "stdout:\n" + "1\n2\n3\n4\n5\n6\n7" + "\nexit code: 0" });
  assert.deepStrictEqual(many, ["  └ 1", "    2", "    3", "    4", "    … 还有 3 行"], "露头 4 行，剩下的说数");
  const cut = tv.resultLines({ name: "run_shell", preview: ("x\n".repeat(400)).slice(0, 800) });
  assert.ok(/还有 \d+\+ 行/.test(cut[cut.length - 1]) || /后面还有/.test(cut[cut.length - 1]), "preview 截在 800 字，得说后面可能还有");

  // ---- ③ 别的工具 ----
  assert.deepStrictEqual(tv.resultLines({ name: "read_file", outcome: "3 行", preview: "hello\nworld\n" }), ["  └ 3 行"], "读文件只报一句，不把全文刷上屏");
  assert.deepStrictEqual(tv.resultLines({ name: "edit_file", isError: true, preview: "工具执行出错: 文件不存在：nope.txt" }), ["  └ 文件不存在：nope.txt"], "出错前缀剥掉，只说哪儿错了");
  const hits = tv.resultLines({ name: "search_files", outcome: "2 处", preview: "a.js:1: x\n\nb.js:9: y\n" });
  assert.deepStrictEqual(hits, ["  └ 2 处", "    a.js:1: x", "    b.js:9: y"], "搜索露几条命中");
  assert.deepStrictEqual(tv.resultLines({ name: "write_file", preview: "" }), ["  └ 完成"]);
  assert.deepStrictEqual(tv.resultLines({ name: "run_shell", isError: true, preview: "x" }, { paint: (s, k) => `<${k}>${s}` }), ["  └ <err>x"], "出错整段标红");
  for (const w of [30, 60]) {
    for (const l of tv.resultLines({ name: "run_shell", preview: "stdout:\n" + "输出很长的一行".repeat(40) + "\nexit code: 0" }, { width: w })) {
      assert.ok(cols(l) <= w, `宽 ${w}：结果行 ${cols(l)} 列，超了`);
    }
  }

  // ---- ④ 真跑一趟：终端上确实是这个样子 ----
  {
    const err = await cliRun([
      [["run_shell", { command: "echo 你好; echo second", purpose: "打个招呼" }]],
      [["read_file", { path: "a.txt" }], ["search_files", { query: "hello" }]],
    ]);
    const lines = err.split("\n");
    const at = lines.indexOf("● Shell(echo 你好; echo second)");
    assert.ok(at >= 0, "★看得见跑的是哪条命令★\n" + err);
    assert.deepStrictEqual(lines.slice(at + 1, at + 3), ["  └ 你好", "    second"], "输出紧挨着挂在命令下面\n" + err);
    assert.ok(!/▸ run_shell/.test(err), "旧的「▸ 工具名（目的）」那种不要了");
    // 两个只读工具并发：两行 ● 先印，结果回来时 └ 前面不是自己 → 把自己那行再印一遍
    const reads = lines.map((l, i) => [l, i]).filter(([l]) => l === "● Read(a.txt)");
    assert.strictEqual(reads.length, 2, "★并发时结果前把自己那行再印一遍★ └ 不许挂在别人的调用下面\n" + err);
    assert.ok(/^  └ /.test(lines[reads[1][1] + 1]), "再印的那行下面紧跟自己的结果");
    const search = lines.lastIndexOf("● Search(hello)");
    assert.ok(search > reads[1][1] && /^  └ /.test(lines[search + 1]), "Search 的结果也挂在自己下面\n" + err);
  }

  // ---- ⑤ 本机引擎报上来的：Claude Code 的 Bash、Codex 的命令，没有 exit code 那行也照样露几行 ----
  assert.strictEqual(tv.callLine({ name: "Bash", input_preview: JSON.stringify({ command: "npm test" }) }), "● Shell(npm test)", "Claude Code 的 Bash 跟自带的 run_shell 一个样子");
  assert.strictEqual(tv.callLine({ name: "ask_user", input_preview: JSON.stringify({ question: "用什么格式？" }) }), "● Ask(用什么格式？)", "提问那行叫 Ask，括号里是题目");
  {
    const raw = "> test\n> node t.js\n  38 passing\n  2 failing\n  1) boom\n  2) bang";
    assert.deepStrictEqual(tv.resultLines({ name: "Bash", preview: raw, lines: 6 }),
      ["  └ > test", "    > node t.js", "      38 passing", "      2 failing", "    … 还有 2 行"], "★命令输出露头几行★ 以前只剩第一行 > test，38 passing / 2 failing 看不见");
    assert.deepStrictEqual(tv.resultLines({ name: "run_shell", preview: "a\nb\nc" }), ["  └ a", "    b", "    c"], "Codex 的命令输出没有 exit code 那行，也不能只留第一行");
    const big = tv.resultLines({ name: "Bash", preview: "x\n".repeat(400).slice(0, 800), cut: true, lines: 2000 });
    assert.strictEqual(big[big.length - 1], "    … 还有 1996 行", "引擎报了一共几行：说准数，不带 +");
    const unknown = tv.resultLines({ name: "Bash", preview: "a\nb", cut: true });
    assert.strictEqual(unknown[unknown.length - 1], "    … 后面还有", "截了但不知道一共几行：说后面还有");
    assert.deepStrictEqual(tv.resultLines({ name: "Bash", preview: "\n" }), ["  └ （没有输出）"]);
  }

  // ---- ⑥ 无人值守时的提问：没有单子可弹，「● Ask(题目)」只印一次，下面挂回答 ----
  {
    const err = await cliRun([[["ask_user", { question: "用什么格式？", options: ["表格", "列表"] }]]]);
    const asks = err.split("\n").filter((l) => l.startsWith("● Ask("));
    assert.deepStrictEqual(asks, ["● Ask(用什么格式？)"], "★题目只印一次★ 工具开始时先不印，结果回来时补这一行\n" + err);
    const lines = err.split("\n");
    assert.ok(/^  └ /.test(lines[lines.indexOf(asks[0]) + 1]), "下面紧跟着结果\n" + err);
  }

  console.log("cli-toolview：通过");
}

module.exports = { run };
if (require.main === module) run().catch((e) => { console.error(e); process.exit(1); });
