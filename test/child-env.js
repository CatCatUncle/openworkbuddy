// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 子进程只拿最小环境变量（src/platform/child-env.js）。
 *
 * 跑法：node test/child-env.js
 * 全离线：临时家、临时 HOME，假 Key 一律 sk-test-*，「外部引擎」是自己写的 sh 脚本和 node -e。
 *
 * 要守住的事：用户 shell 里 export 的 OPENAI_API_KEY、Docker 给渠道配的 OPENWORKBUDDY_KEY_*，
 * AI 跑的命令、脚本、后台命令、钩子、连接器、外部引擎一个都拿不到——拿到了就能绕开模型白名单和企业限额直连厂商。
 * 属主清单：单人时写了就给（Key 类也给），账号一多 Key 类写了也不给；连接器（MCP）不吃清单。
 *
 *   【1】纯函数：白名单、Key 兜底、属主清单两种模式、调用方 extra、Windows 大小写
 *   【2】策略注册：没注册 = 收紧；注册了每次现问；读挂了 = 收紧
 *   【3】几个账号：admin.multiUser 从一个到多个、读坏了按多个算
 *   【4】真起子进程：run_shell / run_node / 后台命令 / 钩子 / MCP / 引擎 runJsonl / Codex 引擎
 *   【5】接线：服务端和命令行都注册了策略、设置页存得进、界面找得到、英文有译文
 */
const fs = require("fs");
const path = require("path");
const { mod } = require("./lib/mod");
const OWN = require("./lib/own-home")("child-env");

// 要赶在 require 任何源码之前：审计、账号库都落临时家；HOME 也换成临时的——
// 这样 zsh 读不到真用户的 ~/.zshenv，Codex 引擎也找不到真的 ~/.codex
process.env.OPENWORKBUDDY_DATA_DIR = path.join(OWN, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });
const FAKE_HOME = path.join(OWN, "home");
fs.mkdirSync(FAKE_HOME, { recursive: true });
process.env.HOME = FAKE_HOME;
process.env.CODEX_HOME = path.join(OWN, "codex-src");

const CE = require(mod("child-env"));

// 外面终端里要是真有 Key（跑测试的人自己 export 的），先从本进程摘掉：
// 万一哪条没拦住，落进现场文件的也只是下面这几把假的
for (const k of Object.keys(process.env)) if (CE.keyLike(k)) delete process.env[k];
const FAKE_KEYS = { OPENAI_API_KEY: "sk-test-x", ANTHROPIC_API_KEY: "sk-test-y", OPENWORKBUDDY_KEY_FOO: "1", npm_config__authToken: "sk-test-npm" };
Object.assign(process.env, FAKE_KEYS, {
  OWB_CE_PLAIN: "plain-1",          // 普通变量：不在白名单里，属主清单写了才给
  LC_OWB_CE: "lc-1",                // 白名单前缀 LC_ 那一族
  SSH_AUTH_SOCK: path.join(OWN, "fake-agent.sock"), // 只在单人时给
});

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail).slice(0, 600))); }
};
const section = (t) => console.log("\n" + t);
const names = (env) => new Set(Object.keys(env || {}));
const noKeys = (set) => Object.keys(FAKE_KEYS).filter((k) => set.has(k));
/** printenv 的输出 → 变量名集合（值里带换行的那几个只会多认出几行杂的，不影响判名字在不在） */
const parsePrintenv = (text) => {
  const o = {};
  for (const line of String(text || "").split("\n")) { const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line); if (m) o[m[1]] = m[2]; }
  return o;
};
const waitFor = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
};
const readIf = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };

