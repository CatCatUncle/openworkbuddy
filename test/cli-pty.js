"use strict";
/**
 * 真终端里敲键盘：审批单子、提问提示符，在一个真的伪终端里到底怎么反应。
 *
 * cli-approve / cli-ask 钉的是纯函数；这儿把真的 openworkbuddy 放进 pty（python3 的 pty 开一个），
 * 模型是本地假的，按键一块块喂进去，看屏幕、看工作区里文件还在不在、看模型收到的是哪句话。
 * 钉的几件事都是纯函数那层看不见的：
 *   1. 单子出来之前敲下的键不算点头。以前一个顺手的 a 就是「这类都允许」，后面的 rm 连卡片都不出
 *   2. 一次送来一串字（粘贴、输入法上屏）里打头的 y 不算点头
 *   3. 手机上先答了审批：单子整张擦掉，「手机上答了」留在屏上
 *   4. 手机上先答了提问：终端里打了一半的那句不许变成下一条任务
 *   5. 任务跑着时敲了、没回车的字，跑完接着打是接在后面，不是插到前头
 *   6. 正文跨过工具那一行：上一步没换行的半句先吐干净，下一步的 ## 标题照样渲染
 *   7. 弹了提问单子，就不再印「● Ask(题目)」和「└ 回答」：单子上已经有了
 *   8. 交互模式闲着的时候，网页 / 手机在同一条会话上聊了一轮：下一句开跑前先接上，存盘也不把那一轮盖掉
 * 没有 python3 / pty 的机器跳过。
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 只当「最多等这么久」用：不拖着进程不让退 */
const atMost = (ms) => new Promise((r) => setTimeout(r, ms).unref());

// 开一个 pty 把命令放进去：自己的 stdin 原样写进终端，终端吐的原样打到 stdout。
// Node 这边写一次，终端那头就是一块——粘贴、输入法上屏就是这么来的
const BRIDGE = `
import os, pty, sys, select, signal, struct, fcntl, termios
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
signal.signal(signal.SIGTERM, lambda *a: (os.kill(pid, 9), os._exit(1)))
src = [fd, 0]
while True:
    r, _, _ = select.select(src, [], [])
    if fd in r:
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        os.write(1, d)
    if 0 in r:
        d = os.read(0, 65536)
        if d: os.write(fd, d)
        else: src = [fd]
_, st = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 1)
`;

function havePty() {
  if (process.platform === "win32") return false;
  const r = spawnSync("python3", ["-c", "import pty, termios, fcntl"], { stdio: "ignore", timeout: 10000 });
  return r.status === 0;
}

/**
 * 在 pty 里起一趟 openworkbuddy。模型是本地假的：reply(messages) 说这一轮吐什么
 * （[工具名, 参数] 的数组，或者一句收工的话），可以是 async 的——想让它「想」多久由测试说了算。
 */
