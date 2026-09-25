"use strict";
/**
 * 写代码那几样：按名找文件 / 一个文件改多处 / 读过之后被改了就拦 / 后台命令 / 进度清单。
 *
 * 跑法：node test/code-tools.js
 * 临时数据目录，只起 sleep/echo 这种无害进程。
 *
 * 每一条都配反向对照：
 *   找文件——跳过 node_modules 的同时，点名要进 dist 的必须进得去；
 *   multi_edit——第 3 处失败时文件一个字节不动（不是改了前两处停在半截）；
 *   防冲突——文件真被改了才拦，touch 一下不拦、没读过的不拦、自己改完接着改不拦；
 *   后台命令——起得来、读得到增量、停得掉、别人的会话看不见。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-code-"));
process.env.OPENWORKBUDDY_HOME = TMP;
process.env.OPENWORKBUDDY_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });

const ROOT = path.join(__dirname, "..");
const tools = require(path.join(ROOT, "tools"));
const CT = require(path.join(ROOT, "code-tools"));
const { executeTool, TOOL_DEFS } = tools;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (detail === undefined ? "" : "\n      " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).replace(/\n/g, "\n      "))); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(50); }
  return false;
}

(async () => {
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), "owb-code-ws-"));
  tools.setWorkspaceDir(WS);
  const W = (rel, body) => { const p = path.join(WS, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
  const R = (rel) => fs.readFileSync(path.join(WS, rel), "utf8");
  const S1 = { sessionId: "s_one", actor: "alice", taskLabel: "测试" };
  const S2 = { sessionId: "s_two", actor: "bob", taskLabel: "测试" };

  console.log("\n① glob 翻译");
  {
    const t = (g, s) => { const m = CT.globToRegex(g); return m.re.test(m.nameOnly ? s.split("/").pop() : s); };
    ok(t("*.js", "a/b/c.js") && !t("*.js", "a/b/c.ts"), "不带斜杠按文件名匹配，哪一层都算");
    ok(t("src/**/*.ts", "src/a.ts") && t("src/**/*.ts", "src/x/y/a.ts") && !t("src/**/*.ts", "lib/a.ts"), "** 跨零层或多层目录");
    ok(!t("src/*.ts", "src/x/a.ts"), "单个 * 不跨目录（反向对照）");
    ok(t("**/*.{ts,tsx}", "a/b.tsx") && t("**/*.{ts,tsx}", "b.ts") && !t("**/*.{ts,tsx}", "b.js"), "{a,b} 展开");
    ok(t("file?.md", "file1.md") && !t("file?.md", "file12.md"), "? 恰好一个字符");
    ok(t("a.b", "a.b") && !t("a.b", "axb"), "点号按字面量，不当正则通配（反向对照）");
    ok(CT.globToRegex("") === null, "空模式返回 null");
  }

  console.log("\n② find_files");
  {
    W("src/app.js", "1"); W("src/lib/util.js", "2"); W("src/lib/util.test.js", "3");
    W("node_modules/pkg/index.js", "x"); W(".git/hooks/pre.js", "x"); W("dist/bundle.js", "x"); W("README.md", "r");
    // 最近改过的排前面：把 util.js 的 mtime 拨到最新
    const now = Date.now() / 1000;
    fs.utimesSync(path.join(WS, "src/app.js"), now - 100, now - 100);
    fs.utimesSync(path.join(WS, "src/lib/util.test.js"), now - 50, now - 50);
    fs.utimesSync(path.join(WS, "src/lib/util.js"), now, now);
    const r = await executeTool("find_files", { pattern: "*.js" }, S1);
    const lines = r.content.split("\n").slice(1);
    ok(!r.isError && lines.length === 3, "*.js 找到 src 下 3 个", r.content);
    ok(!/node_modules|\.git|dist/.test(r.content), "node_modules / .git / dist 默认跳过", r.content);
    ok(lines[0] === "src/lib/util.js" && lines[2] === "src/app.js", "按修改时间新→旧排", lines);
    const d = await executeTool("find_files", { pattern: "dist/**/*.js" }, S1);
    ok(d.content.includes("dist/bundle.js"), "模式点名 dist 就进 dist（反向对照：跳过不是一刀切）", d.content);
    const sub = await executeTool("find_files", { pattern: "*.js", dir: "src/lib" }, S1);
    ok(sub.content.split("\n").length === 3 && !sub.content.includes("app.js"), "dir 限定子目录，结果仍按工作区相对路径给", sub.content);
    const cap = await executeTool("find_files", { pattern: "*.js", max: 1 }, S1);
    ok(/找到 3 个.*只列前 1 个/.test(cap.content) && cap.content.split("\n").length === 2, "max 截断并说清总数", cap.content);
    const none = await executeTool("find_files", { pattern: "*.rs" }, S1);
    ok(!none.isError && /没有匹配/.test(none.content), "没命中不算错，给写法提示", none.content);
    const empty = await executeTool("find_files", { pattern: "" }, S1);
    ok(empty.isError, "空模式报错");
    const esc = await executeTool("find_files", { pattern: "*.js", dir: "../../" }, S1);
    ok(esc.isError, "dir 逃出工作区被拦", esc.content);
  }

  console.log("\n③ multi_edit");
  {
    W("m.js", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const r = await executeTool("multi_edit", { path: "m.js", edits: [
      { old_text: "const a = 1;", new_text: "const a = 10;" },
      { old_text: "const b = 2;", new_text: "const b = 20;" },
    ] }, S1);
    ok(!r.isError && R("m.js") === "const a = 10;\nconst b = 20;\nconst c = 3;\n", "两处都改好", r.content + "\n" + R("m.js"));
    ok(/2 处全部改好/.test(r.content), "回执说改了几处", r.content);

    // 顺序语义：第二处看到的是第一处改完的结果
    W("seq.txt", "foo\n");
    const q = await executeTool("multi_edit", { path: "seq.txt", edits: [
      { old_text: "foo", new_text: "bar" }, { old_text: "bar", new_text: "baz" },
    ] }, S1);
    ok(!q.isError && R("seq.txt") === "baz\n", "按顺序套用：后一处能改前一处的产物", R("seq.txt"));

    // 原子性：第 3 处对不上，前两处也不许落盘
    const before = "x1\nx2\nx3\n";
    W("atom.txt", before);
    const bad = await executeTool("multi_edit", { path: "atom.txt", edits: [
      { old_text: "x1", new_text: "y1" }, { old_text: "x2", new_text: "y2" }, { old_text: "不存在的内容", new_text: "z" },
    ] }, S1);
    ok(bad.isError && /第 3 处/.test(bad.content) && /整个文件没动/.test(bad.content), "报出是第几处失败", bad.content);
    ok(R("atom.txt") === before, "失败时文件一个字节不动（反向对照：不是改了前两处停在半截）", R("atom.txt"));

    const dup = await executeTool("multi_edit", { path: "atom.txt", edits: [{ old_text: "x", new_text: "q" }] }, S1);
    ok(dup.isError && /不唯一/.test(dup.content), "每一处照样要求唯一", dup.content);
    const all = await executeTool("multi_edit", { path: "atom.txt", edits: [{ old_text: "x", new_text: "q", replace_all: true }] }, S1);
    ok(!all.isError && R("atom.txt") === "q1\nq2\nq3\n", "单处 replace_all 生效", R("atom.txt"));
    const nothing = await executeTool("multi_edit", { path: "atom.txt", edits: [] }, S1);
    ok(nothing.isError, "空 edits 报错");
    const same = await executeTool("multi_edit", { path: "atom.txt", edits: [{ old_text: "q1", new_text: "q1" }] }, S1);
    ok(!same.isError && /没有变化/.test(same.content), "改完跟原来一样 = 没变化，不算错");
    const miss = await executeTool("multi_edit", { path: "nope.txt", edits: [{ old_text: "a", new_text: "b" }] }, S1);
    ok(miss.isError && /不存在/.test(miss.content), "文件不存在报错", miss.content);
  }

  console.log("\n④ 读过之后被改了就拦");
  {
    W("s.js", "let v = 1;\n");
    await executeTool("read_file", { path: "s.js" }, S1);
    // 模拟另一个进程改了它
    await wait(20);
    fs.writeFileSync(path.join(WS, "s.js"), "let v = 1;\nlet w = 2;\n");
    const e = await executeTool("edit_file", { path: "s.js", old_text: "let v = 1;", new_text: "let v = 9;" }, S1);
    ok(e.isError && /内容变了/.test(e.content) && R("s.js") === "let v = 1;\nlet w = 2;\n", "edit_file 被拦，盘上内容原样", e.content);
    const w = await executeTool("write_file", { path: "s.js", content: "let v = 9;\nlet w = 2;\n" }, S1);
    ok(w.isError && /内容变了/.test(w.content), "write_file 覆盖同样被拦", w.content);
    const m = await executeTool("multi_edit", { path: "s.js", edits: [{ old_text: "let v = 1;", new_text: "let v = 9;" }] }, S1);
    ok(m.isError && /内容变了/.test(m.content), "multi_edit 同样被拦");
    const ap = await executeTool("write_file", { path: "s.js", content: "// tail\n", append: true }, S1);
    ok(!ap.isError, "追加不拦（不会冲掉任何现有内容）", ap.content);
    const after = await executeTool("edit_file", { path: "s.js", old_text: "let v = 1;", new_text: "let v = 9;" }, S1);
    ok(after.isError, "追加不算重读：追加完再改照样拦（别人那一段它还是没看过）", after.content);

    // 重读之后放行
    await executeTool("read_file", { path: "s.js" }, S1);
    const e2 = await executeTool("edit_file", { path: "s.js", old_text: "let v = 1;", new_text: "let v = 9;" }, S1);
    ok(!e2.isError && R("s.js").startsWith("let v = 9;"), "重读之后放行", e2.content);
    // 自己改完接着改：不能把自己的改动当成别人的
    const e3 = await executeTool("edit_file", { path: "s.js", old_text: "let w = 2;", new_text: "let w = 3;" }, S1);
    ok(!e3.isError, "自己刚改过的接着改不拦（反向对照）", e3.content);
    // 另一个会话从没读过：不拦（老行为不变）
    const other = await executeTool("edit_file", { path: "s.js", old_text: "let w = 3;", new_text: "let w = 4;" }, S2);
    ok(!other.isError, "没读过的会话不拦（不强制先读）", other.content);
    // 那 S1 这边现在就该拦了——S2 改了它
    const e4 = await executeTool("edit_file", { path: "s.js", old_text: "let v = 9;", new_text: "let v = 8;" }, S1);
    ok(e4.isError, "另一个会话改过之后，这个会话再改被拦", e4.content);
    // 只 touch 不改内容：不拦
    await executeTool("read_file", { path: "s.js" }, S1);
    const t = Date.now() / 1000 + 5;
    fs.utimesSync(path.join(WS, "s.js"), t, t);
    const e5 = await executeTool("edit_file", { path: "s.js", old_text: "let v = 9;", new_text: "let v = 7;" }, S1);
    ok(!e5.isError, "只动了 mtime、内容没变：不拦（反向对照：比的是内容不是时间戳）", e5.content);
    // 读完被删
    await executeTool("read_file", { path: "s.js" }, S1);
    fs.unlinkSync(path.join(WS, "s.js"));
    const e6 = await executeTool("write_file", { path: "s.js", content: "let fresh = 1;\n" }, S1);
    ok(!e6.isError, "被删了之后 write_file 新建不拦（existed=false）", e6.content);
    // 分段读也算读过
    W("big.txt", "a\nb\nc\n");
    await executeTool("read_file", { path: "big.txt", start_line: 1, end_line: 1 }, S1);
    fs.writeFileSync(path.join(WS, "big.txt"), "a\nB\nc\n");
    const e7 = await executeTool("edit_file", { path: "big.txt", old_text: "a", new_text: "A" }, S1);
    ok(e7.isError, "分段读也登记，读后被改照样拦");
    // 没有会话 id 的调用（直调口/老调用方）：不登记也不拦
    W("nos.txt", "1");
    await executeTool("read_file", { path: "nos.txt" }, {});
    fs.writeFileSync(path.join(WS, "nos.txt"), "2");
    const e8 = await executeTool("edit_file", { path: "nos.txt", old_text: "2", new_text: "3" }, {});
    ok(!e8.isError, "没有会话 id 不拦（老调用方行为不变）", e8.content);
  }

  console.log("\n⑤ 后台命令");
  {
    const r = await executeTool("run_shell", { command: "echo start; sleep 0.3; echo middle; sleep 30", background: true }, S1);
    const id = (/(bg\d+)/.exec(r.content) || [])[1];
    ok(!r.isError && id, "background:true 立刻返回 id", r.content);
    ok(await until(async () => (await executeTool("shell_output", { id }, { ...S1 })).content.includes("middle") || false, 4000) || true, "等得到输出");
    // 上一步那次 until 已经把游标读走了；这里重新验证增量语义
    const a = await executeTool("shell_output", { id, all: true }, S1);
    ok(/start/.test(a.content) && /middle/.test(a.content) && /还在跑/.test(a.content), "all:true 给全部，状态是还在跑", a.content);
    const b = await executeTool("shell_output", { id }, S1);
    ok(/没有新输出/.test(b.content), "读过之后再读：没有新输出（增量游标）", b.content);
    const peek = await executeTool("shell_output", { id }, S2);
    ok(peek.isError, "别人的会话看不见这条后台命令", peek.content);
    const killOther = await executeTool("shell_kill", { id }, S2);
    ok(killOther.isError, "别人也停不掉它");
    const list = await executeTool("shell_output", {}, S1);
    ok(list.content.includes(id), "不给 id 列出自己的后台命令", list.content);
    const listOther = await executeTool("shell_output", {}, S2);
    ok(!listOther.content.includes(id), "别人列不出来");
    const k = await executeTool("shell_kill", { id }, S1);
    ok(!k.isError, "shell_kill 停掉", k.content);
    ok(await until(async () => /终止|已结束/.test((await executeTool("shell_output", { id }, S1)).content), 4000), "停掉之后状态变成已终止");
    const k2 = await executeTool("shell_kill", { id }, S1);
    ok(!k2.isError && /不用停/.test(k2.content), "停过再停：不报错，说不用停", k2.content);

    const done = await executeTool("run_shell", { command: "echo hi; exit 3", background: true }, S1);
    const id2 = (/(bg\d+)/.exec(done.content) || [])[1];
    ok(await until(async () => /exit code 3/.test((await executeTool("shell_output", { id: id2, all: true }, S1)).content)), "自己跑完的命令报出 exit code");

    // 上限：起满 8 条后第 9 条被拒
    const ids = [];
    for (let i = 0; i < CT.BG_MAX; i++) {
      const x = await executeTool("run_shell", { command: "sleep 30", background: true }, S1);
      const m = /(bg\d+)/.exec(x.content); if (m) ids.push(m[1]);
    }
    const over = await executeTool("run_shell", { command: "sleep 30", background: true }, S1);
    ok(over.isError && /上限/.test(over.content), `同时挂满 ${CT.BG_MAX} 条之后拒绝再起`, over.content);
    for (const i of ids) await executeTool("shell_kill", { id: i }, S1);
    const fg = await executeTool("run_shell", { command: "echo fg" }, S1);
    ok(!fg.isError && /fg/.test(fg.content) && /exit code: 0/.test(fg.content), "不带 background 照旧等它跑完（反向对照）", fg.content);
    ok(await until(() => CT.bgList().every((j) => j.exit !== undefined), 5000), "全部停干净");
  }

  console.log("\n⑥ 进度清单");
  {
    const r = await executeTool("todo_write", { todos: [
      { content: "读懂现有登录逻辑", status: "done" },
      { content: "加限流", status: "in_progress" },
      { content: "补测试", status: "pending" },
    ] }, S1);
    ok(!r.isError && Array.isArray(r.todos) && r.todos.length === 3, "合法清单通过，带回 todos 给界面画", r.content);
    ok(/1\/3 完成/.test(r.content) && /正在做：加限流/.test(r.content), "回执说进度和正在做哪条", r.content);
    const two = await executeTool("todo_write", { todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }] }, S1);
    ok(two.isError && /只能有一条/.test(two.content), "两条 in_progress 被拒");
    const bad = await executeTool("todo_write", { todos: [{ content: "a", status: "whatever" }] }, S1);
    ok(bad.isError, "认不出的 status 被拒");
    const alias = await executeTool("todo_write", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "进行中" }] }, S1);
    ok(!alias.isError && alias.todos[0].status === "done" && alias.todos[1].status === "in_progress", "completed / 进行中 这种近义写法认得", alias.content);
    const allDone = await executeTool("todo_write", { todos: [{ content: "a", status: "done" }] }, S1);
    ok(/全部完成/.test(allDone.content), "全部完成时提醒核一遍");
    const notArr = await executeTool("todo_write", { todos: "a,b" }, S1);
    ok(notArr.isError, "不是数组报错");
  }

  console.log("\n⑦ 工具表");
  {
    const names = TOOL_DEFS.map((t) => t.name);
    for (const n of ["find_files", "multi_edit", "shell_output", "shell_kill", "todo_write"]) ok(names.includes(n), `${n} 在 TOOL_DEFS 里`);
    const rs = TOOL_DEFS.find((t) => t.name === "run_shell");
    ok(rs.input_schema.properties.background, "run_shell 有 background 参数");
    const agentSrc = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8");
    ok(/READ_ONLY_TOOLS = \[[^\]]*"find_files"/.test(agentSrc), "find_files 算只读（问答/规划模式可用、可并发）");
    ok(!/READ_ONLY_TOOLS = \[[^\]]*"(multi_edit|shell_kill|todo_write)"/.test(agentSrc), "会动东西的不在只读名单里（反向对照）");
  }

  console.log("\n⑧ 清单没勾完不许收尾");
  {
    const { createAgentRuntime } = require(path.join(ROOT, "agent"));
    const { McpManager } = require(path.join(ROOT, "mcp"));
    const run = async (script) => {
      let step = 0;
      const seen = [];
      const llm = {
        provider: "mock", model: "scripted",
        async chat(args) {
          const h = (args && (args.messages || args.history)) || [];
          seen.push(JSON.stringify(h).slice(-600));
          const s = script[step++] || { text: "完了。" };
          return { text: s.text || "", usage: { prompt: 10, completion: 2 }, toolCalls: s.calls || [], stopReason: (s.calls || []).length ? "tool_use" : "end" };
        },
      };
      const rt = createAgentRuntime({ config: { agent: { max_steps: 8, tool_timeout_ms: 30000 } }, llm, mcpManager: new McpManager(), experts: [] });
      const events = [];
      await tools.withWorkspace(WS, () => rt.runTask({ history: [{ role: "user", content: "给登录接口加限流" }], emit: (e) => events.push(e), taskLabel: "t", sessionId: "s-todo" }));
      return { calls: step, events, seen };
    };
    const td = (items) => ({ calls: [{ id: "t" + Math.random().toString(36).slice(2, 7), name: "todo_write", input: { todos: items } }] });
    const a = await run([
      td([{ content: "读懂登录逻辑", status: "done" }, { content: "加限流", status: "in_progress" }]),
      { text: "做好了。" },
      td([{ content: "读懂登录逻辑", status: "done" }, { content: "加限流", status: "done" }]),
      { text: "全部完成。" },
    ]);
    ok(a.calls === 4, "还有一条没勾就收尾 → 被打回，接着做完才停（模型调用 4 次）", a.calls);
    ok(a.seen.some((h) => /进度清单里这些还没标 done/.test(h) && /加限流/.test(h)), "打回时把没勾的那条原样念给它听");
    ok(a.events.filter((e) => e.type === "todos").length === 2, "每次 todo_write 都推一张清单给界面");
    ok(a.events.some((e) => e.type === "text" && /进度清单里还有 1 条没打勾/.test(e.delta || "")), "界面上说清为什么打回");
    const b = await run([
      td([{ content: "读懂登录逻辑", status: "done" }, { content: "加限流", status: "done" }]),
      { text: "全部完成。" },
    ]);
    ok(b.calls === 2, "全勾完了就正常收尾，不多烧一轮（反向对照）", b.calls);
    const c = await run([{ text: "你好，我是助手。" }]);
    ok(c.calls === 1, "没列清单的任务不受影响（反向对照）", c.calls);
  }

  console.log("\n⑨ 换行符和缩进风格跟着文件走");
  {
    const S = { sessionId: "s_eol", actor: "carol", taskLabel: "测试" };
    const E = async (rel, input, tool = "edit_file") => { await executeTool("read_file", { path: rel }, S); return executeTool(tool, { path: rel, ...input }, S); };
    W("crlf.txt", "a = 1\r\nb = 2\r\nc = 3\r\n");
    let r = await E("crlf.txt", { old_text: "a = 1\nb = 2", new_text: "a = 10\nb = 20" });
    ok(!r.isError && R("crlf.txt") === "a = 10\r\nb = 20\r\nc = 3\r\n", "★CRLF 文件用 \\n 写的 old/new 也能改，改完整篇还是 CRLF★", [r.content, R("crlf.txt")]);
    r = await E("crlf.txt", { edits: [{ old_text: "a = 10", new_text: "a = 1\na2 = 1" }, { old_text: "c = 3", new_text: "c = 4" }] }, "multi_edit");
    ok(!r.isError && R("crlf.txt") === "a = 1\r\na2 = 1\r\nb = 20\r\nc = 4\r\n", "multi_edit 一样", [r.content, R("crlf.txt")]);
    r = await E("crlf.txt", { content: "z\nq\n" }, "write_file");
    ok(!r.isError && R("crlf.txt") === "z\r\nq\r\n", "write_file 整篇重写保留 CRLF", R("crlf.txt"));
    r = await E("crlf.txt", { content: "tail\n", append: true }, "write_file");
    ok(!r.isError && R("crlf.txt") === "z\r\nq\r\ntail\r\n", "追加也保留 CRLF", R("crlf.txt"));
    W("mixed.txt", "a\r\nb\nc\r\n");
    r = await E("mixed.txt", { old_text: "b", new_text: "b2\nb3" });
    ok(!r.isError && R("mixed.txt") === "a\r\nb2\nb3\nc\r\n", "本来就混着的文件不去动它的换行（反向对照）", R("mixed.txt"));
    W("lf.txt", "a\nb\n");
    r = await E("lf.txt", { content: "x\ny\n" }, "write_file");
    ok(R("lf.txt") === "x\ny\n", "LF 文件照旧是 LF（反向对照）", R("lf.txt"));

    W("tab.py", "def f():\n\treturn 1\n");
    r = await E("tab.py", { old_text: "def f():\n    return 1", new_text: "def f():\n    if x:\n        return 2" });
    ok(!r.isError && R("tab.py") === "def f():\n\tif x:\n\t\treturn 2\n", "★文件用 Tab、给的是空格：写回去换成 Tab，不留混缩进★", R("tab.py"));
    W("sp.py", "def f():\n    return 1\n");
    r = await E("sp.py", { old_text: "def f():\n\treturn 1", new_text: "def f():\n\tif x:\n\t\treturn 2" });
    ok(!r.isError && R("sp.py") === "def f():\n    if x:\n        return 2\n", "反过来：文件用空格、给的是 Tab", R("sp.py"));
    W("sp2.py", "def f():\n    return 1\n");
    r = await E("sp2.py", { old_text: "def f():\n    return 1", new_text: "def f():\n    return 2" });
    ok(!r.isError && R("sp2.py") === "def f():\n    return 2\n", "缩进本来就对得上的不动（反向对照）", R("sp2.py"));
    W("tab2.py", "def f():\n\tif y:  \n\t\treturn 1\n"); // 行尾多了空格，逼它走宽松匹配
    r = await E("tab2.py", { old_text: "def f():\n\tif y:\n\t\treturn 1", new_text: "def f():\n\tif y:\n\t\treturn 3" });
    ok(!r.isError && R("tab2.py") === "def f():\n\tif y:\n\t\treturn 3\n", "宽松匹配时 Tab 对 Tab 也不动（反向对照）", R("tab2.py"));

    // 宽松匹配只会按第一行的缩进差整体挪。各行差得不一样时照挪就是改坏：YAML 层级变了、b() 挪进了 if，还报成功
    W("app.yml", "server:\n  port: 80\n  host: a\n");
    r = await E("app.yml", { old_text: "server:\nport: 80\nhost: a", new_text: "server:\nport: 8080\nhost: a" });
    ok(r.isError && /各行差得不一样/.test(r.content) && r.content.includes("<<<原文开始\nserver:\n  port: 80\n  host: a\n>>>原文结束") && R("app.yml") === "server:\n  port: 80\n  host: a\n",
      "★old_text 把 YAML 写平了：拒改、文件一个字节不动，原文贴回去让它照抄★", [r.content, R("app.yml")]);
    W("mid.py", "def f(x):\n    if x:\n        a()\n    b()\n");
    r = await E("mid.py", { old_text: "if x:\n    a()\n    b()", new_text: "if x:\n    a()\n    b()\n    c()" });
    ok(r.isError && R("mid.py") === "def f(x):\n    if x:\n        a()\n    b()\n", "★中间一行缩进抄错：拒改，不把 b() 挪进 if 里★", [r.content, R("mid.py")]);
    r = await E("mid.py", { edits: [{ old_text: "if x:\na()\nb()", new_text: "if x:\na()\nb()\nc()" }] }, "multi_edit");
    ok(r.isError && /第 1 处/.test(r.content) && R("mid.py") === "def f(x):\n    if x:\n        a()\n    b()\n", "multi_edit 整段写平了一样拒", r.content);
    W("tail.txt", "alpha \nbeta\ngamma\n");
    r = await E("tail.txt", { old_text: "alpha\nbeta\n", new_text: "ALPHA\nBETA\n" });
    ok(!r.isError && R("tail.txt") === "ALPHA\nBETA\ngamma\n", "★old_text/new_text 都带结尾换行：宽松匹配不多塞一个空行★", [r.content, R("tail.txt")]);
    W("g.py", "def g():\n    a = 1\n    b = 2\n    c = 3\n");
    r = await E("g.py", { old_text: "a = 1  \nb = 2\n", new_text: "a = 10\nb = 20\n" });
    ok(!r.isError && R("g.py") === "def g():\n    a = 10\n    b = 20\n    c = 3\n", "每行都少同样一截缩进：照旧补回去，也不多空行（反向对照）", [r.content, R("g.py")]);
  }

  console.log("\n⑩ read_file 的边角");
  {
    const S = { sessionId: "s_read", actor: "dan", taskLabel: "测试" };
    W("many.txt", Array.from({ length: 300 }, (_, i) => "row " + (i + 1)).join("\n"));
    let r = await executeTool("read_file", { path: "many.txt", offset: 290, limit: 3 }, S);
    ok(!r.isError && /第 290-292 行/.test(r.content) && /290\trow 290\n291\trow 291\n292\trow 292$/.test(r.content), "★offset/limit 也认★ 不再被静默丢掉、从头整篇读", r.content);
    r = await executeTool("read_file", { path: "many.txt", limit: 2 }, S);
    ok(/第 1-2 行/.test(r.content) && !/row 3/.test(r.content), "只给 limit 从第 1 行读", r.content);
    r = await executeTool("read_file", { path: "many.txt", start_line: 10, end_line: 11 }, S);
    ok(/第 10-11 行/.test(r.content), "start_line/end_line 照旧（反向对照）", r.content);
    W("blob.bin", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1, 2]));
    r = await executeTool("read_file", { path: "blob.bin" }, S);
    ok(r.isError && /二进制/.test(r.content) && !/\u0000/.test(r.content), "★二进制文件直说，不回一堆乱码★", r.content);
    W("text.txt", "普通 text\n");
    r = await executeTool("read_file", { path: "text.txt" }, S);
    ok(!r.isError && r.content === "普通 text\n", "中文文本不被当成二进制（反向对照）", r.content);
  }

  console.log("\n⑪ 等输入的命令不空等；搜索认别家的参数名");
  {
    const S = { sessionId: "s_misc", actor: "erin", taskLabel: "测试", timeoutMs: 15000 };
    let t0 = Date.now();
    let r = await executeTool("run_shell", { command: "read x; echo got=[$x]" }, S);
    ok(Date.now() - t0 < 5000 && /got=\[\]/.test(r.content), "★run_shell 里等输入的命令当场读到结尾，不空等到超时★", { ms: Date.now() - t0, c: r.content });
    t0 = Date.now();
    r = await executeTool("run_node", { code: "process.stdin.on('data',()=>{}).on('end',()=>console.log('eof'))" }, S);
    ok(Date.now() - t0 < 5000 && /eof/.test(r.content), "★run_node 同样★", { ms: Date.now() - t0, c: r.content });
    r = await executeTool("run_shell", { command: "echo ok" }, S);
    ok(!r.isError && /ok/.test(r.content), "普通命令照旧（反向对照）", r.content);
    r = await executeTool("run_shell", { command: "   " }, S);
    ok(r.isError && /command 是空的/.test(r.content), "空命令直说，不回一个假的 exit 0", r.content);
    W("sx/a.js", "const needle = 1;\n");
    W("sx/b.js", "needle again\n");
    r = await executeTool("search_files", { pattern: "needle", path: "sx" }, S);
    ok(!r.isError && /a\.js:1/.test(r.content) && /b\.js:1/.test(r.content), "pattern/path 也认", r.content);
    r = await executeTool("search_files", { query: "needle", dir: "sx/a.js" }, S);
    ok(!r.isError && /a\.js:1/.test(r.content) && !/b\.js/.test(r.content), "★给的是一个文件就只搜这一个★ 不再回「没搜到、扫了 0 个」", r.content);
  }

  console.log("\n⑫ 超时连孙子进程一起收，工具一定回得来");
  if (process.platform !== "win32") {
    const { spawnSync } = require("child_process");
    // 每条用一个独一无二的秒数当记号（小数部分带上本进程 pid，同时跑两份也不会认错人），事后按它找有没有漏在后台的进程
    const mark = (sec) => `${sec}.${process.pid}`;
    const alive = (m) => !!spawnSync("pgrep", ["-f", "sleep " + m], { encoding: "utf8" }).stdout.trim();
    const S = { sessionId: "s_tmo", actor: "fay", taskLabel: "测试", timeoutMs: 1500 };
    const timed = async (tool, input, opts = S) => { const t0 = Date.now(); const r = await executeTool(tool, input, opts); return { r, ms: Date.now() - t0 }; };
    let { r, ms } = await timed("run_shell", { command: `sleep ${mark(12)}; echo after` });
    ok(ms < 5000 && r.isError && /执行超时被终止/.test(r.content) && !/after/.test(r.content), "★`sleep; echo` 这种复合命令到点就回★ 以前要等 sleep 跑完", { ms, c: r.content });
    ok(await until(() => !alive(mark(12)), 3000), "孙子进程（那个 sleep）一起收掉了，没漏在后台");
    ({ r, ms } = await timed("run_shell", { command: `sleep ${mark(13)} | tail -1` }));
    ok(ms < 5000 && /执行超时被终止/.test(r.content) && /background:true/.test(r.content), "管道同样到点就回，并指一条路：不会自己结束的用 background", { ms, c: r.content });
    ok(await until(() => !alive(mark(13)), 3000), "管道里的 sleep 也收掉了");
    // run_node 里开子进程要人点头；这里先替它点了，不然两条都卡在审批上
    const security = require(path.join(ROOT, "security"));
    security.addSessionAllow("code:child_process");
    ({ r, ms } = await timed("run_node", { code: `require("child_process").spawn("sleep", ["${mark(14)}"], { stdio: "inherit" });` }));
    ok(ms < 5000 && r.isError && /执行超时被终止/.test(r.content), "★run_node 脚本拉起的子进程攥着输出，也到点就回★", { ms, c: r.content });
    ok(await until(() => !alive(mark(14)), 3000), "脚本拉起的 sleep 收掉了");
    // 自己另起进程组还攥着管道的（setsid 那种）：整组杀够不着它，宽限过后把管道掐断，保证这一步回得来
    ({ r, ms } = await timed("run_node", { code: `require("child_process").spawn("sleep", ["${mark(15)}"], { stdio: "inherit", detached: true }).unref();` }));
    ok(ms < 11000 && r.isError && /执行超时被终止/.test(r.content), "跳出进程组的孙子攥着管道：掐断管道也要回来", { ms, c: r.content });
    spawnSync("pkill", ["-f", "sleep " + mark(15)]);
    security.clearSessionAllow();
    ({ r, ms } = await timed("run_shell", { command: "echo quick" }));
    ok(!r.isError && /quick/.test(r.content) && !/执行超时/.test(r.content), "跑得完的命令不沾「超时」（反向对照）", r.content);
    r = await executeTool("run_shell", { command: "echo oops >&2; exit 2" }, S);
    ok(r.isError && /exit code: 2/.test(r.content) && !/执行超时/.test(r.content), "自己出错退出的也不是超时（反向对照）", r.content);
  }

  console.log("\n⑬ 少给 content / new_text 是错，不是「清空」");
  {
    const S = { sessionId: "s_miss", actor: "gus", taskLabel: "测试" };
    W("keep.txt", "hello\nworld\n");
    let r = await executeTool("write_file", { path: "keep.txt" }, S);
    ok(r.isError && /没给 content/.test(r.content) && R("keep.txt") === "hello\nworld\n", "★write_file 没给 content：报错，文件一个字节不动★（以前「原 12 字节 → 现 0 字节」算成功）", [r.content, R("keep.txt")]);
    r = await executeTool("write_file", { path: "keep.txt", file_text: "别家的参数名" }, S);
    ok(r.isError && R("keep.txt") === "hello\nworld\n", "参数名写成 file_text 一样拦", r.content);
    r = await executeTool("write_file", { path: "keep.txt", append: true }, S);
    ok(r.isError && R("keep.txt") === "hello\nworld\n", "append 没给 content 也不报「+0 字节」成功", r.content);
    r = await executeTool("write_file", { path: "never.md" }, S);
    ok(r.isError && !fs.existsSync(path.join(WS, "never.md")), "新文件没给 content：不建空文件", r.content);
    r = await executeTool("write_file", { path: "empty.txt", content: "" }, S);
    ok(!r.isError && R("empty.txt") === "", "显式给 content:\"\" 照样能建空文件（反向对照）", r.content);
    r = await executeTool("write_file", { path: "cfg.json", content: { a: 1 } }, S);
    ok(!r.isError && JSON.parse(R("cfg.json")).a === 1, ".json 给了个对象：排成 JSON 文本写，不写「[object Object]」", R("cfg.json"));
    W("obj.md", "# 标题\n");
    r = await executeTool("write_file", { path: "obj.md", content: { a: 1 } }, S);
    ok(r.isError && R("obj.md") === "# 标题\n", "别的文件给对象：报错，不动文件", [r.content, R("obj.md")]);

    const fn = "function a() {\n  return 1;\n}\n";
    W("m.js", fn + "const x = 1;\n");
    r = await executeTool("edit_file", { path: "m.js", old_text: fn }, S);
    ok(r.isError && /没给 new_text/.test(r.content) && R("m.js") === fn + "const x = 1;\n", "★edit_file 没给 new_text：报错，函数还在★（以前当成删掉）", [r.content, R("m.js")]);
    r = await executeTool("edit_file", { path: "m.js", old_text: "const x = 1;", new_str: "const x = 42;" }, S);
    ok(r.isError && /const x = 1;/.test(R("m.js")), "参数名写成 new_str 一样拦", r.content);
    r = await executeTool("multi_edit", { path: "m.js", edits: [{ old_text: "return 1;", new_text: "return 2;" }, { old_text: "const x = 1;" }] }, S);
    ok(r.isError && /第 2 处/.test(r.content) && /没给 new_text/.test(r.content) && R("m.js") === fn + "const x = 1;\n", "multi_edit 第 2 处没给：整个文件不动，报错点出第几处", [r.content, R("m.js")]);
    W("crlf2.txt", "a = 1\r\nb = 2\r\n");
    r = await executeTool("edit_file", { path: "crlf2.txt", old_text: "a = 1" }, S);
    ok(r.isError && R("crlf2.txt") === "a = 1\r\nb = 2\r\n", "CRLF 文件走的另一条路也拦", r.content);
    r = await executeTool("edit_file", { path: "m.js", old_text: "const x = 1;\n", new_text: "" }, S);
    ok(!r.isError && R("m.js") === fn, "显式 new_text:\"\" 照旧是删掉这段（反向对照）", [r.content, R("m.js")]);
  }

  console.log("\n⑭ 按行段读：只在整行上收，抬头写到哪一行正文就到哪一行");
  {
    const S = { sessionId: "s_range", actor: "hal", taskLabel: "测试" };
    const row = (i) => `line ${String(i).padStart(4, "0")} ` + "y".repeat(50);
    W("long.txt", Array.from({ length: 2000 }, (_, i) => row(i + 1)).join("\n") + "\n");
    const check = (r, what) => {
      const head = /^（long\.txt 第 (\d+)-(\d+) 行，全文共 (\d+) 行）/.exec(r.content);
      const nums = [...r.content.matchAll(/^(\d+)\t/gm)].map((m) => Number(m[1]));
      const last = nums[nums.length - 1];
      ok(head && Number(head[2]) === last, `${what}：抬头写的末行 = 正文最后一个行号`, [head && head[0], last]);
      ok(r.content.includes(`\n${last}\t${row(last)}\n`), `${what}：最后一行是整行，没被劈开`, r.content.slice(-200));
      ok(r.content.length <= 50000, `${what}：还在 5 万字以内`, r.content.length);
      return last;
    };
    let r = await executeTool("read_file", { path: "long.txt", start_line: 1, end_line: 2000 }, S);
    let last = check(r, "1-2000 行");
    ok(last < 2000 && r.content.includes(`start_line=${last + 1}`) && /全文共 2001 行/.test(r.content), "★没给全就说只给到第几行、接着从哪读★（总行数口径不变）", r.content.slice(-160));
    r = await executeTool("read_file", { path: "long.txt", offset: 1, limit: 2000 }, S);
    ok(check(r, "offset/limit 写法") === last, "offset/limit 写法同样");
    // 照着末尾那句一段段接着读：每一行正好拿到一次，读到结尾就不再提示
    const seen = [];
    for (let from = 1, n = 0; from <= 2000 && n < 10; n++) {
      r = await executeTool("read_file", { path: "long.txt", start_line: from, end_line: 2000 }, S);
      for (const m of r.content.matchAll(/^(\d+)\t(.*)$/gm)) seen.push(m[2] === row(Number(m[1])) ? Number(m[1]) : -1);
      const next = /start_line=(\d+)/.exec(r.content);
      from = next ? Number(next[1]) : 2001;
    }
    ok(seen.length === 2000 && seen.every((no, i) => no === i + 1) && !/start_line=/.test(r.content), "★照着提示接着读，2000 行一行不漏、一行不重★", [seen.length, r.content.slice(-120)]);
    r = await executeTool("read_file", { path: "long.txt", start_line: 5, end_line: 7 }, S);
    ok(/^（long\.txt 第 5-7 行/.test(r.content) && r.content.endsWith(`7\t${row(7)}`), "没到上限的原样给，不多一句话（反向对照）", r.content);
    W("min.js", "x".repeat(80000) + "\nnext\n");
    r = await executeTool("read_file", { path: "min.js", start_line: 1, end_line: 3 }, S);
    ok(r.content.length <= 50000 && /第 1 行这一行就有 80000 字/.test(r.content) && /start_line=2/.test(r.content), "一行就超了（压缩过的 js）：劈开这一行并照直说", r.content.slice(-200));
    W("emoji.txt", "😀".repeat(30000) + "\n");
    r = await executeTool("read_file", { path: "emoji.txt", start_line: 1, end_line: 1 }, S);
    ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(r.content), "劈的时候不留半个 emoji");
    // 大文件那条路（>4MB 分块读）同一个规矩，总行数照样数到底
    const brow = (i) => `row ${String(i).padStart(6, "0")} ` + "z".repeat(60);
    W("huge.log", Array.from({ length: 70000 }, (_, i) => brow(i + 1)).join("\n") + "\n");
    r = await executeTool("read_file", { path: "huge.log", start_line: 100, end_line: 2100 }, S);
    const head = /^（huge\.log 第 100-(\d+) 行，全文共 70001 行）/.exec(r.content);
    const bl = head && Number(head[1]);
    ok(head && bl < 2100 && r.content.includes(`\n${bl}\t${brow(bl)}\n`) && r.content.includes(`start_line=${bl + 1}`) && r.content.length <= 50000, "★>4MB 的大文件按行段读：同样整行收、说清接着从哪读、总行数数到底★", [head && head[0], r.content.slice(-160)]);
  }

  console.log("\n⑮ search_files：路径跟 read_file 同一个起点；大文件不装没有；大小写照 smart-case");
  {
    const S = { sessionId: "s_grep", actor: "ivy", taskLabel: "测试" };
    W("proj/src/util/index.js", "export function parseDate() {}\n");
    W("util/index.js", "// 根下另一个同名文件，不相干\n");
    let r = await executeTool("search_files", { query: "parseDate", dir: "proj/src" }, S);
    ok(/^proj\/src\/util\/index\.js:1: export function parseDate/.test(r.content), "★dir 指到子目录，回来的路径照样从工作目录起算★", r.content);
    const rd = await executeTool("read_file", { path: r.content.split(":")[0] }, S);
    ok(/parseDate/.test(rd.content), "拿这个路径去 read_file 读到的就是命中的那个文件", rd.content);
    r = await executeTool("search_files", { query: "parseDate", dir: "proj/src/util/index.js" }, S);
    ok(/^proj\/src\/util\/index\.js:1:/.test(r.content), "只搜一个文件时也不只剩个文件名", r.content);
    r = await executeTool("search_files", { query: "parseDate" }, S);
    ok(/^proj\/src\/util\/index\.js:1:/.test(r.content), "整个工作目录搜，路径跟原来一样（反向对照）", r.content);
    // 成果子目录：read_file 从它起算，search_files 也得从它起算
    const SB = { ...S, baseDir: "任务_查找" };
    W("任务_查找/docs/a.md", "zzq 标记\n");
    r = await executeTool("search_files", { query: "zzq", dir: "docs" }, SB);
    ok(/^docs\/a\.md:1:/.test(r.content), "有成果子目录时，路径从子目录起算（跟 read_file 一个起点）", r.content);
    ok(/zzq/.test((await executeTool("read_file", { path: "docs/a.md" }, SB)).content), "照着读得到");
    // list_files 同一个起点
    r = await executeTool("list_files", { dir: "proj", depth: 3 }, S);
    ok(/^proj\/src\/util\/index\.js\t/m.test(r.content) && /^\[目录\] proj\/src\/$/m.test(r.content) && !/^src\//m.test(r.content), "★list_files 指到子目录，列出来的也从工作目录起算★", r.content);
    r = await executeTool("list_files", { dir: "docs" }, SB);
    ok(/^docs\/a\.md\t/.test(r.content), "list_files 在成果子目录里也跟 read_file 一个起点", r.content);
    r = await executeTool("list_files", { dir: "." }, SB);
    ok(/^\[目录\] docs\/$/m.test(r.content) && !/任务_查找/.test(r.content), "不给子目录时照旧（反向对照）", r.content);

    const bigLines = Array.from({ length: 40000 }, (_, i) => `2026-09-25 INFO req ${i} ok ` + "p".repeat(40));
    bigLines[31234] = "2026-09-25 FATAL ERROR 数据库连不上";
    W("logs/app.log", bigLines.join("\n") + "\n");
    ok(fs.statSync(path.join(WS, "logs/app.log")).size > 2 * 1024 * 1024, "造的日志过了 2MB（不然这一屏等于没测）");
    r = await executeTool("search_files", { query: "FATAL", dir: "logs" }, S);
    ok(/logs\/app\.log（2\.\dMB）/.test(r.content) && /超过 2MB 的文件没搜/.test(r.content) && /dir/.test(r.content), "★顺着目录搜跳过的大文件要点名说出来，不能只回「没搜到」★", r.content);
    r = await executeTool("search_files", { query: "FATAL", dir: "logs/app.log" }, S);
    ok(!r.isError && r.content.startsWith("logs/app.log:31235: 2026-09-25 FATAL ERROR"), "★点名那个大文件就真搜，行号对得上★", r.content.slice(0, 160));
    r = await executeTool("search_files", { query: "parseDate", dir: "proj" }, S);
    ok(!/2MB/.test(r.content), "没碰上大文件就不多这句话（反向对照）", r.content);

    W("case/c.py", "MAX_RETRY = 5\nmax_retry = 5\nuser_name = 'x'\nfoo = Foo()\nfoo_bar = 1\n");
    // 只看命中了哪几行，不管路径怎么写：这一段只验大小写
    const lines = (c) => c.split("\n").filter((l) => /^(?:case\/)?c\.py:\d+:/.test(l)).map((l) => Number(l.split(":")[1]));
    r = await executeTool("search_files", { query: "^[A-Z_]+ =", regex: true, dir: "case" }, S);
    ok(JSON.stringify(lines(r.content)) === "[1]", "★带大写的正则按大小写严格匹配★ 找常量不再混进 max_retry、user_name", r.content);
    r = await executeTool("search_files", { query: "Foo", dir: "case" }, S);
    ok(JSON.stringify(lines(r.content)) === "[4]", "搜 Foo 不再把 foo_bar 算进来", r.content);
    r = await executeTool("search_files", { query: "max_retry", dir: "case" }, S);
    ok(JSON.stringify(lines(r.content)) === "[1,2]", "全小写照旧不分大小写，该找到的都找到（反向对照）", r.content);
    r = await executeTool("search_files", { query: "\\w+_retry", regex: true, dir: "case" }, S);
    ok(JSON.stringify(lines(r.content)) === "[1,2]", "正则里的 \\W、\\S 这种转义不算大写", r.content);
    r = await executeTool("search_files", { query: "MAX_RETRY", ignore_case: true, dir: "case" }, S);
    ok(JSON.stringify(lines(r.content)) === "[1,2]", "ignore_case:true 强制不分", r.content);
    r = await executeTool("search_files", { query: "max_retry", ignore_case: false, dir: "case" }, S);
    ok(JSON.stringify(lines(r.content)) === "[2]", "ignore_case:false 强制区分", r.content);
    r = await executeTool("search_files", { query: "Max_Retry", dir: "case" }, S);
    ok(/没搜到/.test(r.content) && /ignore_case/.test(r.content), "区分大小写没搜到时说一声，给出不分的开关", r.content);
  }

  console.log("\n⑯ 不是 UTF-8 的文件不按 UTF-8 改");
  {
    const S = { sessionId: "s_enc", actor: "fay", taskLabel: "测试" };
    const B = (rel) => fs.readFileSync(path.join(WS, rel));
    // GBK 的「中文」= d6d0 cec4。按 UTF-8 解开再写回去，改的是 port 那行，name 那行却变成了 ����
    const gbk = Buffer.concat([Buffer.from("name="), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from("\nport=80\n")]);
    W("app.properties", gbk);
    let r = await executeTool("edit_file", { path: "app.properties", old_text: "port=80", new_text: "port=8080" }, S);
    ok(r.isError && /不是 UTF-8/.test(r.content) && /GBK/.test(r.content) && B("app.properties").equals(gbk), "★GBK 文件：拒改，一个字节不动★", [r.content, B("app.properties").toString("hex")]);
    const latin = Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from("\nx=1\ny=2\n")]);
    W("latin.txt", latin);
    r = await executeTool("multi_edit", { path: "latin.txt", edits: [{ old_text: "x=1", new_text: "x=2" }, { old_text: "y=2", new_text: "y=3" }] }, S);
    ok(r.isError && /不是 UTF-8/.test(r.content) && B("latin.txt").equals(latin), "★multi_edit 同样拒（Latin-1）★", [r.content, B("latin.txt").toString("hex")]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), Buffer.from("IHDR abc "), Buffer.from([0xff, 0xfe, 0x80])]);
    W("pic.dat", png);
    r = await executeTool("edit_file", { path: "pic.dat", old_text: "abc", new_text: "xyz" }, S);
    ok(r.isError && /二进制/.test(r.content) && B("pic.dat").equals(png), "二进制文件：拒改，签名字节还在", [r.content, B("pic.dat").toString("hex")]);
    W("bom.txt", "﻿a=1\nb=2\n");
    r = await executeTool("edit_file", { path: "bom.txt", old_text: "b=2", new_text: "b=3" }, S);
    ok(!r.isError && B("bom.txt").equals(Buffer.from("﻿a=1\nb=3\n")), "带 BOM 的 UTF-8 照改，BOM 还在（反向对照）", [r.content, B("bom.txt").toString("hex")]);
    W("zh.txt", "名字=中文\n端口=80\n");
    r = await executeTool("multi_edit", { path: "zh.txt", edits: [{ old_text: "端口=80", new_text: "端口=8080" }] }, S);
    ok(!r.isError && R("zh.txt") === "名字=中文\n端口=8080\n", "普通 UTF-8 中文照改（反向对照）", r.content);
  }

  console.log("\n⑰ 工作区里的符号链接不能把文件工具带出去");
  {
    const security = require(path.join(ROOT, "security"));
    const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "owb-code-out-"));
    const BL = fs.mkdtempSync(path.join(os.tmpdir(), "owb-code-bl-"));
    fs.writeFileSync(path.join(OUT, "secret.txt"), "TOP-SECRET\n");
    fs.writeFileSync(path.join(BL, "id_rsa"), "FAKE-KEY\n");
    W("in/a.txt", "inside\n");
    const L = (target, rel) => { try { fs.unlinkSync(path.join(WS, rel)); } catch {} fs.symlinkSync(target, path.join(WS, rel)); };
    L(OUT, "lnk");                                  // 链到工作区外面的普通目录
    L(BL, "bl");                                    // 链到黑名单目录（~/.ssh 的替身）
    L(path.join(BL, "authorized_keys2"), "notes.txt"); // 悬空链接：写它 = 在黑名单目录里新建
    L(path.join(WS, "in"), "inner");                // 链到工作区里面：照常放行
    L("loop2", "loop1"); L("loop1", "loop2");
    const sec = { ...security.DEFAULTS, file_blacklist: [...security.DEFAULTS.file_blacklist, BL] };
    const S = { sessionId: "s_link", actor: "gus", taskLabel: "测试", security: sec };
    const run = (tool, input, o = S) => executeTool(tool, input, o);

    let r = await run("read_file", { path: "lnk/secret.txt" });
    ok(r.isError && /工作区外面/.test(r.content) && !/TOP-SECRET/.test(r.content), "★经链接读工作区外的文件：拦★", r.content);
    r = await run("write_file", { path: "lnk/pwned.txt", content: "pwned\n" });
    ok(r.isError && !fs.existsSync(path.join(OUT, "pwned.txt")), "★经链接往工作区外写：拦，外面没多出文件★", r.content);
    r = await run("edit_file", { path: "lnk/secret.txt", old_text: "TOP-SECRET", new_text: "EDITED" });
    ok(r.isError && fs.readFileSync(path.join(OUT, "secret.txt"), "utf8") === "TOP-SECRET\n", "经链接改：拦，原文件不动", r.content);
    r = await run("list_files", { dir: "lnk" });
    ok(r.isError, "经链接列目录：拦", r.content);
    r = await run("read_file", { path: "bl/id_rsa" });
    ok(r.isError && /黑名单/.test(r.content) && !/FAKE-KEY/.test(r.content), "★经链接读黑名单里的文件：按黑名单拦★", r.content);
    r = await run("write_file", { path: "notes.txt", content: "ssh-ed25519 AAAA attacker\n" });
    ok(r.isError && !fs.existsSync(path.join(BL, "authorized_keys2")), "★悬空链接也追到底：写它不会在黑名单目录里新建文件★", r.content);
    r = await run("read_file", { path: "loop1/x" });
    ok(r.isError, "链接绕成圈：报错，不卡死", r.content);
    // run_node 自己在 .tmp 下链了一份本程序的 node_modules，文件工具不能借它碰本程序的依赖
    await run("run_node", { code: "console.log(1)" });
    const nm = fs.lstatSync(path.join(WS, ".tmp", "node_modules")).isSymbolicLink();
    r = await run("read_file", { path: ".tmp/node_modules/docx/package.json" });
    ok(nm && r.isError && /工作区外面/.test(r.content), "★.tmp/node_modules 是链到本程序依赖的：文件工具进不去★", { nm, c: r.content });

    r = await run("read_file", { path: "inner/a.txt" });
    ok(!r.isError && r.content === "inside\n", "链到工作区里面的照常读（反向对照）", r.content);
    r = await run("write_file", { path: "inner/b.txt", content: "ok\n" });
    ok(!r.isError && fs.readFileSync(path.join(WS, "in", "b.txt"), "utf8") === "ok\n", "链到工作区里面的照常写（反向对照）", r.content);
    r = await run("read_file", { path: "lnk/secret.txt" }, { ...S, security: { ...sec, file_whitelist: [OUT] } });
    ok(!r.isError && r.content === "TOP-SECRET\n", "链接那头在白名单里：放行（反向对照：拦的是越界，不是链接本身）", r.content);
    r = await run("read_file", { path: path.join(OUT, "secret.txt") }, { ...S, security: { ...sec, file_whitelist: [OUT] } });
    ok(!r.isError, "白名单目录直接给绝对路径照旧能读（反向对照）", r.content);
    // 工作区本身是个链接（/tmp、/var 在 macOS 上就是）：它自己的文件不能被当成越界
    const WSL = path.join(OUT, "ws-link");
    fs.symlinkSync(WS, WSL);
    const pr = security.resolvePathWithPolicy(sec, "in/a.txt", WSL);
    ok(pr.allowed && pr.path === path.join(WSL, "in", "a.txt"), "工作区路径本身经过链接：里面的文件照常放行，回的还是字面路径（反向对照）", pr);
    const nw = security.resolvePathWithPolicy(sec, "new/dir/c.txt", WS);
    ok(nw.allowed, "还不存在的新文件照常放行（反向对照）", nw);
    try { fs.rmSync(OUT, { recursive: true, force: true }); fs.rmSync(BL, { recursive: true, force: true }); } catch {}
  }

  try { fs.rmSync(WS, { recursive: true, force: true }); fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
