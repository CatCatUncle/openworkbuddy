// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 写完文件的语法自检不能把整个应用卡住。
 *
 * 跑法：node test/self-check.js
 * 临时数据目录，只起 node --check / python3 / bash -n 这种只读检查。
 *
 * 2026-09-28 实测：自检原来是 spawnSync，桌面版 server 跑在 Electron 主进程上，
 * 每查一个 .js 就冷启动一只 Electron 二进制（中位 ~200ms、最慢 430ms），整个应用陪着等。
 * 这里钉住：JS 进程内编译、外部检查异步且同时最多两个、结果跟原来一样准。每一组都配反向对照。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const { mod } = require("./lib/mod");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-selfcheck-"));
process.env.OPENWORKBUDDY_HOME = TMP;
process.env.OPENWORKBUDDY_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });

const ROOT = path.join(__dirname, "..");
const tools = require(mod("tools"));
const { selfCheck, extCheck, EXT_CHECK_MAX } = tools._internals;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (detail === undefined ? "" : "\n      " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).replace(/\n/g, "\n      "))); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 把 child_process 换成记账版：spawnSync 一调就炸，execFile 记下来再照常跑（或者按需扣住）
const realExecFile = cp.execFile;
const realSpawnSync = cp.spawnSync;
const calls = { sync: 0, exec: [] };
let hold = null; // 设成数组时，execFile 不真跑，回调先攒着
cp.spawnSync = function () { calls.sync++; throw new Error("spawnSync must not be called"); };
cp.execFile = function (cmd, args, opt, cb) {
  calls.exec.push({ cmd, args, env: opt && opt.env });
  if (hold) { hold.push(cb); return { pid: 0 }; }
  return realExecFile.call(cp, cmd, args, opt, cb);
};
const reset = () => { calls.sync = 0; calls.exec.length = 0; };

