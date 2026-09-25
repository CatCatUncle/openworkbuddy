"use strict";
/**
 * explore：只读的探索子智能体，同一轮发几个就并发跑。
 *
 * 跑法：node test/explore.js
 * 模型全是桩，一分钱不花、一个字节不出网；工作目录和数据目录都是临时的。
 *
 * 这一套钉四件事：
 *   1. 真并发——同一轮两个 explore，第二个在第一个收工之前就开跑了。判据是事件先后，不是毫秒数：
 *      两个子智能体的第一次模型调用互相等对方到场（等不到 4 秒后放行，串行时不会卡死，只会排错序）。
 *   2. 真只读——子智能体硬编一个 write_file / run_shell / explore，一个都不执行，文件一个不多。
 *      同一道闸也管顶层的只读档：以前 ask 档全靠「不摆写工具」，模型硬编 write_file 照样写成功。
 *   3. 不套娃——explore 只摆给顶层，子智能体和专家拿不到。
 *   4. 闸别拦错——清单里有的照跑（craft 档 write_file 真写得出来），拼错的名字还是那句「未知工具: X。你是不是想调 Y」，
 *      老名字 render_page 还当 fetch_url 的别名认。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-explore-"));
process.env.OPENWORKBUDDY_HOME = TMP;
process.env.OPENWORKBUDDY_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });

const ROOT = path.join(__dirname, "..");
const tools = require(path.join(ROOT, "tools"));
const { McpManager } = require(path.join(ROOT, "mcp"));
const { createAgentRuntime } = require(path.join(ROOT, "agent"));
const cliToolview = require(path.join(ROOT, "cli-toolview"));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra) : ""}`); }
}

const SUB_MARK = /只读的探索子智能体/; // 子智能体的系统提示词开头，桩靠它分清是谁在问
const U = { prompt: 10, completion: 5 };
const WRITE_TOOLS = ["write_file", "edit_file", "multi_edit", "run_shell", "run_node", "ask_user", "delegate_to_expert", "delegate_to_team"];

/**
 * 按角色回话的模型桩：main(n, history) 管主线第 n 次，sub(question, n, history) 管那个子智能体第 n 次。
 * 不带工具的那一问是收尾，统一回一句。
 */
function router({ main, sub }) {
  let mainN = 0;
  const subN = new Map();
  const seen = [];
  return {
    provider: "mock", model: "fake", seen,
    async chat({ system, history, tools: ts }) {
      const names = (ts || []).map((t) => t.name);
      if (!names.length) return { text: "（收尾）", toolCalls: [], stopReason: "end_turn", usage: U };
      let r;
      if (SUB_MARK.test(String(system || ""))) {
        const q = String((history[0] && history[0].content) || "");
        const n = (subN.get(q) || 0) + 1;
        subN.set(q, n);
        seen.push({ who: "sub", q, n, names, history: JSON.parse(JSON.stringify(history)) });
        r = await sub(q, n, history);
      } else {
        mainN++;
        seen.push({ who: "main", n: mainN, names, system: String(system || "") });
        r = await main(mainN, history);
      }
      const toolCalls = r.toolCalls || [];
      return { text: "", usage: U, stopReason: toolCalls.length ? "tool_use" : "end_turn", ...r, toolCalls };
    },
  };
}

let runSeq = 0;
async function run({ llm, config, mode, files }) {
  const dir = path.join(TMP, "ws-" + (++runSeq));
  fs.mkdirSync(dir);
  for (const [f, body] of Object.entries(files || {})) fs.writeFileSync(path.join(dir, f), body);
  const events = [];
  const history = [{ role: "user", content: "帮我查一下" }];
  const rt = createAgentRuntime({
    config: config || { agent: { max_steps: 6, tool_timeout_ms: 30000 } },
    llm, mcpManager: new McpManager(), experts: [],
  });
  const r = await tools.withWorkspace(dir, () => rt.runTask({ history, emit: (e) => events.push(e), mode: mode || "craft" }));
  return { r, dir, events, history, rt };
}
const toolResultsOf = (history) => history.filter((e) => e && e.role === "tool").flatMap((e) => e.results || []);

