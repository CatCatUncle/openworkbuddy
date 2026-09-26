"use strict";
/**
 * 钩子（config.json 的 agent.hooks）：
 *   - 配置写错的那条不生效且说清为什么，别的照常
 *   - before_shell 不是 0 就拦，命令真没跑；没匹配上的不拦
 *   - after_edit 的输出接在改动回执后面；文件名走环境变量，文件名里的 `;` 不会变成第二条命令
 *   - 超时会掐掉，任务停了钩子一起停
 *   - done 没过就打回去接着改，过了才收尾；只读任务、没改过文件的任务不跑
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
// 要赶在 require tools 之前：开发态数据目录就是仓库根，run_shell 的审计（security.js）
// 会落进用户正在用的 data/audit.json，里面就多出「touch ran.txt」这类测试命令
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-hooks-home-"));
process.env.OPENWORKBUDDY_HOME = HOME;
process.env.OPENWORKBUDDY_DATA_DIR = path.join(HOME, "data");
const HK = require(path.join(ROOT, "hooks"));
const tools = require(path.join(ROOT, "tools"));
const { executeTool } = tools;

let pass = 0, fail = 0, finished = false;
process.on("exit", (code) => {
  // 放在 exit 里收：审计是 500ms 防抖写盘，在 finally 里删早了会被它再建出来
  if (code === 0 && finished) { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {} }
  else console.log("留着现场（数据目录）：" + HOME);
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`);
  process.exitCode = 1;
});
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m + (extra !== undefined ? "  ← " + JSON.stringify(extra).slice(0, 300) : "")); } };

(async () => {
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), "owb-hooks-"));
  tools.setWorkspaceDir(WS);

  console.log("\n【1】配置");
  {
    const n = HK.normalize({
      after_edit: [{ match: "\\.js$", run: "echo x" }, { run: "" }, { match: "([", run: "echo y" }],
      before_shell: "echo z",
      done: [{ run: "true", timeout: 99999 }],
      on_start: [{ run: "echo nope" }],
    });
    ok(n.after_edit.length === 1 && n.after_edit[0].match.test("a.js"), "合规那条生效，match 编成了正则");
    ok(n.before_shell.length === 1 && n.before_shell[0].run === "echo z", "只写一个字符串也认");
    ok(n.done[0].timeout === HK.MAX_TIMEOUT, "超时封顶", n.done[0].timeout);
    ok(n.problems.some((p) => /没写 run/.test(p)), "没写 run 的说了");
    ok(n.problems.some((p) => /不是合法的正则/.test(p)), "正则写坏的说了");
    ok(n.problems.some((p) => /on_start.*不认识/.test(p)), "不认识的节点说了");
    ok(HK.normalize(undefined).done.length === 0 && HK.normalize(null).problems.length === 0, "没配：空的，不抛");
    ok(HK.pick(n.after_edit, "a.py").length === 0 && HK.pick(n.after_edit, "a.js").length === 1, "match 只挑对得上的");
  }

  console.log("\n【2】跑一条");
  {
    let r = await HK.runOne({ run: "echo hi; exit 3", timeout: 10 }, { cwd: WS });
    ok(r.code === 3 && /hi/.test(r.out), "退出码和输出都拿到了", r);
    const t0 = Date.now();
    r = await HK.runOne({ run: "sleep 5", timeout: 1 }, { cwd: WS });
    ok(r.timedOut && Date.now() - t0 < 3000, "超时就掐，不干等", { r, ms: Date.now() - t0 });
    await HK.runOne({ run: "sleep 1.5; touch late.txt", timeout: 1 }, { cwd: WS });
    await new Promise((res) => setTimeout(res, 1500));
    ok(!fs.existsSync(path.join(WS, "late.txt")), "超时是真杀掉了，不是不等它、让它在后台接着跑");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const t1 = Date.now();
    r = await HK.runOne({ run: "sleep 5", timeout: 30 }, { cwd: WS, stopSignal: ac.signal });
    ok(r.code === null && Date.now() - t1 < 3000, "任务停了钩子一起停", { r, ms: Date.now() - t1 });
    r = await HK.runOne({ run: "pwd", timeout: 10 }, { cwd: WS });
    ok(fs.realpathSync(r.out.trim()) === fs.realpathSync(WS), "在工作目录里跑", r.out);
    r = await HK.runOne({ run: "yes 0123456789 | head -c 200000", timeout: 10 }, { cwd: WS });
    ok(r.out.length <= HK.OUT_MAX + 100 && /省略/.test(r.out), "输出太长只留头尾", r.out.length);
  }

  console.log("\n【3】before_shell 拦命令");
  {
    const hooks = HK.normalize({ before_shell: [{ match: "^git push", run: "echo 推送要人来做; exit 1" }] });
    const opts = { hooks, security: { permission_mode: "full" } };
    const r = await executeTool("run_shell", { command: "git push origin main; touch pushed.txt" }, opts);
    ok(r.isError && /before_shell/.test(r.content) && /推送要人来做/.test(r.content), "拦下了，钩子的话交给了它", r.content);
    ok(!fs.existsSync(path.join(WS, "pushed.txt")), "被拦的命令真没跑");
    const r2 = await executeTool("run_shell", { command: "touch ran.txt" }, opts);
    ok(!r2.isError && fs.existsSync(path.join(WS, "ran.txt")), "对不上 match 的照常跑（反向对照）", r2.content);
    const seen = HK.normalize({ before_shell: [{ run: "printf %s \"$OWB_COMMAND\" > cmd.txt" }] });
    await executeTool("run_shell", { command: "echo 你好" }, { hooks: seen, security: { permission_mode: "full" } });
    ok(fs.readFileSync(path.join(WS, "cmd.txt"), "utf8") === "echo 你好", "钩子从 OWB_COMMAND 拿到了原命令");
  }

  console.log("\n【4】after_edit 接在回执后面");
  {
    const hooks = HK.normalize({ after_edit: [{ match: "\\.txt$", run: "printf 'saw:%s' \"$OWB_FILE\"" }] });
    const r = await executeTool("write_file", { path: "a.txt", content: "hi" }, { hooks, security: { permission_mode: "full" } });
    ok(!r.isError && /after_edit/.test(r.content) && (r.content.includes("saw:" + path.join(fs.realpathSync(WS), "a.txt")) || r.content.includes("saw:" + path.join(WS, "a.txt"))), "钩子拿到了绝对路径，输出接进了回执", r.content);
    const r2 = await executeTool("write_file", { path: "b.md", content: "hi" }, { hooks, security: { permission_mode: "full" } });
    ok(!/after_edit/.test(r2.content), "对不上 match 的不跑（反向对照）", r2.content);
    const evil = HK.normalize({ after_edit: [{ run: "echo \"$OWB_FILE\" > /dev/null" }] });
    await executeTool("write_file", { path: "x;touch pwned.txt;.txt", content: "hi" }, { hooks: evil, security: { permission_mode: "full" } });
    ok(!fs.existsSync(path.join(WS, "pwned.txt")), "文件名里的 ; 没变成第二条命令");
    const bad = HK.normalize({ after_edit: [{ run: "echo lint 挂了 >&2; exit 1" }] });
    const r3 = await executeTool("edit_file", { path: "a.txt", old_text: "hi", new_text: "hello" }, { hooks: bad, security: { permission_mode: "full" } });
    ok(/改动已经写进去了/.test(r3.content) && /lint 挂了/.test(r3.content), "钩子失败：说清改动已写入，并把报错交给它", r3.content);
    ok(fs.readFileSync(path.join(WS, "a.txt"), "utf8") === "hello", "钩子失败不撤销改动");
    const r4 = await executeTool("write_file", { path: "c.txt", content: "hi" }, { security: { permission_mode: "full" } });
    ok(!/after_edit/.test(r4.content), "没配钩子：回执一个字不多（反向对照）");

    // 格式化钩子（prettier --write 那种）把刚写的文件又改写一遍：那是自己这边的改动，下一次改不能当成「别人改过」拦下来
    const fmt = HK.normalize({ after_edit: [{ match: "\\.js$", run: "perl -pi -e 's/\\t/  /g' \"$OWB_FILE\"" }] });
    const o = { hooks: fmt, sessionId: "s-fmt", security: { permission_mode: "full" } };
    const w5 = await executeTool("write_file", { path: "f.js", content: "function f() {\n\treturn 1;\n}\n" }, o);
    ok(!w5.isError && fs.readFileSync(path.join(WS, "f.js"), "utf8") === "function f() {\n  return 1;\n}\n" && /钩子改写了这个文件/.test(w5.content),
      "钩子真把文件改写了，回执里说了", w5.content);
    const e5 = await executeTool("edit_file", { path: "f.js", old_text: "  return 1;", new_text: "  return 2;" }, o);
    ok(!e5.isError && fs.readFileSync(path.join(WS, "f.js"), "utf8") === "function f() {\n  return 2;\n}\n", "★写完被格式化钩子改写，紧接着 edit_file 不被当成别人改过拦下★", e5.content);
    const m5 = await executeTool("multi_edit", { path: "f.js", edits: [{ old_text: "return 2;", new_text: "return 3;\n\treturn 4;" }] }, o);
    const e6 = await executeTool("edit_file", { path: "f.js", old_text: "  return 4;", new_text: "  return 5;" }, o);
    ok(!m5.isError && !e6.isError && /return 5;/.test(fs.readFileSync(path.join(WS, "f.js"), "utf8")), "multi_edit 之后同样不拦", [m5.content, e6.content]);
    await new Promise((res) => setTimeout(res, 20));
    fs.writeFileSync(path.join(WS, "f.js"), "function f() {\n  return 5;\n}\n// 别人加的\n");
    const e7 = await executeTool("edit_file", { path: "f.js", old_text: "  return 5;", new_text: "  return 6;" }, o);
    ok(e7.isError && /内容变了/.test(e7.content), "工具之外真有人改了它：照样拦（反向对照）", e7.content);
    const noop = HK.normalize({ after_edit: [{ match: "\\.js$", run: "true" }] });
    const w8 = await executeTool("write_file", { path: "g.js", content: "let a = 1;\n" }, { ...o, hooks: noop });
    ok(!/钩子改写了/.test(w8.content), "钩子没动文件：不说改写（反向对照）", w8.content);
  }

  console.log("\n【5】done：没过不许收尾");
  {
    const { createAgentRuntime } = require(path.join(ROOT, "agent"));
    const { McpManager } = require(path.join(ROOT, "mcp"));
    const run = async (script, hooks, mode) => {
      let step = 0;
      const seen = [];
      const llm = {
        provider: "mock", model: "scripted",
        async chat(args) {
          const h = (args && (args.messages || args.history)) || [];
          seen.push(JSON.stringify(h).slice(-800));
          const s = script[step++] || { text: "完了。" };
          return { text: s.text || "", usage: { prompt: 10, completion: 2 }, toolCalls: s.calls || [], stopReason: (s.calls || []).length ? "tool_use" : "end" };
        },
      };
      const rt = createAgentRuntime({ config: { agent: { max_steps: 10, tool_timeout_ms: 30000, hooks }, security: { permission_mode: "full" } }, llm, mcpManager: new McpManager(), experts: [] });
      const events = [];
      await tools.withWorkspace(WS, () => rt.runTask({ history: [{ role: "user", content: "改个 bug" }], emit: (e) => events.push(e), taskLabel: "t", sessionId: "s-hook", mode: mode || "craft" }));
      return { calls: step, events, seen };
    };
    const w = (content) => ({ calls: [{ id: "w" + Math.random().toString(36).slice(2, 7), name: "write_file", input: { path: "ok.flag", content } }] });
    const gate = { done: [{ run: "grep -q fixed ok.flag || { echo 测试没过：还是坏的; exit 1; }" }] };
    const a = await run([w("broken"), { text: "修好了。" }, w("fixed"), { text: "这回真修好了。" }], gate);
    ok(a.calls === 4, "钩子没过 → 打回去接着改，过了才停（模型调用 4 次）", a.calls);
    ok(a.seen.some((s) => /收尾钩子/.test(s) && /测试没过/.test(s)), "打回时把钩子的输出念给它听");
    ok(a.events.some((e) => e.type === "text" && /done 钩子/.test(e.delta || "")), "界面上说清为什么打回");
    const b = await run([w("fixed"), { text: "修好了。" }], gate);
    ok(b.calls === 2, "一次就过：不多烧一轮（反向对照）", b.calls);
    const c = await run([w("broken"), { text: "修好了。" }, { text: "还是修好了。" }, { text: "真的。" }, { text: "嗯。" }], gate);
    ok(c.calls === 5, "死活不过：打回两次后收尾（第 5 次是不带工具的收尾说明），不磨到步数用完", c.calls);
    ok(/收尾钩子没过/.test(c.seen[4] || ""), "收尾说明那一问里告诉了它钩子没过", (c.seen[4] || "").slice(-200));
    ok(c.events.some((e) => e.type === "text" && /钩子没过/.test(e.delta || "")), "收尾时如实说钩子没过");
    const d = await run([{ text: "这是个问答。" }], gate);
    ok(d.calls === 1, "没改过文件的任务不跑 done（反向对照）", d.calls);
    const e2 = await run([w("broken"), { text: "看完了。" }], gate, "ask");
    ok(e2.calls <= 2 && !e2.seen.some((s) => /收尾钩子/.test(s)), "只读模式不跑 done", e2.calls);
  }

  try { fs.rmSync(WS, { recursive: true, force: true }); } catch {}
  finished = true;
  console.log(`\n${fail ? "挂了" : "全部通过"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