(async () => {
  CE.setPolicy(null);

  section("【1】纯函数");
  {
    const base = {
      PATH: "/usr/bin", HOME: "/h", LANG: "zh_CN.UTF-8", LC_ALL: "C", TMPDIR: "/t", TZ: "Asia/Shanghai",
      OPENWORKBUDDY_HOME: "/d", OPENWORKBUDDY_BRIDGE_X: "b", npm_config_registry: "http://127.0.0.1:9/", JAVA_HOME: "/j",
      OPENWORKBUDDY_KEY_FOO: "1", OPENAI_API_KEY: "sk-test-x", ANTHROPIC_API_KEY: "sk-test-y", GITHUB_TOKEN: "sk-test-gh",
      AWS_SECRET_ACCESS_KEY: "sk-test-aws", npm_config__authToken: "sk-test-npm", DB_PASSWORD: "sk-test-pw", OPENAI_KEY: "sk-test-k",
      RANDOM_THING: "r", SSH_AUTH_SOCK: "/s", NODE_OPTIONS: "--require /evil.js",
    };
    const KEYISH = ["OPENWORKBUDDY_KEY_FOO", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "npm_config__authToken", "DB_PASSWORD", "OPENAI_KEY"];
    const d = names(CE.buildChildEnv(null, { base }));
    ok(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TZ", "OPENWORKBUDDY_HOME", "OPENWORKBUDDY_BRIDGE_X", "npm_config_registry", "JAVA_HOME"].every((k) => d.has(k)),
      "白名单和白名单前缀照给（PATH / HOME / LC_* / OPENWORKBUDDY_* / npm_config_*）", [...d]);
    ok(KEYISH.every((k) => !d.has(k)), "像 Key 的一个不给，白名单前缀里的（OPENWORKBUDDY_KEY_*、npm_config__authToken）也不给", KEYISH.filter((k) => d.has(k)));
    ok(!d.has("RANDOM_THING") && !d.has("SSH_AUTH_SOCK") && !d.has("NODE_OPTIONS"), "白名单外的普通变量、ssh-agent、NODE_OPTIONS 默认不给", [...d]);

    const allow = ["RANDOM_THING", "OPENAI_API_KEY", "openworkbuddy_key_foo"];
    const solo = names(CE.buildChildEnv(null, { base, allow, keys: true }));
    ok(solo.has("RANDOM_THING") && solo.has("OPENAI_API_KEY") && solo.has("OPENWORKBUDDY_KEY_FOO"),
      "单人：清单里写了的给，像 Key 的也给，名字不分大小写", [...solo]);
    ok(!solo.has("ANTHROPIC_API_KEY") && !solo.has("GITHUB_TOKEN"), "单人：清单里没写的 Key 照样不给", [...solo]);
    ok(solo.has("SSH_AUTH_SOCK"), "单人：ssh-agent 给");

    const multi = names(CE.buildChildEnv(null, { base, allow, keys: false }));
    ok(multi.has("RANDOM_THING"), "多人：清单里的普通变量照给");
    ok(!multi.has("OPENAI_API_KEY") && !multi.has("OPENWORKBUDDY_KEY_FOO") && !multi.has("SSH_AUTH_SOCK"),
      "多人：像 Key 的写进清单也不给，ssh-agent 也不给", [...multi]);

    const ex = CE.buildChildEnv({ PATH: "/x", OWB_FILE: "a.js", N: /** @type {any} */ (3), GONE: undefined, OPENAI_API_KEY: "sk-test-own" }, { base, allow: [], keys: false });
    ok(ex.PATH === "/x" && ex.OWB_FILE === "a.js" && ex.N === "3" && !("GONE" in ex),
      "调用方给的 extra 叠在最上面、转成字符串、undefined 不写", ex);
    ok(ex.OPENAI_API_KEY === "sk-test-own", "调用方自己给的（连接器自己配的 Key）原样给：那是属主配的，不是从环境里漏的");

    const w = CE.buildChildEnv({ PATH: "C:\\new" }, { base: { Path: "C:\\old", SystemRoot: "C:\\Windows" }, allow: [], keys: false, platform: "win32" });
    ok(w.PATH === "C:\\new" && !("Path" in w) && w.SystemRoot === "C:\\Windows", "Windows：调用方的 PATH 顶掉大小写不同的 Path，SystemRoot 照给", w);

    const pos = ["OPENAI_API_KEY", "OPENAI_APIKEY", "OPENAI_KEY", "GH_TOKEN", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "MYSQL_PASSWD", "GOOGLE_APPLICATION_CREDENTIALS", "OPENWORKBUDDY_KEY_X", "HF_AUTH", "npm_config__auth"];
    const neg = ["PATH", "HOME", "SSH_AUTH_SOCK", "XAUTHORITY", "MONKEY", "KEYBOARD_LAYOUT", "OPENWORKBUDDY_HOME", "LANG"];
    ok(pos.every((k) => CE.keyLike(k)), "这些都算像 Key", pos.filter((k) => !CE.keyLike(k)));
    ok(neg.every((k) => !CE.keyLike(k)), "这些不算", neg.filter((k) => CE.keyLike(k)));

    const many = Array.from({ length: 60 }, (_, i) => "V" + i);
    const c = CE.cleanNames([" A ", "a", "1BAD", "B-C", "", null, "X".repeat(101), "$(rm)", ...many]);
    ok(c[0] === "A" && !c.includes("a") && !c.some((n) => /BAD|-|\$|^X+$/.test(n)) && c.length === 50,
      "清单清洗：去空白、不分大小写去重、丢不合法的名字、最多 50 条", c.slice(0, 5));
    ok(CE.cleanNames("PATH").length === 0 && CE.cleanNames(undefined).length === 0, "不是数组 = 空清单");
  }

  section("【2】策略注册");
  {
    const base = { PATH: "/p", RANDOM_THING: "r", OPENAI_API_KEY: "sk-test-x", SSH_AUTH_SOCK: "/s" };
    ok(!names(CE.buildChildEnv(null, { base })).has("RANDOM_THING"), "没注册策略：清单为空");
    CE.setPolicy(() => ({ allow: ["RANDOM_THING", "OPENAI_API_KEY"], keys: true }));
    const a = names(CE.buildChildEnv(null, { base }));
    ok(a.has("RANDOM_THING") && a.has("OPENAI_API_KEY") && a.has("SSH_AUTH_SOCK"), "注册了：每次现问，单人清单生效", [...a]);
    const m = names(CE.buildChildEnv(null, { base, allow: [], keys: false }));
    ok(!m.has("RANDOM_THING") && !m.has("OPENAI_API_KEY") && !m.has("SSH_AUTH_SOCK"), "调用方明说 allow:[] keys:false（连接器）就不问策略", [...m]);
    let n = 0;
    CE.setPolicy(() => { n++; throw new Error("读挂了"); });
    const t = names(CE.buildChildEnv(null, { base }));
    ok(n === 1 && !t.has("RANDOM_THING") && !t.has("OPENAI_API_KEY"), "策略读挂了：当空策略（收紧）", [...t]);
    CE.setPolicy(() => /** @type {any} */ ("keys"));
    ok(!names(CE.buildChildEnv(null, { base })).has("OPENAI_API_KEY"), "策略回了个不是对象的东西：当空策略");
    CE.setPolicy(() => ({ allow: ["OPENAI_API_KEY"], keys: /** @type {any} */ ("true") }));
    ok(!names(CE.buildChildEnv(null, { base })).has("OPENAI_API_KEY"), "keys 不是 true 本身（字符串 \"true\"）不算放行");
    CE.setPolicy(null);
  }

  section("【3】几个账号");
  {
    const admin = require(mod("admin"));
    const users = path.join(process.env.OPENWORKBUDDY_DATA_DIR, "users.json");
    const put = (list) => fs.writeFileSync(users, JSON.stringify({ users: list.map((u) => ({ username: u })), tokens: {} }));
    ok(admin.multiUser() === false, "还没有账号库：一个人");
    put(["owner"]);
    ok(admin.multiUser() === false, "一个账号：一个人");
    fs.writeFileSync(users, "{坏了");
    ok(admin.multiUser() === true, "账号库读坏了：按多个算（判错了就是把 Key 交给成员）");
    put(["owner"]);
    ok(admin.multiUser() === false, "修好了又是一个人");
    put(["owner", "member"]);
    ok(admin.multiUser() === true, "两个账号：多人");
    put(["owner"]);
    ok(admin.multiUser() === true, "多人之后只会更多：删回一个也不回头（跟 soloAccounts 同一个规矩）");
  }

  if (process.platform === "win32") {
    console.log("\nWindows 上没有 printenv / sh，真起子进程那几组按 POSIX 写，跳过");
  } else {
    section("【4】真起子进程");
    const tools = require(mod("tools"));
    const WS = path.join(OWN, "ws");
    fs.mkdirSync(WS, { recursive: true });
    tools.setWorkspaceDir(WS);
    const I = tools._internals;
    const dump = (name) => path.join(WS, name);

    // run_shell：printenv 写进文件再读（不读工具回执：回执可能被打码，打了码这条就是假绿）
    {
      const r = await I.runShell(`printenv > ${JSON.stringify(dump("shell.txt"))}`, 30000, WS);
      const e = parsePrintenv(readIf(dump("shell.txt")));
      const s = names(e);
      ok(!r.isError && s.has("PATH") && s.has("HOME") && e.HOME === FAKE_HOME, "run_shell：PATH、HOME 照常", { err: r.isError, n: s.size });
      ok(noKeys(s).length === 0, "run_shell：printenv 里没有 OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENWORKBUDDY_KEY_FOO", noKeys(s));
      ok(s.has("LC_OWB_CE") && s.has("OPENWORKBUDDY_HOME") && !s.has("OWB_CE_PLAIN") && !s.has("SSH_AUTH_SOCK"),
        "run_shell：白名单前缀给、自己的数据根给，清单外的普通变量和 ssh-agent 不给", [...s].filter((k) => /OWB|LC_|SSH|OPENWORKBUDDY_HOME/.test(k)));

      // ★反向对照★ 同一条路，属主在单人时把名字写进清单 → 真能出现。证明上面那几条「没有」不是读文件读空了
      CE.setPolicy(() => ({ allow: ["OPENAI_API_KEY", "OWB_CE_PLAIN"], keys: true }));
      await I.runShell(`printenv > ${JSON.stringify(dump("shell-solo.txt"))}`, 30000, WS);
      const so = parsePrintenv(readIf(dump("shell-solo.txt")));
      ok(so.OPENAI_API_KEY === "sk-test-x" && so.OWB_CE_PLAIN === "plain-1" && !("ANTHROPIC_API_KEY" in so) && "SSH_AUTH_SOCK" in so,
        "run_shell 单人：清单里的 Key 和普通变量都给了，没写的 Key 还是没有（反向对照）", Object.keys(so).filter((k) => /KEY|OWB|SSH/.test(k)));

      CE.setPolicy(() => ({ allow: ["OPENAI_API_KEY", "OWB_CE_PLAIN"], keys: false }));
      await I.runShell(`printenv > ${JSON.stringify(dump("shell-multi.txt"))}`, 30000, WS);
      const mu = parsePrintenv(readIf(dump("shell-multi.txt")));
      ok(mu.OWB_CE_PLAIN === "plain-1" && !("OPENAI_API_KEY" in mu) && !("SSH_AUTH_SOCK" in mu),
        "run_shell 多人：清单里的普通变量给，Key 写了也不给", Object.keys(mu).filter((k) => /KEY|OWB|SSH/.test(k)));
      CE.setPolicy(null);
    }

    // run_node
    {
      const out = dump("node.json");
      const r = await I.runNode(`require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));`, 30000, WS);
      let e = {};
      try { e = JSON.parse(readIf(out)); } catch {}
      const s = names(e);
      ok(!r.isError && s.has("PATH") && e.HOME === FAKE_HOME && s.has("NODE_PATH") && s.has("OPENWORKBUDDY_HOME"),
        "run_node：PATH、HOME 照常，NODE_PATH / OPENWORKBUDDY_HOME（自己给的）在", { err: r.isError, content: String(r.content).slice(0, 200), n: s.size });
      ok(noKeys(s).length === 0, "run_node：process.env 里没有假 Key", noKeys(s));
    }

    // 后台命令（shell_bg）
    {
      const out = dump("bg.txt");
      const r = I.startBackground(`printenv > ${JSON.stringify(out + ".part")} && mv ${JSON.stringify(out + ".part")} ${JSON.stringify(out)}`, WS, { sessionId: "s_child_env" });
      const text = await waitFor(() => readIf(out));
      const s = names(parsePrintenv(text));
      ok(!r.isError && s.has("PATH") && s.has("HOME"), "后台命令：起得来，PATH、HOME 照常", { err: r.isError, n: s.size });
      ok(text && noKeys(s).length === 0, "后台命令：没有假 Key", noKeys(s));
      try { await tools.releaseRun("s_child_env", { browser: false }); } catch {}
    }

    // 钩子
    {
      const HK = require(mod("hooks"));
      const out = dump("hook.txt");
      const r = await HK.runOne({ run: `printenv > ${JSON.stringify(out)}`, timeout: 20 }, { cwd: WS, env: { OWB_FILE: "f.js" } });
      const e = parsePrintenv(readIf(out));
      const s = names(e);
      ok(r.code === 0 && e.OWB_FILE === "f.js" && s.has("PATH"), "钩子：跑得起来，OWB_FILE 照传", { code: r.code, out: r.out });
      ok(noKeys(s).length === 0, "钩子：没有假 Key", noKeys(s));
    }

    // MCP（stdio 连接器）：只吃基础白名单 + 自己配的 env，属主清单不管用
    {
      const { StdioTransport } = require(mod("mcp"));
      const out = dump("mcp.json");
      const script = dump("mcp-dump.js");
      fs.writeFileSync(script, `const fs = require("fs");\nfs.writeFileSync(${JSON.stringify(out + ".part")}, JSON.stringify(process.env));\nfs.renameSync(${JSON.stringify(out + ".part")}, ${JSON.stringify(out)});\n`);
      CE.setPolicy(() => ({ allow: ["OPENAI_API_KEY", "OWB_CE_PLAIN"], keys: true })); // 单人且写了清单，也不该给连接器
      const t = new StdioTransport("ce", { command: process.execPath, args: [script], env: { MCP_OWN_TOKEN: "sk-test-own" }, cwd: WS });
      await t.open();
      const text = await waitFor(() => readIf(out));
      let e = {};
      try { e = JSON.parse(text || "{}"); } catch {}
      const s = names(e);
      ok(s.has("PATH") && e.HOME === FAKE_HOME && e.MCP_OWN_TOKEN === "sk-test-own", "MCP：PATH、HOME 照常，自己配的 env 照给", { n: s.size });
      ok(noKeys(s).length === 0 && !s.has("OWB_CE_PLAIN") && !s.has("SSH_AUTH_SOCK"),
        "MCP：没有假 Key；属主清单、ssh-agent 都不给连接器", [...s].filter((k) => /KEY|OWB|SSH|TOKEN/.test(k)));
      try { t.proc && t.proc.kill(); } catch {}
      CE.setPolicy(null);
    }

    // 外部引擎的公共起法 runJsonl（claude / codex 都走它）
    {
      const { runJsonl } = require(mod("jsonl"));
      const lines = [];
      const r = await runJsonl({
        bin: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({ env: process.env }) + '\\n')"],
        cwd: WS, env: { ENGINE_EXTRA: "e1" }, onLine: (o) => lines.push(o), deadline: Date.now() + 20000,
      });
      const e = (lines[0] && lines[0].env) || {};
      const s = names(e);
      ok(r.code === 0 && s.has("PATH") && e.ENGINE_EXTRA === "e1", "引擎 runJsonl：PATH 照常，调用方给的照传", { code: r.code, n: s.size });
      ok(noKeys(s).length === 0, "引擎 runJsonl：没有假 Key", noKeys(s));
    }

    // Codex 引擎：以前把整份 process.env 当「调用方给的」塞进 runJsonl，白名单形同虚设
    {
      const codex = require(mod("codex"));
      const fake = path.join(OWN, "bin", "codex");
      fs.mkdirSync(path.dirname(fake), { recursive: true });
      const dbg = dump("codex-debug.txt"), ex = dump("codex-exec.txt");
      fs.writeFileSync(fake, [
        "#!/bin/sh",
        "case \"$1\" in",
        `  debug) printenv > ${JSON.stringify(dbg)}; echo '{"models":[]}' ;;`,
        `  exec) cat > /dev/null; printenv > ${JSON.stringify(ex)}; echo '{"type":"thread.started","thread_id":"t-ce"}'; echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}' ;;`,
        "  *) echo 'codex-cli 0.0.0-test' ;;",
        "esac",
        "",
      ].join("\n"));
      fs.chmodSync(fake, 0o755);
      let err = "";
      try {
        await codex.run({ prompt: "hi", cwd: WS, bin: fake, model: "gpt-test", env: { ENGINE_EXTRA: "c1" }, deadline: Date.now() + 20000 });
      } catch (e) { err = String(e && e.message || e); }
      const d = parsePrintenv(readIf(dbg)), x = parsePrintenv(readIf(ex));
      ok(Object.keys(d).length > 0 && Object.keys(x).length > 0, "Codex：假 codex 的 debug models 和 exec 两条都真跑了", { err, d: Object.keys(d).length, x: Object.keys(x).length });
      ok(noKeys(names(d)).length === 0 && noKeys(names(x)).length === 0, "Codex：两条子进程里都没有假 Key", { debug: noKeys(names(d)), exec: noKeys(names(x)) });
      ok(x.ENGINE_EXTRA === "c1" && /codex/.test(x.CODEX_HOME || "") && x.CODEX_HOME !== process.env.CODEX_HOME && d.CODEX_HOME === x.CODEX_HOME,
        "Codex：调用方给的照传，CODEX_HOME 指向应用自己的隔离目录", { CODEX_HOME: x.CODEX_HOME, extra: x.ENGINE_EXTRA });
      ok(!("OWB_CE_PLAIN" in x), "Codex：清单外的普通变量也不给");
    }
  }

  section("【5】接线");
  {
    const read = (f) => fs.readFileSync(f, "utf8");
    const ROOT = path.join(__dirname, "..");
    const server = read(path.join(ROOT, "server.js"));
    const cli = read(path.join(ROOT, "cli.js"));
    ok(/childEnv\.setPolicy\(\(\) => \(\{ allow: security\.getSecurity\(config\)\.env_passthrough, keys: !admin\.multiUser\(\) \}\)\)/.test(server),
      "服务端注册了策略：清单读 config，Key 类看账号数");
    ok(/sec\.env_passthrough = childEnv\.cleanNames\(b\.security\.env_passthrough\)/.test(server), "设置页存清单要先洗一遍");
    ok(/env_keys_pass: !admin\.multiUser\(\)/.test(server), "设置接口告诉界面「像 Key 的现在给不给」");
    ok(/setPolicy\(/.test(cli) && /env_passthrough/.test(cli), "命令行也注册了策略");
    const security = require(mod("security"));
    ok(Array.isArray(security.DEFAULTS.env_passthrough) && security.DEFAULTS.env_passthrough.length === 0, "默认清单是空的");

    // 起子进程的地方不许再把整份 process.env 往下传（tools.js 里 `node --check` 那一条只查语法，不跑代码）
    const spread = /env:\s*\{\s*\.\.\.process\.env/;
    for (const m of ["mcp", "hooks", "jsonl", "codex", "claude-code", "diagram"]) {
      const hits = read(mod(m)).split("\n").filter((l) => spread.test(l));
      ok(!hits.length, `${m}.js：子进程 env 不再整份摊开 process.env`, hits.map((l) => l.trim().slice(0, 120)));
    }
    const toolsLines = read(mod("tools")).split("\n").filter((l) => spread.test(l));
    ok(toolsLines.length === 1 && /--check/.test(toolsLines[0]), "tools.js：只剩查语法那一条摊开 process.env", toolsLines.map((l) => l.trim().slice(0, 120)));

    const ui = read(path.join(ROOT, "public", "js", "app-06.js"));
    ok(/"sec-envpass"/.test(ui) && /env_passthrough: linesOf\("#sec-envpass"\)/.test(ui), "安全中心有那张卡，保存时带上清单");
    const i18n = read(path.join(ROOT, "public", "js", "i18n.js"));
    const zh = ["命令能看到的环境变量", "AI 跑的命令只拿系统基础变量，像 Key 的默认不给。每行一个变量名。", "额外放行的变量名",
      "只有你一个账号：像 Key 的写进来也会给。", "有多个账号：像 Key 的写进来也不给。", "Key 请在 设置 → 模型 里配。"];
    ok(zh.every((s) => ui.includes(s)), "界面文案都在卡片上", zh.filter((s) => !ui.includes(s)));
    ok(zh.every((s) => i18n.includes(JSON.stringify(s) + ":")), "每句都有英文", zh.filter((s) => !i18n.includes(JSON.stringify(s) + ":")));
  }

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