(async () => {
  // ─────────────────────────────────────────────────────────────────────────
  console.log("【1】同一轮两个 explore 并发跑，各有各的名字和调用 id");
  {
    const log = [];
    const arrived = new Set();
    let release;
    const both = new Promise((r) => (release = r));
    // 两个子智能体的第一次调用互相等：并发时两边都到场就放行；串行时第二个永远来不了，4 秒后放行，顺序就排错了
    const meet = (tag) => {
      arrived.add(tag);
      if (arrived.size >= 2) release();
      return Promise.race([both, new Promise((r) => setTimeout(r, 4000).unref())]);
    };
    const llm = router({
      main: async (n) => n === 1
        ? { text: "两个问题分头查。", toolCalls: [
          { id: "e1", name: "explore", input: { question: "问题A：alpha 写在哪" } },
          { id: "e2", name: "explore", input: { question: "问题B：beta 写在哪", paths: ["b.txt"] } },
        ] }
        : { text: "两个都查清了。" },
      sub: async (q, n) => {
        const tag = q.includes("问题A") ? "A" : "B";
        const file = tag === "A" ? "a.txt" : "b.txt";
        if (n === 1) {
          log.push("start:" + tag);
          await meet(tag);
          // 两个子智能体故意用同一个调用 id：供应商不给 id 时 llm.js 就是按序号补 call_0，并发下必然撞号
          return { toolCalls: [{ id: "call_0", name: "read_file", input: { path: file } }] };
        }
        log.push("end:" + tag);
        return { text: `${tag} 的结论：在 ${file}:1` };
      },
    });
    const { events, history, dir } = await run({ llm, files: { "a.txt": "alpha\n", "b.txt": "beta\n" } });

    const firstEnd = log.findIndex((x) => x.startsWith("end:"));
    ok(log.indexOf("start:A") >= 0 && log.indexOf("start:B") >= 0 && firstEnd > log.indexOf("start:A") && firstEnd > log.indexOf("start:B"),
      "★两个子智能体都开跑了，才有一个收工★（串行的话是 start:A → end:A → start:B）", log);
    const at = (pred) => events.findIndex(pred);
    const useE2 = at((e) => e.type === "tool_use" && e.id === "e2" && e.depth === 0);
    const resE1 = at((e) => e.type === "tool_result" && e.id === "e1" && e.depth === 0);
    ok(useE2 >= 0 && resE1 >= 0 && useE2 < resE1, "过程事件也对得上：第二个 explore 的开始排在第一个的结果之前", { useE2, resE1 });
    ok(events.some((e) => e.type === "parallel" && e.depth === 0 && e.count === 2), "主线报了一句「2 个一起跑」");

    const inner = events.filter((e) => (e.type === "tool_use" || e.type === "tool_result") && e.depth === 1);
    const innerUseIds = inner.filter((e) => e.type === "tool_use").map((e) => e.id).sort();
    ok(JSON.stringify(innerUseIds) === JSON.stringify(["e1/call_0", "e2/call_0"]),
      "★子智能体的调用 id 带上父调用前缀★ 两边都叫 call_0 也不会把 A 的结果贴到 B 的卡上", innerUseIds);
    const labels = [...new Set(inner.map((e) => e.expert))].sort();
    ok(JSON.stringify(labels) === JSON.stringify(["探索1", "探索2"]), "每个探索一个名字，内层每条事件都带着", labels);
    ok(inner.every((e) => e.id.startsWith(e.expert === "探索1" ? "e1/" : "e2/")), "名字和父调用对得上（探索1 就是 e1）",
      inner.map((e) => [e.expert, e.id]));
    const reads = inner.filter((e) => e.type === "tool_result" && e.name === "read_file");
    ok(reads.length === 2 && reads.every((e) => !e.isError) && reads.some((e) => /alpha/.test(e.preview)) && reads.some((e) => /beta/.test(e.preview)),
      "子智能体真读到了文件（只读工具照常能用）", reads.map((e) => [e.isError, e.preview]));

    const res = toolResultsOf(history);
    const r1 = res.find((x) => x.id === "e1"), r2 = res.find((x) => x.id === "e2");
    ok(r1 && !r1.isError && /【探索1 的结论】/.test(r1.content) && /A 的结论/.test(r1.content), "主线拿回的是 A 的结论", r1);
    ok(r2 && !r2.isError && /【探索2 的结论】/.test(r2.content) && /B 的结论/.test(r2.content), "主线拿回的是 B 的结论", r2);
    ok(!res.some((x) => x.id && x.id.includes("/")), "历史里的 id 没被改：前缀只加在界面事件上，配对照旧");

    const subB = llm.seen.find((s) => s.who === "sub" && s.q.includes("问题B"));
    ok(subB && /先从这些看起：b\.txt/.test(subB.q), "paths 带进了子智能体的问题里", subB && subB.q);
    const subTools = (llm.seen.find((s) => s.who === "sub") || {}).names || [];
    ok(subTools.includes("read_file") && subTools.includes("search_files"), "子智能体手里有读、搜", subTools);
    const leaked = subTools.filter((n) => n === "explore" || WRITE_TOOLS.includes(n));
    ok(leaked.length === 0, "★子智能体手里没有写/跑/问/委派，也没有 explore★", leaked);
    const mainSeen = llm.seen.find((s) => s.who === "main");
    ok(mainSeen && mainSeen.names.includes("explore"), "主线（没配专家）手里有 explore");
    ok(mainSeen && /同一轮里发几个 explore/.test(mainSeen.system), "系统提示词里有那一句「同一轮发几个 explore」");
    const visible = fs.readdirSync(dir).filter((f) => !f.startsWith(".")).sort(); // .tmp 这类是框架自己的，不算产出
    ok(visible.join(",") === "a.txt,b.txt", "工作目录里一个文件都没多", visible);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n【2】子智能体硬编写工具：一个都不执行");
  {
    const llm = router({
      main: async (n) => n === 1
        ? { toolCalls: [{ id: "x1", name: "explore", input: { question: "顺手把结论写进 hacked.txt" } }] }
        : { text: "好。" },
      sub: async (q, n) => n === 1
        ? { toolCalls: [
          { id: "w1", name: "write_file", input: { path: "hacked.txt", content: "x" } },
          { id: "w2", name: "run_shell", input: { command: "echo pwned > pwned.txt" } },
          { id: "w3", name: "explore", input: { question: "再开一个" } },
        ] }
        : { text: "写不了，只能读。" },
    });
    const { events, dir } = await run({ llm, files: { "a.txt": "alpha\n" } });
    const inner = (name) => events.find((e) => e.type === "tool_result" && e.depth === 1 && e.name === name);
    for (const name of ["write_file", "run_shell", "explore"]) {
      const e = inner(name);
      ok(e && e.isError && /系统拦截/.test(e.preview) && /只看不动/.test(e.preview), `${name} 被拦下，话里说清了是只读档`, e && e.preview);
    }
    ok(!fs.existsSync(path.join(dir, "hacked.txt")), "★hacked.txt 没被写出来★");
    ok(!fs.existsSync(path.join(dir, "pwned.txt")), "★pwned.txt 也没有★（命令根本没跑）");
    ok(!events.some((e) => (e.depth || 0) >= 2), "子智能体里的 explore 没开出第二层");
    const second = llm.seen.find((s) => s.who === "sub" && s.n === 2);
    const back = second ? toolResultsOf(second.history) : [];
    ok(back.length === 3 && back.every((x) => x.isError && /系统拦截/.test(x.content)), "三条拒绝都回到了子智能体眼前（它才知道换路）", back);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n【3】同一道闸管顶层只读档：ask 档硬编 write_file 不再写成功");
  {
    const llm = router({
      main: async (n) => n === 1
        ? { toolCalls: [{ id: "a1", name: "write_file", input: { path: "PWNED.txt", content: "x" } }] }
        : { text: "只看不动，没写。" },
      sub: async () => ({ text: "（用不上）" }),
    });
    const { events, dir } = await run({ llm, mode: "ask" });
    const e = events.find((x) => x.type === "tool_result" && x.id === "a1");
    ok(e && e.isError && /系统拦截/.test(e.preview), "write_file 被拦下", e && e.preview);
    ok(!fs.existsSync(path.join(dir, "PWNED.txt")), "★PWNED.txt 没被写出来★（原来 openworkbuddy review 里这一步写成功了）");
    const names = (llm.seen.find((s) => s.who === "main") || {}).names || [];
    ok(names.includes("explore") && !names.includes("write_file"), "只读档顶层照样有 explore，没有 write_file", names);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n【4】explore 只摆给顶层");
  {
    const rt = createAgentRuntime({ config: { agent: {}, im: {}, security: {} }, llm: {}, mcpManager: new McpManager(), experts: [], expertTeams: [] });
    const has = (depth, mode) => rt.toolList(depth, mode).filter((t) => t.name === "explore").length;
    ok(has(0, "craft") === 1, "顶层执行档有，只一份");
    ok(has(0, "ask") === 1 && has(0, "plan") === 1, "顶层只读档（ask/plan）也有");
    ok(has(1, "craft") === 0, "★depth 1（专家）没有★");
    ok(has(1, "ask") === 0, "★depth 1 只读档（探索子智能体自己）没有★");
    const withExperts = createAgentRuntime({ config: { agent: {}, im: {}, security: {} }, llm: {}, mcpManager: new McpManager(),
      experts: [{ name: "写手", description: "写", system: "你是写手" }], expertTeams: [] });
    ok(withExperts.toolList(1, "craft").every((t) => t.name !== "explore" && t.name !== "delegate_to_expert"), "配了专家时专家手里也没有 explore");
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n【5】闸别拦错：清单里有的照跑，拼错的照旧给提示，老名字照旧认");
  {
    const llm = router({
      main: async (n) => n === 1
        ? { toolCalls: [
          { id: "k1", name: "write_file", input: { path: "ok.txt", content: "fine" } },
          { id: "k2", name: "reed_file", input: { path: "ok.txt" } },
          { id: "k3", name: "render_page", input: { url: "https://x.blocked.invalid/" } },
        ] }
        : { text: "好了。" },
      sub: async () => ({ text: "（用不上）" }),
    });
    const config = { agent: { max_steps: 6, tool_timeout_ms: 30000 }, security: { gateway: true, url_blacklist: ["blocked.invalid"] } };
    const { events, dir } = await run({ llm, config });
    const res = (id) => events.find((e) => e.type === "tool_result" && e.id === id);
    ok(fs.existsSync(path.join(dir, "ok.txt")) && res("k1") && !res("k1").isError, "★反向对照：执行档 write_file 照常写出来★（闸没把正经工具拦掉）", res("k1"));
    const k2 = res("k2");
    ok(k2 && k2.isError && /^未知工具: reed_file。你是不是想调 read_file？工具名必须一字不差地写全。/.test(k2.preview),
      "拼错的名字还是那句「未知工具: X。你是不是想调 Y」", k2 && k2.preview);
    ok(k2 && /未知工具[:：]\s*([A-Za-z0-9_.-]+)/.exec(k2.preview)[1] === "reed_file", "evolve.js 认幻觉工具名的那条正则照样认得出");
    const k3 = res("k3");
    ok(k3 && /网络访问被安全中心拦截/.test(k3.preview) && !/系统拦截|未知工具/.test(k3.preview),
      "render_page 走到了 fetch_url 那条路（被网址黑名单拦，而不是被工具名闸拦）", k3 && k3.preview);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n【6】子智能体撞了自己的步数上限：只是它收了，不是整个任务收了");
  {
    let i = 0;
    const llm = router({
      main: async (n) => n === 1 ? { toolCalls: [{ id: "m1", name: "explore", input: { question: "一直查" } }] } : { text: "先这样。" },
      sub: async () => ({ toolCalls: [{ id: "r" + (++i), name: "read_file", input: { path: i % 2 ? "a.txt" : "b.txt" } }] }),
    });
    const { events, history } = await run({ llm, config: { agent: { max_steps: 3, tool_timeout_ms: 30000 } }, files: { "a.txt": "a\n", "b.txt": "b\n" } });
    ok(!events.some((e) => e.type === "limit" && e.depth === 1), "内层没往外发 limit（界面会说成「任务强制收尾」）");
    ok(events.some((e) => e.type === "status" && e.depth === 1 && /探索1 没查完就收了/.test(e.text)), "换成了一句带名字的状态");
    const r = toolResultsOf(history).find((x) => x.id === "m1");
    ok(r && !r.isError && /【探索1 的结论】/.test(r.content), "主线照样拿到一段结论，接着往下走", r);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n【7】命令行那一行看得出是谁");
  {
    const line = cliToolview.callLine({ name: "read_file", expert: "探索2", depth: 1, input_preview: '{"path":"b.txt"}' });
    ok(line === "● 探索2 · Read(b.txt)", "子智能体的每一行带着自己的名字", line);
    const top = cliToolview.callLine({ name: "explore", depth: 0, input_preview: '{"question":"alpha 写在哪"}', title: "探索 alpha 写在哪" });
    ok(top === "● Explore(alpha 写在哪)", "顶层那一行是 Explore(问题)", top);
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