async function ptyRun({ args, reply }, drive) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-pty-"));
  const ws = path.join(home, "ws");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "a.txt"), "a\n");
  fs.writeFileSync(path.join(ws, "b.txt"), "b\n");
  const users = []; // 每一轮请求里最后那句用户话：模型到底收到了什么
  let n = 0;
  const llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      const msgs = body.messages || [];
      const u = msgs.filter((m) => m.role === "user").pop();
      users.push(u ? String(typeof u.content === "string" ? u.content : JSON.stringify(u.content)) : "");
      const r = await reply(msgs, n++);
      // 也可以回 { text, tools }：这一轮先说一段话再调工具
      const tools = Array.isArray(r) ? r : r && typeof r === "object" ? r.tools : null;
      const message = tools
        ? { role: "assistant", content: (r && r.text) || "", tool_calls: tools.map(([name, a], i) => ({ id: `c${n}_${i}`, type: "function", function: { name, arguments: JSON.stringify(a) } })) }
        : { role: "assistant", content: String(r) };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: tools ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    });
  });
  await new Promise((r) => llm.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${llm.address().port}/v1`;
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  cfg.provider = "openai";
  cfg.openai = { base_url: base, api_key: "k", model: "mock", stream: false };
  cfg.models = [{ name: "假模型", provider: "openai", base_url: base, api_key: "k", model: "mock", stream: false }];
  cfg.active_model = "假模型";
  cfg.agent = { ...(cfg.agent || {}), max_steps: 8, llm_retries: 0 };
  cfg.mcp_servers = [];
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg));

  const env = { ...process.env, OPENWORKBUDDY_HOME: home, OPENWORKBUDDY_CLI_LIVE: "1", NO_COLOR: "1", TERM: "xterm-256color" };
  delete env.FORCE_COLOR;
  const kid = spawn("python3", ["-c", BRIDGE, process.execPath, path.join(ROOT, "cli.js"), ...args, "-C", ws, "--no-mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let exited = null;
  kid.stdout.setEncoding("utf8");
  kid.stdout.on("data", (d) => (out += d));
  kid.stderr.on("data", (d) => (out += String(d)));
  const closed = new Promise((r) => kid.on("close", (c) => { exited = c; r(c); }));

  const t = {
    ws,
    home,
    users,
    out: () => out,
    /** 一块送进终端 */
    send: (s) => kid.stdin.write(s),
    /** 一个键一个键敲，像人手打的 */
    type: async (s) => { for (const ch of s) { kid.stdin.write(ch); await sleep(60); } },
    /** 等 from 之后的输出里出现 re */
    until: async (re, what, from = 0, ms = 45000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const i = out.slice(from).search(re);
        if (i >= 0) return from + i;
        if (exited !== null) break;
        await sleep(50);
      }
      throw new Error(`等「${what}」没等到${exited !== null ? `（进程已经退出：${exited}）` : ""}\n----屏幕----\n${out.slice(-3000)}`);
    },
    waitFor: async (fn, what, ms = 45000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (fn()) return; await sleep(50); }
      throw new Error(`等「${what}」没等到\n----屏幕----\n${out.slice(-3000)}`);
    },
    /** 手机上答这趟活儿里挂着的那道题：走 cli-live 那条真路子写进去 */
    phone: async (type, value) => {
      const dir = path.join(home, "data", "cli-live");
      let hit = null;
      await t.waitFor(() => {
        for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
          if (!f.endsWith(".ask.json")) continue;
          let arr = [];
          try { arr = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch {}
          const it = (Array.isArray(arr) ? arr : []).find((x) => x && x.type === type);
          if (it) { hit = { sid: f.slice(0, -".ask.json".length), id: it.id }; return true; }
        }
        return false;
      }, `手机上看得到那道${type}`);
      const r = spawnSync(process.execPath, ["-e", `process.exit(require(${JSON.stringify(path.join(ROOT, "cli-live"))}).answer(${JSON.stringify(hit.sid)}, ${JSON.stringify(hit.id)}, ${JSON.stringify(value)}) ? 0 : 1)`], { env, stdio: "inherit" });
      assert.strictEqual(r.status, 0, "手机那头写得进去");
    },
    exited: () => exited,
    closed,
  };
  const guard = setTimeout(() => kid.kill("SIGTERM"), 150000);
  try {
    await drive(t);
    await Promise.race([closed, atMost(20000)]);
  } finally {
    clearTimeout(guard);
    if (exited === null) { kid.kill("SIGTERM"); await Promise.race([closed, atMost(3000)]); }
    llm.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  return out;
}

/** 这一轮之前工具已经回过几次话 */
const toolsDone = (msgs) => msgs.filter((m) => m.role === "tool").length;
const MENU = /回车确定/;

async function run() {
  if (!havePty()) { console.log("cli-pty：跳过（这台机器没有 python3 的 pty）"); return; }

  // ---- ① 单发模式：单子出来之前敲的 a、粘进来的 yes，都不算点头 ----
  {
    let menuAt = 0;
    await ptyRun({
      args: ["帮我清理"],
      reply: async (msgs) => {
        const k = toolsDone(msgs);
        if (k === 0) { await sleep(300); return [["run_shell", { command: "rm a.txt", purpose: "清理" }]]; }
        if (k === 1) return [["run_shell", { command: "rm b.txt", purpose: "清理" }]];
        return "收工。";
      },
    }, async (t) => {
      // 进程刚起、模型还没回话就敲了个 a：它躺在终端缓冲区里，等单子一开 raw 模式就会被读到
      t.send("a");
      menuAt = await t.until(MENU, "第一张单子");
      await sleep(1200); // 过了护栏还是不动，才说明那个 a 没被认
      assert.ok(!/批了/.test(t.out().slice(menuAt)), "★单子出来之前敲的 a 不许放行★ 以前它等于「这类都允许」，后面的 rm 连卡片都不出\n" + t.out().slice(menuAt));
      assert.ok(fs.existsSync(path.join(t.ws, "a.txt")), "★rm 没跑★");
      t.send("yes 也行"); // 一块送进去：粘贴 / 输入法上屏
      await sleep(900);
      assert.ok(!/批了/.test(t.out().slice(menuAt)), "★一串字里打头的 y 不算点头★ 那是人在打一句话\n" + t.out().slice(menuAt));
      t.send("3");
      const deny = await t.until(/没批准/, "按 3 不允许", menuAt);
      // 正面对照：单子是活的，单独按一下 1 照样批——不然上面那几条「没放行」可能只是单子坏了
      const second = await t.until(MENU, "第二张单子", deny);
      await sleep(600);
      t.send("1");
      await t.until(/批了这一次/, "按 1 批了", second);
      await t.until(/收工/, "跑完", second);
    });
  }

  // ---- ② 交互模式：粘进来的不算点头；手机上批了，单子擦干净、通知留着 ----
  {
    await ptyRun({
      args: [],
      reply: async (msgs) => {
        const k = toolsDone(msgs);
        if (k === 0) return [["run_shell", { command: "rm a.txt", purpose: "清理" }]];
        if (k === 1) return [["run_shell", { command: "rm b.txt", purpose: "清理" }]];
        return "收工。";
      },
    }, async (t) => {
      await t.until(/openworkbuddy> /, "提示符");
      await t.type("帮我清理\r");
      const m1 = await t.until(MENU, "第一张单子");
      await sleep(900);
      t.send("yes, 顺便看下b");
      await sleep(900);
      assert.ok(!/批了/.test(t.out().slice(m1)), "★交互模式下一串字里的 y 也不算点头★\n" + t.out().slice(m1));
      assert.ok(fs.existsSync(path.join(t.ws, "a.txt")), "★rm 没跑★");
      t.send("3");
      const deny = await t.until(/没批准/, "按 3 不允许", m1);
      await t.until(MENU, "第二张单子", deny);
      await t.phone("approval", { allow: true, scope: "once" });
      const said = await t.until(/手机上答了/, "手机上答了", deny);
      const ok = await t.until(/批了这一次/, "手机批了", deny);
      // 单子是按「往上退几行」擦的：通知印在擦之前，擦掉的就是通知和单子下半截，上半截留在屏上
      const between = t.out().slice(said, ok);
      assert.ok(!/\x1b\[\d*A/.test(between), "★通知之后不许再往上擦★ 不然擦掉的是通知，单子上半截留在屏上\n" + JSON.stringify(t.out().slice(deny)));
      await t.waitFor(() => !fs.existsSync(path.join(t.ws, "b.txt")), "手机批的那条真跑了");
      await t.until(/收工/, "跑完", ok);
      await t.until(/openworkbuddy> /, "提示符回来", ok);
      await t.type("/exit\r");
    });
  }

  // ---- ③ 交互模式：跑着时敲的字接着打；手机答了提问，终端里那半句不当新任务 ----
  {
    let release = null;
    const held = new Promise((r) => (release = r));
    let t3 = null;
    await ptyRun({
      args: [],
      reply: async (msgs, i) => {
        if (i === 0) { await held; return "好了。"; } // 第一件事：测试说放才回话，这段时间里人在打字
        const last = msgs[msgs.length - 1];
        if (last && last.role === "user" && last.content === "abcd") return [["ask_user", { question: "用什么格式？", options: ["PDF", "Word"] }]];
        return "做完了。";
      },
    }, async (t) => {
      t3 = t;
      await t.until(/openworkbuddy> /, "提示符");
      await t.type("第一件事\r");
      await t.waitFor(() => t.users.length === 1, "第一件事发给模型");
      const typing = t.out().length;
      await t.type("abc");
      await t.until(/abc/, "敲的字回显", typing);
      release();
      const done1 = await t.until(/好了/, "第一件事做完");
      await t.until(/openworkbuddy> abc/, "没回车的字跟着提示符回来", done1);
      await t.type("d\r");
      await t.waitFor(() => t.users.length >= 2, "第二句发给模型");
      assert.strictEqual(t.users[1], "abcd", "★跑完接着打，字接在后面★ 以前光标回到行首，发出去的是 dabc");
      const menuAt = await t.until(/都不是，我自己打一句/, "提问的单子", done1);
      await sleep(500); // 刚摆出来那 0.4 秒按的数字不算
      t.send("3"); // 挑「自己打一句」
      const asked = await t.until(/答> /, "自己打一句的提示符", menuAt);
      await t.type("PD");
      await t.until(/PD/, "打了一半的答案回显", asked);
      await t.phone("ask", "Word");
      const picked = await t.until(/手机上答了/, "手机上答了", asked);
      await t.waitFor(() => /没发出去/.test(t.out().slice(asked)), "打了一半的那句被扔掉要说一声");
      await t.until(/做完了/, "第二件事做完", picked);
      // 单子上已经有这道题：再印一行「● Ask(题目)」、答完再挂一行「└ 回答」，就是同一件事说三遍
      assert.ok(!/● (Ask|ask_user)\b/.test(t.out()), "★弹了单子就不再印「● Ask(题目)」那行★\n" + t.out().slice(menuAt - 400));
      await t.until(/openworkbuddy> /, "提示符回来", picked);
      const before = t.users.length;
      await t.type("F\r");
      await t.waitFor(() => t.users.length > before, "第三句发给模型");
      assert.strictEqual(t.users[before], "F", "★手机答了之后，终端里打了一半的 PD 不许拼进下一条任务★");
      await t.type("/exit\r");
    });
    assert.ok(t3 && t3.exited() === 0, "正常退出");
  }

  // ---- ④ 正文渲染跨过工具那一行：上一步没换行的半句先吐干净，下一步的「## 标题」照样是标题 ----
  {
    const out = await ptyRun({
      args: ["看看 a.txt"],
      reply: (msgs) => (toolsDone(msgs) === 0
        ? { text: "先看一眼", tools: [["read_file", { path: "a.txt" }]] }
        : "## 结论\n文件里有 **一行**。"),
    }, async (t) => { await t.until(/一行。/, "第二步的正文"); });
    const lines = out.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
    assert.ok(lines.includes("结论"), "★下一步的「## 标题」渲染成标题★ 以前接在上一步没换行的半句后面，原样打出 ##\n" + out);
    assert.ok(!/##/.test(out), "## 不许原样上屏\n" + out);
    assert.ok(lines.includes("文件里有 一行。"), "标题下面那句照常渲染\n" + out);
    assert.ok(!lines.some((l) => /先看一眼./.test(l)), "上一步那半句单独成行，不跟后面的东西粘在一起\n" + out);
  }

  // ---- ⑤ 交互模式闲着的时候，网页 / 手机在同一条会话上聊了一轮：下一句开跑前先接上，不把那一轮盖掉 ----
  {
    const seen = []; // 每次发给模型的整段消息
    await ptyRun({
      args: [],
      reply: (msgs) => { seen.push(msgs.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content || ""))).join("\n")); return "好的。"; },
    }, async (t) => {
      await t.until(/openworkbuddy> /, "提示符");
      await t.type("第一句\r");
      const done1 = await t.until(/好的。/, "第一轮回答");
      await t.until(/openworkbuddy> /, "提示符回来", done1);
      const dir = path.join(t.home, "data", "sessions");
      const f = fs.readdirSync(dir).filter((x) => x.endsWith(".json")).map((x) => path.join(dir, x))[0];
      const disk = JSON.parse(fs.readFileSync(f, "utf8"));
      disk.history.push({ role: "user", content: "网页那句WEBMARK" }, { role: "assistant", text: "网页的回答" });
      disk.transcript.push({ type: "user", text: "网页那句WEBMARK" }, { type: "assistant", events: [{ type: "text", delta: "网页的回答" }] });
      fs.writeFileSync(f, JSON.stringify(disk));
      const n = seen.length;
      const mark = t.out().length;
      await t.type("第二句\r");
      await t.waitFor(() => seen.length > n, "第二句发给模型");
      assert.ok(seen[n].includes("网页那句WEBMARK"), "★闲着时网页聊的那一轮，下一句开跑前没接上★ 模型压根不知道那边说过什么\n" + seen[n].slice(-600));
      await t.until(/已经接上/, "说一声接上了", mark);
      const done2 = await t.until(/好的。/, "第二轮回答", mark);
      await t.until(/openworkbuddy> /, "提示符回来", done2);
      const users = JSON.parse(fs.readFileSync(f, "utf8")).transcript.filter((x) => x.type === "user").map((x) => x.text);
      assert.deepStrictEqual(users, ["第一句", "网页那句WEBMARK", "第二句"], "★网页那一轮被终端存盘盖掉了★");
      assert.ok(!fs.existsSync(path.join(dir, ".conflicts")), "轮流聊不算冲突，不该另存一份");
      await t.type("/exit\r");
    });
  }

  console.log("cli-pty：通过");
}

module.exports = { run };
if (require.main === module) run().catch((e) => { console.error(e); process.exit(1); });