(async () => {
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), "owb-selfcheck-ws-"));
  tools.setWorkspaceDir(WS);
  const W = (rel, body) => { const p = path.join(WS, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
  const S1 = { sessionId: "s_one", actor: "alice", taskLabel: "测试" };
  const hasBin = (b) => { try { return realSpawnSync(b, ["--version"], { encoding: "utf8" }).status === 0; } catch { return false; } };

  console.log("\n① 源码守卫：自检里不许再出现同步起进程");
  {
    const src = fs.readFileSync(mod("tools"), "utf8");
    const at = src.indexOf("async function selfCheck(");
    const body = at >= 0 ? src.slice(at, src.indexOf("\n}\n", at)) : "";
    const helpers = src.slice(src.indexOf("function execCheck("), src.indexOf("async function selfCheck("));
    const syncRe = /spawnSync|execFileSync|execSync/;
    ok(at >= 0 && body.length > 500, "selfCheck 是 async 函数", at);
    ok(!syncRe.test(body) && !syncRe.test(helpers), "selfCheck 和它的帮手里没有 spawnSync/execSync");
    ok(syncRe.test("x = spawnSync(process.execPath)"), "守卫的正则确实认得出 spawnSync（反向对照：别是个永远不响的守卫）");
    const allAwaited = (s) => { const m = s.match(/[=(]\s*(await\s+)?selfCheck\(/g) || []; return { n: m.length, ok: m.every((x) => /await/.test(x)) }; };
    const sites = allAwaited(src);
    ok(sites.n >= 4 && sites.ok, "四个调用点全都 await（不 await 拿到的是 Promise，c.bad 永远是 undefined）", sites);
    const slip = allAwaited("const c = await selfCheck(p, rel);\nconst d = selfCheck(p, rel, true);");
    ok(slip.n === 2 && !slip.ok, "漏写一处 await 会被同一个判据抓到（反向对照）", slip);
  }

  console.log("\n② JS：进程内查，跟 node --check 一样准");
  {
    reset();
    const good = W("good.js", "const a = 1;\nmodule.exports = { a };\n");
    let r = await selfCheck(good, "good.js");
    ok(!r.bad && r.note === "", "合法 CJS 过", r);
    const broken = W("bad.js", "const a = 1;\nfoo(\nlet x = ;\n");
    r = await selfCheck(broken, "bad.js");
    ok(r.bad && /JS 语法没过/.test(r.note) && /bad\.js:3/.test(r.note) && /missing \) after argument list/.test(r.note), "写错的 JS 报错，带文件名、行号、原因（跟 node --check 同一格式）", r.note);
    ok(!/^\s*at /m.test(r.note), "调用栈那几行不贴给模型", r.note);
    ok(calls.sync === 0 && calls.exec.length === 0, "CJS 这两次一个进程都没起", calls);
    const want = realSpawnSync(process.execPath, ["--check", broken], { encoding: "utf8" });
    ok(want.status !== 0 && /missing \) after argument list/.test(want.stderr), "同一个文件真跑 node --check 也是这条错（反向对照：两边判得一样）", want.stderr);

    const hb = W("cli.js", "#!/usr/bin/env node\nif (!process.argv[2]) return;\nconsole.log(1);\n");
    r = await selfCheck(hb, "cli.js");
    ok(!r.bad, "shebang + 顶层 return：CJS 模块包装下是合法的，照样放过", r);
    const tl = W("tl.js", "const s = `abc");
    r = await selfCheck(tl, "tl.js", true);
    ok(!r.bad, "续写到一半（模板字符串还没闭）不算错", r);
    r = await selfCheck(tl, "tl.js");
    ok(r.bad && /Unexpected end of input|Unterminated/.test(r.note), "同一份整篇写完还没闭：报错（反向对照）", r.note);
    ok(calls.exec.length === 0, "以上都没起进程", calls.exec);
  }

  console.log("\n③ ESM：CJS 过不去再异步交给 node --check，报的是用户那个文件");
  {
    reset();
    const esm = W("m.js", "import fs from 'fs';\nexport const a = fs.existsSync('.');\n");
    let r = await selfCheck(esm, "m.js");
    ok(!r.bad, "合法 ESM 写在 .js 里：放过", r);
    ok(calls.exec.length === 1 && calls.exec[0].cmd === process.execPath && calls.exec[0].env && calls.exec[0].env.ELECTRON_RUN_AS_NODE === "1", "只起一次，异步，带 ELECTRON_RUN_AS_NODE", calls.exec);
    ok(calls.sync === 0, "没走 spawnSync", calls.sync);
    reset();
    const esmBad = W("mb.js", "import fs from 'fs';\nexport const a = ;\n");
    r = await selfCheck(esmBad, "mb.js");
    ok(r.bad && r.note.includes(esmBad) && !/syntax-\d+/.test(r.note) && /Unexpected token/.test(r.note), "ESM 真写错：报 ESM 那条，路径换回用户的文件", r.note);
    const left = fs.existsSync(path.join(WS, ".tmp")) ? fs.readdirSync(path.join(WS, ".tmp")).filter((n) => /^syntax-/.test(n)) : [];
    ok(left.length === 0, "临时 .mjs 用完就删", left);
    reset();
    hold = [];
    const pending = selfCheck(esm, "m.js");
    await wait(20);
    const cb = hold.shift();
    hold = null;
    cb(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), "", "");
    r = await pending;
    ok(!r.bad, "兜底检查根本没跑成（ENOENT）：不下结论，不报成语法错", r);
    reset();
    const mjs = W("x.mjs", "export default 1;\n");
    r = await selfCheck(mjs, "x.mjs");
    ok(!r.bad && calls.exec.length === 1, ".mjs 直接按 ESM 查（一次异步检查）", calls.exec);
  }

  console.log("\n④ .py / .sh：异步检查，结果照旧");
  {
    reset();
    if (hasBin("python3") || hasBin("python")) {
      const pyOk = W("a.py", "def f(x):\n    return x + 1\n");
      let r = await selfCheck(pyOk, "a.py");
      ok(!r.bad, "合法 Python 过", r);
      const pyBad = W("b.py", "def f(x)\n    return x\n");
      r = await selfCheck(pyBad, "b.py");
      ok(r.bad && /Python 语法没过/.test(r.note), "写错的 Python 报错（反向对照）", r.note);
    } else {
      console.log("  - 本机没有 python，跳过 Python 真检查");
    }
    const shBad = W("c.sh", "if true; then\n  echo x\n");
    let r = await selfCheck(shBad, "c.sh");
    ok(r.bad && /Shell 脚本语法没过/.test(r.note), "写错的 shell 报错", r.note);
    const shOk = W("d.sh", "if true; then\n  echo x\nfi\n");
    r = await selfCheck(shOk, "d.sh");
    ok(!r.bad, "合法 shell 过（反向对照）", r);
    ok(calls.sync === 0 && calls.exec.length >= 2, "全程 execFile，没有 spawnSync", calls);
  }

  console.log("\n⑤ 同时最多两个外部检查");
  {
    reset();
    hold = [];
    let peak = 0;
    const files = Array.from({ length: 6 }, (_, i) => W(`p${i}.sh`, "echo ok\n"));
    const all = files.map((f, i) => selfCheck(f, `p${i}.sh`));
    const tick = setInterval(() => { peak = Math.max(peak, extCheck.running); }, 1);
    await wait(30);
    ok(extCheck.running === EXT_CHECK_MAX && calls.exec.length === EXT_CHECK_MAX && EXT_CHECK_MAX === 2, "六个一起来，只起了两个，其余排队", { running: extCheck.running, started: calls.exec.length, queued: extCheck.queue.length });
    ok(extCheck.queue.length === 4, "剩下四个在排队", extCheck.queue.length);
    // 一个一个放行：每放一个，排队的顶上一个
    while (hold.length) {
      const cb = hold.shift();
      cb(null, "", "");
      await wait(5);
    }
    const res = await Promise.all(all);
    clearInterval(tick);
    hold = null;
    ok(res.every((r) => !r.bad) && calls.exec.length === 6, "六个最后都查完了，一个没丢", { n: calls.exec.length });
    ok(peak <= EXT_CHECK_MAX, "全程在跑的从没超过两个", peak);
    ok(extCheck.running === 0 && extCheck.queue.length === 0, "跑完计数归零，队列清空（反向对照：没有漏记的名额）", extCheck);
  }

  console.log("\n⑥ 不卡事件循环");
  {
    reset();
    const lines = [];
    for (let i = 0; lines.join("\n").length < 200 * 1024; i++) lines.push(`function f${i}(a, b) { const x = a * ${i} + b; return { x, s: "item-${i}" }; }`);
    const big = W("big.js", lines.join("\n") + "\nmodule.exports = {};\n");
    const gaps = async (fn) => {
      let last = Date.now(), max = 0;
      const t = setInterval(() => { const n = Date.now(); max = Math.max(max, n - last); last = n; }, 5);
      await wait(20);
      await fn();
      await wait(20);
      clearInterval(t);
      return max;
    };
    const g = await gaps(async () => { for (let i = 0; i < 5; i++) await selfCheck(big, "big.js"); });
    ok(g < 50, `200KB 的 JS 连查五遍，事件循环最长停 ${g}ms（< 50ms）`, g);
    const stall = await gaps(async () => { const t0 = Date.now(); while (Date.now() - t0 < 80); });
    ok(stall >= 70, `探针看得见真卡顿：同步忙等 80ms 量出 ${stall}ms（反向对照）`, stall);
  }

  console.log("\n⑦ 走完整的 write_file：await 之后 isError 才对得上");
  {
    let r = await tools.executeTool("write_file", { path: "w/bad.js", content: "const a = ;\n" }, S1);
    ok(r.isError === true && /JS 语法没过/.test(r.content), "写坏的 JS：isError=true，错误顶回去", r.content);
    r = await tools.executeTool("write_file", { path: "w/good.js", content: "const a = 1;\n" }, S1);
    ok(r.isError === false && !/语法没过/.test(r.content), "写好的 JS：isError=false（反向对照）", r.content);
    r = await tools.executeTool("edit_file", { path: "w/good.js", old_text: "const a = 1;", new_text: "const a = ;" }, S1);
    ok(r.isError === true && /JS 语法没过/.test(r.content), "edit_file 改坏了一样顶回去", r.content);
    ok(calls.sync === 0, "全程没有 spawnSync", calls.sync);
  }

  console.log("\n⑧ 只有 ESM 才合法的写法（顶层 await、import.meta、for await……）：放过，不报语法错");
  {
    // 2026-09-29 复审实测：这几种 .js 行首没有 import/export，原来一律被报「JS 语法没过」；
    // 换成进程内编译之前走的 node --check 会自己探测成 ESM，都是放行的
    const vm = require("vm");
    const cjsErr = (s) => { try { vm.compileFunction(s, ["exports", "require", "module", "__filename", "__dirname"]); return ""; } catch (e) { return String(e.message); } };
    const oldTrigger = /^\s*(import|export)\s/m; // 改之前唯一会触发「按 ESM 再判」的条件
    W("esm-pkg/package.json", JSON.stringify({ type: "module" }));
    const cases = [
      ["esm-pkg/tla.js", "const r = await Promise.resolve(1);\nconsole.log(r);\n"],
      ["tla-nopkg.js", "await new Promise((r) => setTimeout(r, 1));\n"],
      ["meta.js", "console.log(import.meta.url);\n"],
      ["for-await.js", "for await (const x of [1]) console.log(x);\n"],
      ["dirname.js", "const __dirname = new URL('.', import.meta.url).pathname;\nconsole.log(__dirname);\n"],
    ];
    // await using 是新语法：CI 上的 Node 22 还不认，那边按 ESM 也过不去，只在认得它的 Node 上查
    const hasUsing = (() => { try { new Function("return async () => { await using x = null; }"); return true; } catch { return false; } })();
    if (hasUsing) cases.push(["await-using.js", "await using x = null;\nconsole.log(x);\n"]);
    else console.log("  - 这个 Node 不认 await using，跳过那一条");
    for (const [rel, body] of cases) {
      reset();
      const f = W(rel, body);
      const r = await selfCheck(f, rel);
      const e = cjsErr(body);
      ok(!r.bad && calls.exec.length === 1 && calls.sync === 0, `${rel}：放过，只多起一次异步检查`, { note: r.note, exec: calls.exec.length });
      ok(e && !oldTrigger.test(body), `  └ ★反向对照★ 按 CJS 编译确实报错（${e.slice(0, 50)}），行首也没有 import/export——改之前这条就是被当成写错的`, e);
    }
    const tla = path.join(WS, "esm-pkg", "tla.js");
    const want = realSpawnSync(process.execPath, ["--check", tla], { encoding: "utf8" });
    ok(want.status === 0, "  └ 同一个 type:module 里的文件真跑 node --check 也过（两边判得一样）", want.stderr);

    reset();
    const cjsTla = W("tla.cjs", "const r = await Promise.resolve(1);\n");
    let r = await selfCheck(cjsTla, "tla.cjs");
    ok(r.bad && /await is only valid/.test(r.note) && calls.exec.length === 0, "★反向对照★ 同样的顶层 await 写在 .cjs 里：永远按 CJS，照报，也不起进程", { note: r.note, exec: calls.exec.length });
    reset();
    const inner = W("inner-await.js", "function f() {\n  await g();\n}\n");
    r = await selfCheck(inner, "inner-await.js");
    ok(r.bad && r.note.includes(inner) && /await/.test(r.note), "★反向对照★ 普通函数里写 await（真写错了）：按 ESM 再判也不过，照报，报的是用户那个文件", r.note);
    reset();
    const plain = W("plain-bad.js", "const x = {a:1,,};\n");
    r = await selfCheck(plain, "plain-bad.js");
    ok(r.bad && calls.exec.length === 0, "★反向对照★ 普通写错（多了个逗号）报错里没有那几个词：照样零进程当场报", { note: r.note, exec: calls.exec.length });
  }

  cp.execFile = realExecFile;
  cp.spawnSync = realSpawnSync;
  try { fs.rmSync(WS, { recursive: true, force: true }); fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
