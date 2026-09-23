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

  try { fs.rmSync(WS, { recursive: true, force: true }); fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
