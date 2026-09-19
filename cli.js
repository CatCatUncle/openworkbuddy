#!/usr/bin/env node
"use strict";
/**
 * OpenWorkBuddy CLI — 终端里直接跑 agent 任务，与 Web/IM 共用同一套运行时与配置。
 *
 * 用法：
 *   openworkbuddy "帮我调研xxx并写成报告"                 单发任务，跑完即退出
 *   openworkbuddy                                          交互式 REPL（连续对话，保留上下文）
 *   openworkbuddy -C ~/项目/报表 "把这个目录的表汇总一下"   指定这次在哪个目录干活
 *   openworkbuddy -f 图.png "这张图里写了什么"              带一个文件/图片一起问（可以写几次）
 *   cat err.log | openworkbuddy "这个报错什么意思"          管道进来的内容当附加材料
 *   openworkbuddy -c "接着上面那个继续"                     续接最近一次 CLI 会话
 *   openworkbuddy --json "..." | jq -r 'select(.type=="text").delta'   机器可读事件流
 *
 * 两条约定，都是为了能塞进管道和脚本：
 *   1. **模型的回答走 stdout，进度和日志走 stderr。** 所以 `openworkbuddy "..." > 答案.md` 拿到的是
 *      干净的答案，不会混进「第 3 步 思考中…」那些行。
 *   2. **退出码说实话**：正常 0，任务出错 1，Ctrl+C 打断 130。以前无论如何都返回 0，
 *      `openworkbuddy ... && 下一步` 在任务失败时照样往下走。
 *
 * npm link 后可直接用 `openworkbuddy "任务"`。
 */

// Node 太老 / 依赖没装：排在所有 require 最前面，不然用户拿到的是一句 Cannot find module
require("./boot-check").enforce({ rootDir: __dirname });
const fs = require("fs");
const os = require("os");
const path = require("path");
const { dataPath, preferData } = require("./paths");
const readline = require("readline");
const { spawnSync } = require("child_process");
const { createLLM } = require("./llm");
const { setWorkspaceDir, getWorkspaceDir } = require("./tools");
const { McpManager } = require("./mcp");
const { createAgentRuntime } = require("./agent");
const lanes = require("./lanes"); // 终端里起的任务归「工程」线；续跑 id 按引擎分开记
const callout = require("./callout"); // 正文里的提示条：终端没有图标，换成文字标签
const sessSearch = require("./session-search"); // /resume 的搜索和 --list 的摘要都要它——必须在 listCliSessions 之前
const mdTty = require("./md-tty"); // 正文里的 Markdown：终端里渲染出来，别让 **加粗** 糊在脸上
const attach = require("./cli-attach"); // 带进来的文件/图片：拖进来的路径、@ 补全、剪贴板
const modes = require("./modes"); // 执行模式的唯一真源；界面和这儿必须是同一份
const cliAsk = require("./cli-ask"); // agent 问一句时，终端里怎么摆这道选择题
const cliApprove = require("./cli-approve"); // 危险操作求批准时，终端里怎么摆那张卡
const security = require("./security"); // 审批是它发起的；命令行订它的钩子才知道有人正等着点头
const cliLive = require("./cli-live"); // 把这趟活儿播给网页/手机：看得见、插得上话
const termImage = require("./term-image"); // 终端里直接把产出的图画出来 + /open 交给系统程序
const account = require("./account");
const store = require("./store");

// ---------- 参数解析 ----------
// 解析规则和帮助文本都在 cli-args.js 的那张声明表里，它是纯的：认不出来的选项会
// 原样报回来，由这儿决定怎么说、退出码给几。以前是一串 else if，认不出的词一律
// 当任务文本塞给模型——拼错一个 --quiet，钱照花、进度照打，人还以为自己关掉了。
const cliArgs = require("./cli-args");
const parsed = cliArgs.parse(process.argv.slice(2));
const opts = parsed.opts;
const words = parsed.words;

// ---------- 输出通道 ----------
// 着色只在「那一头真的是终端」时才加：answer 判 stdout，progress 判 stderr。
// 两个可能一个是 tty 一个被重定向，共用一个 isTTY 会往管道里塞转义序列。
//
// NO_COLOR 是一条外部约定（no-color.org）：设了它，任何程序都不该再往输出里加颜色。
// 谁在用它——盲人用的屏幕阅读器、把终端输出转成纯文本的记录工具、以及一切分不清
// 「\x1b[33m」和正文的下游。之前这儿只看 isTTY：设了 NO_COLOR 的人照样一脸转义序列。
// FORCE_COLOR 是反过来那条（CI 里没有 tty，但日志面板认颜色），顺手一起认了。
const noColorEnv = !!(process.env.NO_COLOR || "");
const forceColor = !!(process.env.FORCE_COLOR || "") && process.env.FORCE_COLOR !== "0";
const ttyErr = !noColorEnv && (!!process.stderr.isTTY || forceColor);
const dim = (s) => (ttyErr ? `\x1b[2m${s}\x1b[0m` : s);
const yellow = (s) => (ttyErr ? `\x1b[33m${s}\x1b[0m` : s);
const red = (s) => (ttyErr ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s) => (ttyErr ? `\x1b[32m${s}\x1b[0m` : s);
/** 改文件那几步的 diff：超过 30 行截掉——终端里要的是一眼看清动了哪儿，全文去看文件 */
function paintDiff(text, max = 30) {
  const lines = String(text || "").split("\n");
  if (lines.length > 1 && lines[0].startsWith("--- ") && lines[1].startsWith("+++ ")) lines.splice(0, 2); // 文件名上一行已经报过了
  const out = lines.slice(0, max).map((l) => (l.startsWith("+") ? green("    " + l) : l.startsWith("-") ? red("    " + l) : dim("    " + l)));
  if (lines.length > max) out.push(dim(`    … 还有 ${lines.length - max} 行`));
  return out.join("\n");
}
const bold = (s) => (ttyErr ? `\x1b[1m${s}\x1b[0m` : s);
/** 进度/诊断：一律 stderr，且 --quiet / --json 下彻底闭嘴 */
const prog = (s) => { if (!opts.quiet && !opts.json) process.stderr.write(s); };
/** 模型的回答：stdout，--json 下改走事件流 */
const answer = (s) => { if (!opts.json) process.stdout.write(s); };
/** 机器可读事件流 */
const emitJson = (o) => { if (opts.json) process.stdout.write(JSON.stringify(o) + "\n"); };
/**
 * 正文要不要在终端里渲染成人看的样子。用户原话：「怎么cli里面还有**这种啊」。
 *
 * 只在 stdout 真的是终端时才渲染：`openworkbuddy "…" > 答案.md`、`openworkbuddy … | pbcopy` 要的是原始
 * Markdown——那才是能接着加工的东西（跟上面那条「回答走 stdout」是同一个约定）。
 * --json 走事件流不归这儿管，--raw 是人明说了别动。
 */
const renderMd = !opts.json && !opts.raw && !!process.stdout.isTTY;
const newMdRenderer = () => (renderMd
  ? mdTty.createRenderer({ width: process.stdout.columns || 80, color: !noColorEnv })
  : null);

// ---------- 帮助 / 版本 / 参数写错了 ----------
if (opts.help) { console.log(cliArgs.helpText()); process.exit(0); }
if (opts.version) { console.log(`OpenWorkBuddy ${require("./package.json").version}`); process.exit(0); }
if (parsed.problems.length) {
  // 退出码 2 单独留给「参数写错了」：脚本里能跟「任务失败」分开处理，
  // 也免得 `openworkbuddy --qiet ... && 下一步` 在打错字的时候照样往下走
  process.stderr.write(red(cliArgs.problemText(parsed.problems)));
  process.stderr.write(dim("openworkbuddy --help 看全部用法。\n"));
  process.exit(2);
}

// 子命令。动词式的写法（openworkbuddy resume / openworkbuddy sessions / openworkbuddy engines）是给人记的，
// 老的 --session / --list / -c 一个都没动，脚本不用改。
let sub = "";
if (cliArgs.SUBS.some((x) => x.name === words[0])) {
  sub = words.shift();
  // 会话 id 有固定前缀（cli_ 是命令行开的，s_ 是桌面开的），认得出就当 id，认不出就当任务描述
  if (sub === "resume" && words[0] && /^(cli_|s_)/.test(words[0])) opts.session = words.shift();
  if (sub === "sessions") opts.list = Number(words[0]) > 0 ? Number(words.shift()) : opts.list || 10;
}
let oneShot = words.join(" ").trim();

// ---------- openworkbuddy completion：把 Tab 补全脚本打到 stdout ----------
// 排在读配置前面，跟 doctor 同理：装完就该能生成，不该要求先跑过一次把 config.json 造出来。
// 脚本本身长在 cli-args.js 的同一张表上，改一行选项，三种 shell 的补全同时就有了。
if (sub === "completion") {
  const shell = String(words[0] || "").trim() || path.basename(String(process.env.SHELL || "")) || "bash";
  const ok = ["bash", "zsh", "fish"];
  if (!ok.includes(shell)) {
    process.stderr.write(red(`不认识这个 shell：${shell}。可选：${ok.join(" / ")}\n`));
    process.exit(2);
  }
  let engineIds = [];
  try { engineIds = require("./engines").list().map((b) => b.id); } catch {}
  process.stdout.write(cliArgs.completionScript(shell, { sessionsDir: dataPath("data", "sessions"), engines: engineIds }));
  // 装法写在 stderr：这样 `openworkbuddy completion zsh > _wb` 拿到的是干净的脚本，说明照样看得见
  const how = {
    bash: "openworkbuddy completion bash > ~/.openworkbuddy-completion.bash\n然后在 ~/.bashrc 里加一行：source ~/.openworkbuddy-completion.bash",
    zsh: "openworkbuddy completion zsh > ~/.zsh/completions/_openworkbuddy\n确认 ~/.zshrc 里有：fpath=(~/.zsh/completions $fpath) 和 autoload -Uz compinit && compinit",
    fish: "openworkbuddy completion fish > ~/.config/fish/completions/openworkbuddy.fish\n新开一个窗口就生效",
  }[shell];
  if (!process.stdout.isTTY) process.stderr.write(dim(how + "\n"));
  else process.stderr.write(dim("\n上面这段要存成文件才起作用：\n" + how + "\n"));
  process.exit(0);
}

// ---------- 配置与运行时（与 server.js 同源） ----------
const CONFIG_PATH = dataPath("config.json");
// openworkbuddy doctor 是个例外：它就是用来查「为什么什么都没配好」的，在这儿把它拦下等于
// 把唯一一根救命稻草也收走。别的命令照旧当场停——没有配置它们干不了活。
if (!fs.existsSync(CONFIG_PATH) && sub !== "doctor") {
  process.stderr.write(red("找不到 config.json，请先运行一次 npm start 生成，或从 config.example.json 复制。\n"));
  process.stderr.write(dim("不确定是哪儿不对的话，先跑一句 openworkbuddy doctor。\n"));
  process.exit(1);
}
const config = store.readJson(CONFIG_PATH, {});

// ---------- --perm：这一趟放多少权 ----------
// 网页那边四档是点得到的（设置里一个下拉），命令行原来只能改 config.json —— 而 config.json 是
// 长期设置：为了让一条 cron 跑全自动，得先把文件改成 full、跑完再改回来，忘了改回来就是
// 明天所有交互式的活儿也不问人了。这正是 --perm 要挡掉的那种事故。
//
// 所以跟 -C 一个规矩：命令行是「这一次」的意思，**只改内存里这份 config，绝不回写文件**。
// 下面所有人（runtime、审批钩子、/perm）读的都是 config.security.permission_mode 这一个字段，
// 改它一处就全生效，不存在 CLI 一套、内核另一套的分叉。
if (opts.perm) {
  config.security = { ...(config.security || {}), permission_mode: opts.perm };
}
/** 当前档位（同一份真源，网页/命令行/审批都读它） */
const permNow = () => security.permissionMode(config.security);

// ---------- openworkbuddy pair：在终端里把手机连上来 ----------
// 位置在 config 读完之后——要拿 config 里的端口去找那台正在跑的服务。
//
// 为什么非得有服务在跑：配对码只活在服务进程的内存里（落盘的码会在硬盘上留下一把
// 三分钟的钥匙，不值得）。命令行自己是独立进程，它生成的码服务端根本不认识。
// 所以这儿的做法是——命令行本来就能读 users.json，它给自己签一条临时令牌，
// 用这条令牌去请那台服务出码，出完就把这条临时令牌注销掉，不在设备表里留渣。
if (sub === "pair") {
  (async () => {
    const u = account.defaultUser();
    if (!u) {
      process.stderr.write(red("本机还没有账号。先打开一次桌面端或网页版注册。\n"));
      process.exit(1);
    }
    const port = require("./paths").resolvePort(process.env, config);
    const base = `http://127.0.0.1:${port}`;
    const A = account._internals;
    const token = A.issueToken(u.username, { kind: "session", name: "openworkbuddy pair（临时）" });
    const call = (p, init) => fetch(base + p, { ...init, headers: { ...(init || {}).headers, Cookie: `openworkbuddy_token=${token}` } });
    const cleanup = () => { try { A.revokeDevice(u.username, A.deviceId(token)); } catch {} };
    let d;
    try {
      d = await call("/api/devices/pair", { method: "POST" }).then((r) => r.json());
    } catch {
      cleanup();
      process.stderr.write(red(`连不上 ${base}。\n`));
      process.stderr.write(dim("配对要有一台服务在跑（手机也是连它）。先在另一个窗口 npm start，或者打开桌面端。\n"));
      process.exit(1);
    }
    if (!d || !d.pretty) { cleanup(); process.stderr.write(red("出码失败。\n")); process.exit(1); }

    if (opts.json) {
      emitJson({ type: "pair", code: d.code, url: d.url, expires_at: d.expires_at });
    } else {
      if (d.url) {
        // 终端里画二维码：手机扫一下就进去了，8 个字符一个都不用敲。
        // small:true 用半块字符，一个码占 ~21 行而不是 ~41 行——不然一屏放不下，
        // 滚上去只剩半张码，扫不出来
        const art = await require("qrcode").toString(d.url, { type: "terminal", small: true, errorCorrectionLevel: "M" }).catch(() => "");
        if (art) process.stdout.write("\n" + art);
      }
      process.stdout.write(`\n  ${bold(d.pretty)}   ${dim("← 手机上填这串，或者扫上面的码")}\n`);
      if (d.url) process.stdout.write(`  ${dim(d.url.replace(/\?pair=.*/, ""))}\n`);
      prog(dim(`\n等着…（${Math.round((d.expires_at - Date.now()) / 1000)} 秒内有效，Ctrl-C 退出）\n`));
    }

    // 盯着，连上就报一声。连上之前不退出——不然人刚扫完，终端已经回到提示符，
    // 到底成没成全靠猜
    process.on("SIGINT", () => { cleanup(); process.stdout.write("\n"); process.exit(130); });
    const deadline = d.expires_at;
    for (;;) {
      if (Date.now() > deadline + 2000) {
        cleanup();
        prog(yellow("配对码过期了。再跑一次 openworkbuddy pair。\n"));
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 1500));
      const st = await call("/api/devices/pair/status").then((r) => r.json()).catch(() => null);
      if (st && st.claimed) {
        cleanup();
        if (opts.json) emitJson({ type: "paired", name: st.claimed.name });
        else process.stdout.write(green(`\n✓ ${st.claimed.name} 连上了\n`) + dim("  密码没有离开过这台机器。要断开：设置 → 安全 → 远程访问，把它踢掉。\n"));
        process.exit(0);
      }
    }
  })();
  return;
}

// ---------- openworkbuddy passwd / openworkbuddy 2fa：忘了密码、丢了手机时的救急口子 ----------
// 位置跟 pair 一样在读完 config 之后，但它们不连服务——直接改 users.json，
// 所以服务开着关着都能用（服务开着时改完记得让本人重新登录：旧令牌已经全作废了）。
//
// 凭什么让命令行干这件事，见 account.js resetPasswordLocally 头上那段：能读到
// users.json 的人早就拿到了这台机器上的全部东西，再拦一道密码只剩下「忘了密码
// 就彻底进不去」这一个后果。反过来，这两条**绝不能接到 HTTP 上**。
// ---------- openworkbuddy owner：唯一的超级管理员进不去时的救场口 ----------
// 每个组织只有一个超管，而同级动不了同级——他离职、被停用、密码和手机一起丢了的话，
// 界面上就没有出口了。凭据跟上面两条一样：你能读到 users.json，你本来就是机主。
if (sub === "owner") {
  const who = String((words.filter((w) => !w.startsWith("-"))[0] || "")).trim();
  try {
    const rbac = require("./rbac");
    const org = require("./org");
    if (!who) {
      // 不给用户名就只是「看看现在是谁」：把一台机器的主子换掉不该是手滑的后果
      account.migrateOwners();
      const us = account._internals.loadUsers().users || [];
      const byOrg = new Map();
      for (const u of us) { const o = org.orgIdOf(u); if (!byOrg.has(o)) byOrg.set(o, []); byOrg.get(o).push(u); }
      if (!byOrg.size) { process.stderr.write(dim("这台机器上还没有账号。\n")); process.exit(0); }
      for (const [id, list] of byOrg) {
        const own = list.find((u) => rbac.roleOf(u) === "owner");
        const name = org.getOrg(id).name;
        process.stdout.write(own
          ? `${name}：超级管理员是 ${bold(own.username)}${dim("（管理员 " + list.filter((u) => rbac.roleOf(u) === "admin").length + " 人 · 共 " + list.length + " 人）")}\n`
          : `${name}：${yellow("还没有超级管理员")}${dim("（共 " + list.length + " 人）")}\n`);
      }
      process.stderr.write(dim("换人：openworkbuddy owner <用户名>　（原来那个会改任管理员）\n"));
      process.exit(0);
    }
    const r = account.setOwnerLocally(who, { actor: "命令行" });
    process.stdout.write(green(`\u2713 ${who} 现在是「${r.org_name}」的超级管理员\n`));
    if (r.from) process.stdout.write(dim(`  原来的超管 ${r.from} 已改任管理员——他还能管人、改设置，只是发不了管理员了。\n`));
    if (r.disabled) process.stderr.write(yellow("  注意：这个账号是「已停用」状态，先到管理后台复职，不然他登不上。\n"));
    if (r.two_factor) process.stderr.write(dim("  这个账号开着二次验证，登录还要那串码。\n"));
    process.exit(0);
  } catch (e) {
    process.stderr.write(red((e && e.message) || String(e)) + "\n");
    let names = [];
    try { names = (account._internals.loadUsers().users || []).map((u) => u.username); } catch {}
    if (who && names.length) process.stderr.write(dim("这台机器上的账号：" + names.slice(0, 20).join("、") + (names.length > 20 ? " …" : "") + "\n"));
    process.exit(1);
  }
}

// ---------- openworkbuddy worktree：分身都在哪儿、哪些还没合回去 ----------
// 分身是撞车时自动开的，用户没亲手建过，所以他也没有"去哪儿找"的直觉。
// 这条就是那个找法：列出来，说清每根分支合回去的命令，顺手把白跑的那些收掉。
if (sub === "worktree") {
  const wt = require("./worktree");
  const STORE = dataPath("data", "worktrees");
  const want = String((words.filter((w) => !w.startsWith("-"))[0] || "")).trim();
  const rows = wt.list(STORE);
  if (want === "清理" || want === "clean") {
    // 只收白跑的那些。有改动、有提交的一个不碰——那是还没合回去的活，删了就真没了
    const done = wt.sweep(STORE, { alive: [], days: 0 });
    const left = wt.list(STORE);
    process.stdout.write(done.length ? green(`\u2713 收掉了 ${done.length} 个没产出的分身\n`) : dim("没有可收的分身（有改动的一个都不碰）。\n"));
    if (left.length) process.stderr.write(dim(`还剩 ${left.length} 个有改动的，合回去或者自己删：git worktree remove <目录>\n`));
    process.exit(0);
  }
  if (!rows.length) {
    process.stdout.write(dim("现在没有分身。\n"));
    process.stderr.write(dim("两条任务同时改同一个 git 仓库时，后来那条会自动去自己的 worktree 里改，不跟人抢工作区。\n"));
    process.exit(0);
  }
  for (const r of rows) {
    const tag = r.empty ? dim("（白跑，可以收）") : r.dirty ? yellow(`（${r.files} 个文件还没提交）`) : green(`（${r.commits} 笔提交）`);
    process.stdout.write(`${bold(r.branch)} ${tag}\n`);
    process.stdout.write(dim(`  目录 ${r.dir}\n`));
    if (!r.empty && r.repo) process.stdout.write(dim(`  合回来 git -C ${r.repo} merge ${r.branch}\n`));
  }
  process.stderr.write(dim("收掉白跑的：openworkbuddy worktree 清理\n"));
  process.exit(0);
}

if (sub === "passwd" || sub === "2fa") {
  const pos = words.filter((w) => !w.startsWith("-"));   // [用户名, 新密码?]
  const who = String(pos[0] || "").trim();
  const off = !!opts.off;
  if (!who) {
    process.stderr.write(red(`要说改谁：openworkbuddy ${sub} <用户名>${sub === "2fa" ? " --off" : ""}\n`));
    // 顺手把这台机器上有哪些账号列出来：忘了密码的人往往连自己的登录名都记不准
    let names = [];
    try { names = (account._internals.loadUsers().users || []).map((u) => u.username); } catch {}
    if (names.length) process.stderr.write(dim("这台机器上的账号：" + names.slice(0, 20).join("、") + (names.length > 20 ? " …" : "") + "\n"));
    process.exit(2);
  }
  try {
    if (sub === "2fa") {
      if (!off) {
        // 不给 --off 就只看状态：直接把人家的二次验证关掉不该是「手滑打错子命令」的后果
        const u = (account._internals.loadUsers().users || []).find((x) => x.username === who);
        if (!u) throw new Error("没有这个账号：" + who);
        const st = account.twoFactorStatus(u);
        process.stdout.write(st.on
          ? `${who} 的二次验证：${green("开着")}${dim("（" + new Date(st.since).toLocaleString() + " 开的，还剩 " + st.recovery_left + " 个恢复码）")}\n`
          : `${who} 的二次验证：${dim("没开")}\n`);
        if (st.on) process.stderr.write(dim(`手机丢了就跑：openworkbuddy 2fa ${who} --off\n`));
        process.exit(0);
      }
      const had = account.disableTOTP(who, { byAdmin: true, actor: "命令行" });
      process.stdout.write(had
        ? green(`✓ ${who} 的二次验证已关闭\n`) + dim("  他现在只用密码就能登。让他登进去后到「设置 → 安全」重新绑一次，旧的密钥和恢复码已经作废。\n")
        : dim(`${who} 本来就没开二次验证，什么都没改。\n`));
      process.exit(0);
    }
    // openworkbuddy passwd：不给新密码就随机生成一串（长度和复杂度跟着组织策略走）
    const r = account.resetPasswordLocally(who, pos[1] || null, { actor: "命令行" });
    process.stdout.write(green(`✓ ${who} 的密码已改\n`));
    if (r.generated) {
      process.stdout.write(`\n  ${bold(r.password)}   ${dim("← 新密码，这一次之后不会再显示")}\n\n`);
      process.stderr.write(dim("  自己定一个的话：openworkbuddy passwd " + who + " '你的新密码'\n"));
    }
    process.stderr.write(dim("  他在别处的登录状态已经全部作废，需要重新登一次。\n"));
    if (r.two_factor) process.stderr.write(yellow("  注意：这个账号还开着二次验证，光有密码登不进去。手机也丢了就跑：openworkbuddy 2fa " + who + " --off\n"));
    if (r.disabled) process.stderr.write(yellow("  注意：这个账号是「已停用」状态，改了密码也登不上。到管理后台复职，或跑 openworkbuddy 里的离职/复职流程。\n"));
    process.exit(0);
  } catch (e) {
    process.stderr.write(red((e && e.message) || String(e)) + "\n");
    process.exit(1);
  }
}

// ---------- openworkbuddy jev：问一下判断模型 ----------
// 位置在 doctor 前面、createLLM 后面都行，它不碰 agent 那一套。
// 三种用法一条命令收：不给参数是测活，两个参数是是非题，再多几个词就是单选（加 --score 变打分）。
// 为什么不给它做成 /jev 那样的会话内命令：判断不是对话，它没有上下文、不产文字、不记进会话，
// 混进会话里反而要解释「这一条为什么不算一轮」。
if (sub === "jev") {
  const so = require("./systemone");
  const jevApi = require("./jev");
  const st = jevApi.status(config);
  const say = (s) => process.stdout.write(s);
  (async () => {
    if (!st.ready) {
      process.stderr.write(red("判断模型还没法用：" + st.why + "\n") + dim(st.how + "\n"));
      process.exit(1);
    }
    const head = () => prog(dim(`走 ${st.label} · ${st.model} · 来源 ${st.from}\n`));
    let out, asked = "";
    if (!words.length) {
      head();
      prog(dim("没给材料，那就拿一段固定的客服工单测一下——答得对不对一眼能看出来\n"));
      out = await jevApi.selftest(config);
      asked = out.state || "";
    } else if (words.length === 1) {
      process.stderr.write(red("还得说要判断什么。\n") + dim(
        '  openworkbuddy jev "这段材料" "它急不急"                    → 是非题，回一个概率\n' +
        '  openworkbuddy jev "这段材料" "该给谁做" 表格 写作 研究       → 单选题\n' +
        '  openworkbuddy jev --score "这段材料" "风险多大" 低 中 高     → 打分题（从低到高）\n'));
      process.exit(2);
    } else {
      head();
      const [state, ask, ...opt] = words;
      asked = state;
      const q = !opt.length ? so.noul(ask) : opts.score ? so.score(ask, opt) : so.choice(ask, opt);
      out = await jevApi.ask(config, { state, questions: { 判断: q } });
    }
    if (!out.ok) {
      if (opts.json) say(JSON.stringify({ ok: false, error: out.error }) + "\n");
      else process.stderr.write(red("没答上来：" + out.error + "\n"));
      process.exit(1);
    }
    if (opts.json) {
      say(JSON.stringify({ ok: true, model: out.model, ms: out.ms, answers: out.answers, usage: out.usage, cost: so.costOf(out.usage) }) + "\n");
      process.exit(0);
    }
    if (!words.length) prog(dim("材料：" + asked + "\n"));
    for (const a of out.answers) {
      const g = so.gate(a);
      say((g.act ? green("√ ") : yellow("? ")) + so.lineOf(a) + (g.act ? "" : dim(`　不到 ${so.pct(so.SURE_MIN)}，别自动照做`)) + "\n");
    }
    // 截过一定要说：判断是拿前半段做的，人却以为它看了全文，这种错事后最难查
    if (out.truncated) process.stderr.write(yellow(`材料太长（${out.state_chars} 字），只喂了前 ${so.MAX_STATE} 字\n`));
    prog(dim(`${out.model} · ${out.ms}ms · ${so.costText(out.usage)}\n`));
    process.exit(0);
  })().catch((e) => { process.stderr.write(red("挂了：" + ((e && e.message) || e) + "\n")); process.exit(1); });
  return;
}

// ---------- openworkbuddy doctor：跑不起来时的一次性体检 ----------
// 位置很讲究：必须排在下面 createLLM 前面。模型一个都没配的机器上 createLLM 当场抛
// 「未知 provider: undefined」——而那恰恰是最需要体检的时刻，体检工具自己先死没有道理。
if (sub === "doctor") {
  const doctor = require("./doctor");
  const paint = { ok: green, warn: yellow, bad: red, dim };
  (async () => {
    const items = await doctor.gather({
      paths: require("./paths"),
      config,
      engines: require("./engines"),
      workspaceDir: opts.workspace || config.workspace_dir || getWorkspaceDir(),
      bootCheck: require("./boot-check"),
    });
    process.stdout.write(doctor.render(items, (t, lv) => (paint[lv] || ((x) => x))(t)));
    // 退出码说实话：有要处理的就 1，好写进安装脚本和 CI（openworkbuddy doctor && npm start）
    process.exit(doctor.worst(items) >= doctor.LEVELS.bad ? 1 : 0);
  })();
  return; // CommonJS 的模块体本身就是个函数，这行是合法的「到此为止」，下面那一整套运行时不用再起
}
/** 设置里挑的那个底层引擎。命令行没有登录态，取不到个人偏好，读的就是这份全局配置 */
const cfgEngine = () => String((config.agent || {}).engine || "builtin").trim() || "builtin";
// -C 优先于配置：命令行是「这一次」的意思，不该把配置文件改掉
const wantWorkspace = opts.workspace || config.workspace_dir;
if (wantWorkspace) {
  try { setWorkspaceDir(wantWorkspace); }
  catch (e) {
    // 显式传了 -C 却用不了，那是命令写错了，得当场停——默默退回默认目录会把文件写到别处
    if (opts.workspace) { process.stderr.write(red(`工作目录用不了：${e.message}\n`)); process.exit(1); }
  }
}

// 运行时三件套：模型、专家、MCP。与 server.js 读同一批文件，CLI 不另立一套配置
// 活的壳子，不是一次性造好的客户端：/model 换模型时整棵任务树（含委派出去的专家）都得跟着
// 走新的那条，而 agent.js 在建 runtime 的时候就把这个引用拿在手里了。里层随时能换掉，
// 外面那个引用一直有效——否则换完模型还是老的那条在跑，人在终端里看不出来
let llmImpl = createLLM(config);
const llm = {
  get provider() { return llmImpl.provider; },
  get model() { return llmImpl.model; },
  chat: (args) => llmImpl.chat(args),
};
const expertsDoc = store.readJson(preferData("experts.json"), {}) || {};
const experts = expertsDoc.experts || [];
const expertTeams = expertsDoc.teams || [];
const mcpManager = new McpManager();

// ---------- Goal 目标模式（和网页端同一份，见 goal.js） ----------
// 目标验收借判断模型：一堆「达成了没有」的是非题正是它的形状，而且它会说自己有多确定。
// 没配渠道就返回 ok:false，goal.js 自己退回对话模型那条老路——命令行这边不用管
const goalKit = require("./goal").createGoalEngine({
  workspaceDir: getWorkspaceDir,
  decide: (args) => require("./jev").ask(config, args),
});
/**
 * 拆验收标准、对着标准判分，这两句问谁。
 *
 * 跟 server.js 那边同一个道理：配了本机引擎（Claude Code / Codex）就借那个 CLI 问——
 * 用户切过去图的就是不花 API 的钱，这两步偷偷走 API 的话，没配 Key 的人会发现
 * 目标卡永远停在 0/N，而他根本不知道是哪一步没通。
 */
async function goalThink({ system, prompt, timeoutMs }) {
  const id = cfgEngine();
  const engMod = require("./engines");
  if (id !== "builtin" && engMod.get(id)) {
    return await engMod.ask({ id, opts: ((config.agent || {}).engine_options || {})[id] || {}, system, prompt, timeoutMs });
  }
  const r = await llm.chat({ system, history: [{ role: "user", content: prompt }], tools: [], signal: AbortSignal.timeout(timeoutMs) });
  return r.text;
}

/** 终端里的目标卡。打勾的用绿√，没打勾的留空框——一眼看出还差哪几项 */
function printGoalCard(goal) {
  if (!goal) return;
  const p = goalKit.progress(goal);
  const head = goal.status === "done" ? green("目标达成") : `目标 ${p.done}/${p.total}` + (goal.round ? ` · 第 ${goal.round} 轮` : "");
  prog("\n" + bold(`◆ ${head}`) + dim(`　${goal.text.slice(0, 48)}\n`));
  for (const c of goal.criteria) prog(`  ${c.done ? green("√") : dim("□")} ${c.done ? dim(c.text) : c.text}\n`);
  if (goal.note) prog(yellow(`  ！${goal.note}\n`));
  if (goal.paused) prog(yellow(`  暂停：${goal.paused}\n`));
  prog("\n");
}


// ---------- 会话持久化（与 server.js 同一目录同一结构） ----------
const SESS_DIR = dataPath("data", "sessions");
const sessFileOf = (id) => path.join(SESS_DIR, String(id).replace(/[^\w-]/g, "_") + ".json");
/**
 * 列最近的会话，新的在前。
 *
 * 默认把桌面端的会话一起列出来 —— 桌面和命令行写的本来就是同一批文件
 * （data/sessions/<id>.json，同一套字段），只列 cli_ 开头那半边，等于人为把
 * 「早上在桌面开了个头，下午想在终端接着做」这条路堵死。
 * @param {number} n
 * @param {boolean} [cliOnly] 只看命令行自己开的（-c 续接时用，免得接到桌面那边正开着的会话）
 */
function listCliSessions(n, cliOnly = false) {
  let names = [];
  try { names = fs.readdirSync(SESS_DIR).filter((f) => f.endsWith(".json")); } catch { return []; }
  if (cliOnly) names = names.filter((f) => f.startsWith("cli_"));
  return names
    .map((f) => {
      const p = path.join(SESS_DIR, f);
      let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch {}
      const j = store.readJson(p, {}) || {};
      // 轮数按「问了几次」算：transcript 里一问一答是两条，直接数长度会把一次问答报成 2 轮
      const turns = (j.transcript || []).filter((t) => t && t.type === "user").length;
      const id = f.replace(/\.json$/, "");
      // body 只喂给搜索，不上屏：截短一点，选单最多十二条，没必要为搜索读进几万字
      return { id, mtime, title: j.title || "", turns, from: id.startsWith("cli_") ? "命令行" : "桌面", engine: j.engine || "", body: sessSearch.digestOf(j, 1200) };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, n);
}
/** 新会话 id：带到秒 + 三位随机。
 *  以前是 `cli_YYYYMMDD`，同一天的每条命令共用一个文件，而 runTask 会把助手回复和工具结果
 *  就地追加进 history —— 于是「单发任务」其实拖着当天所有前一条任务的完整上下文，
 *  既烧 token 又让模型在别的任务的阴影里答新问题。默认改成一次一个。 */
function newSessionId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `cli_${stamp}_${Math.random().toString(36).slice(2, 5)}`;
}
// openworkbuddy resume 不给 id = 接最近动过的那个，不管它是在桌面开的还是命令行开的。
// 这是"丝滑切换"的落点：桌面上做到一半，终端里 openworkbuddy resume 就能接着往下走。
if (sub === "resume" && !opts.session) {
  const last = listCliSessions(1)[0];
  if (!last) { process.stderr.write(red("没有可续接的会话。先跑一次 openworkbuddy \"任务\" 或在桌面端聊一句。\n")); process.exit(1); }
  opts.session = last.id;
  prog(dim(`（续接 ${last.from}会话 ${last.id}：${last.title || "无标题"}）\n`));
}
let sessionId = opts.session || (opts.cont && (listCliSessions(1, true)[0] || {}).id) || newSessionId();
if (opts.cont && !opts.session && !listCliSessions(1, true).length) prog(dim("（没有可续接的命令行会话，开一个新的）\n"));
let sessFile = sessFileOf(sessionId);
// 跟网页端是同一批文件，写法也得一样：原子改名 + .bak，坏了先回退别直接覆盖
let sess = store.readJson(sessFile, { history: [], transcript: [], title: "" });
function saveSess() {
  sess.updated_at = new Date().toISOString();
  store.writeJsonAtomic(sessFile, sess);
}

// ---------- 事件渲染 ----------
function makeEmit(state) {
  return (ev) => {
    // 先播给网页/手机，再管终端怎么显示：这两件事互不相干，哪边坏了都不该拖累另一边
    if (state.live) state.live.event(ev);
    if (opts.json) {
      // 事件原样出去，只把 files 这类大字段留给调用方自己挑
      emitJson(ev);
      if (ev.type === "text" && ev.depth === 0) state.finalParts.push(ev.delta);
      if (ev.type === "usage") state.usage = ev;
      if (ev.type === "files") { state.files = ev.files || state.files; noteChanged(state, ev.changed); }
      return;
    }
    if (ev.type === "text") {
      if (ev.depth > 0) return;
      // 这个空行是用来跟上面的进度隔开的；-q / 没进度可打的时候没东西要隔，
      // 再吐一个就是往重定向出来的文件里塞前导空行。
      if (!state.streamed) { if (!opts.quiet) answer("\n"); state.streamed = true; }
      // 提示条是整条一次 emit 的（agent.js 那几处 callout.line），不会被切片切成半个记号
      const text = callout.strip(ev.delta);
      state.finalParts.push(text); // 记的是**原文**：会话存盘、收尾判断都按原文来，渲染只是给眼睛看的一层
      answer(state.md ? state.md.write(text) : text);
    } else if (ev.type === "step_start") {
      if (ev.depth === 0) prog(dim(`\n· 第 ${ev.step} 步 思考中…`));
      state.streamed = false;
    } else if (ev.type === "parallel") {
      prog(dim(`\n  ▸▸ ${ev.count} ${ev.kind === "gen" ? "条生成任务一起跑" : "个只读工具并发执行"}`));
      state.streamed = false;
    } else if (ev.type === "tool_use") {
      const who = ev.expert ? `${ev.expert} · ` : "";
      prog(dim(`\n  ▸ ${who}${ev.name}${ev.purpose ? `（${String(ev.purpose).slice(0, 60)}）` : ""}`));
      state.lastToolId = ev.id;
      state.streamed = false;
    } else if (ev.type === "tool_result") {
      // 并发跑的时候回来的顺序不一定，勾不能盲目贴在最后一行——那是别人的行
      if (ev.id && state.lastToolId !== ev.id) prog(dim(`\n  ▸ ${ev.name}`));
      prog(ev.isError ? red(" ✗") : green(" ✓"));
      state.lastToolId = null;
      if (ev.isError && ev.preview) prog(dim("\n    " + String(ev.preview).slice(0, 200).replace(/\n/g, " ")));
      // 改文件那几步把 diff 摆出来：加的绿、删的红。改坏了当场看得见，/rewind 退回去
      if (!ev.isError && ev.diff) { prog("\n" + paintDiff(ev.diff)); state.streamed = false; }
    } else if (ev.type === "status") {
      if (ev.depth === 0 || ev.depth === undefined) { prog(dim(`\n· ${ev.text}`)); state.streamed = false; }
    } else if (ev.type === "expert_start") {
      prog(yellow(`\n  ◆ 委派专家「${ev.expert}」`) + dim(`：${String(ev.task || "").slice(0, 60)}`));
    } else if (ev.type === "limit") {
      prog(yellow(/^已手动停止/.test(ev.note || "") ? `\n▲ ${ev.note}` : `\n▲ ${ev.note}，任务强制收尾`));
    } else if (ev.type === "expert_done") {
      prog(dim(`\n  ◇ 专家「${ev.expert}」交活了`));
      state.streamed = false;
    } else if (ev.type === "team_start") {
      prog(yellow(`\n  ◆ 拉了一队人：${ev.team}`) + dim(`（${(ev.members || []).join("、")}）`));
      state.streamed = false;
    } else if (ev.type === "team_done") {
      prog(dim(`\n  ◇ ${ev.team} 这一队干完了`));
      state.streamed = false;
    } else if (ev.type === "failover") {
      // 这一条必须说：换渠道＝这趟活儿后半截是另一个模型答的，账也记到另一个渠道上。
      // 不说的话，人只会觉得「怎么后面风格变了」，还以为是自己提示词写崩了
      prog(yellow(`\n▲ ${ev.note}`));
      state.streamed = false;
    } else if (ev.type === "compact") {
      // 压缩是背着人做的，但它真的会改变模型手里有什么。一声不吭地把前面几十轮换成一份摘要，
      // 然后模型突然「忘了」刚才说好的事——不说清楚的话，这在终端里看起来就像模型坏了
      prog(dim(`\n· 上下文压缩：${ev.removed} 条旧对话换成一份摘要（原文存在 data/compact-archive）`));
      state.streamed = false;
    } else if (ev.type === "trim") {
      prog(dim(`\n· 上下文太长，截掉了 ${Math.round((ev.chars || 0) / 1000)}k 字符的旧工具输出`));
      state.streamed = false;
    } else if (ev.type === "auto_continue") {
      prog(dim(`\n· 没干完，自动接着来（第 ${ev.round}/${ev.total} 轮）：${String(ev.note || "").slice(0, 60)}`));
      state.streamed = false;
    } else if (ev.type === "sleep") {
      prog(dim(`\n· ${ev.note}`));
      state.streamed = false;
    } else if (ev.type === "milestones") {
      prog(dim(`\n· 进度表 ${ev.file}：${(ev.items || []).length} 项`));
      state.streamed = false;
    } else if (ev.type === "ask_answer") {
      // 问题和选项由 askUser 那边画（它得在人回答**之前**出现）；这儿只补一句超时的结局
      if (ev.timeout) prog(yellow(`\n· 没等到回答，它按自己的判断接着做了`));
      state.streamed = false;
    } else if (ev.type === "usage") {
      state.usage = ev;
    } else if (ev.type === "files") {
      state.files = ev.files || state.files;
      noteChanged(state, ev.changed);
    }
  };
}

function printSummary(state) {
  if (opts.json) {
    emitJson({ type: "done", ok: !state.error, error: state.error || null, session: sessionId,
      usage: state.usage || null, credits: state.credits || null,
      files: (state.files || []).map((f) => f.name), workspace: getWorkspaceDir() });
    return;
  }
  // 收尾补一个换行让文本文件规规矩矩地结束；正文自己已经以换行收尾就别再补一个
  if (state.md) {
    // 渲染器里可能还压着半行（等一个配对的 ** 没等到就结束了），这一下把它吐干净。
    // 它吐出来的行自带换行，所以只有「一个字都没吐过」时才需要补那一个
    answer(state.md.end());
    if (!state.finalParts.length) answer("\n");
  } else if (!/\n$/.test(state.finalParts.join(""))) answer("\n");
  if (state.usage) {
    const u = state.usage;
    const secs = Math.round((u.elapsed_ms || 0) / 1000);
    prog(dim(`\n✧ 共消耗 ${(u.prompt + u.completion).toLocaleString()} tokens（输入 ${u.prompt.toLocaleString()} / 输出 ${u.completion.toLocaleString()}）· ${u.calls} 次调用 · ${secs}s · ${u.provider}（${u.model}）\n`));
  }
  if (state.credits && state.credits.spent > 0) {
    prog(dim(`✦ 本次扣 ${state.credits.spent} 积分 · 余额 ${state.credits.balance.toLocaleString()}\n`));
  }
  if (state.files && state.files.length) {
    lastFiles = state.files.slice(-8).map((f) => f.name);
    prog(dim(`▪ 工作目录 ${getWorkspaceDir()}：`) + dim(lastFiles.join("、")) + "\n");
  }
}

/**
 * 上下文用到哪儿了。
 *
 * 聊到第几轮该开新会话，这件事以前在终端里完全是黑的：人只能等模型开始「忘事」才发现
 * 压缩已经发生过了。数字按跟 agent.js 同一套算——budget 是 max_context_chars，
 * 到 compact_threshold_chars（默认六成）就会在下一轮任务前自动压。两边算法必须一致，
 * 不然这儿显示 40%、那边已经压过一次，这个读数就是在骗人。
 */
function contextLine() {
  const { historyChars } = require("./agent");
  const ag = config.agent || {};
  const budget = ag.max_context_chars || 120000;
  const threshold = ag.compact_threshold_chars || Math.floor(budget * 0.6);
  const used = historyChars(sess.history || []);
  const pct = Math.round((used / budget) * 100);
  // 进度条只用 ASCII：方块字符在中文终端里按两列画，长度会跟着终端设置变
  const w = 20;
  const fill = Math.max(0, Math.min(w, Math.round((used / budget) * w)));
  const bar = "=".repeat(fill) + "-".repeat(w - fill);
  const when = ag.compact === false
    ? "（自动压缩关着）"
    : used > threshold ? "（下一轮开跑前会自动压一次）" : `（到 ${Math.round((threshold / budget) * 100)}% 自动压缩）`;
  return `上下文 [${bar}] ${pct}%　${Math.round(used / 1000)}k / ${Math.round(budget / 1000)}k 字符 ${when}`;
}

// ---------- 产出的图：终端里直接看见 ----------
/**
 * 记下这一轮真动过的产出。
 *
 * files 事件带两份名单：`files` 是「工作目录里现在有什么」——包含上个月那次任务留下的
 * 一堆东西；`changed` 才是「这一轮写过谁」。出图和「看图：…」只能认后者，
 * 认前者的话，一次什么图都没产出的对话，末尾也会冒出一句「看图：某张八月的封面.png」。
 *
 * 一轮里这个事件会响很多次，每次只报增量，所以得攒起来。
 * @param {{changed: string[]}} state
 * @param {string[]|undefined} changed
 */
function noteChanged(state, changed) {
  for (const n of changed || []) if (!state.changed.includes(n)) state.changed.push(n);
}

/**
 * 上一轮报给用户的那份产出清单（最多 8 个）。`/open 3` 数的就是它，
 * 跟屏幕上刚打出来的那行严格对齐——另去读一遍目录的话，顺序和内容都可能对不上。
 * @type {string[]}
 */
let lastFiles = [];
/** 终端出图能力探一次就够，一场里不会变 */
let imgCapCache = null;
const imgCap = () => (imgCapCache || (imgCapCache = termImage.detect(process.env, !!process.stderr.isTTY)));
/** 那句「你的终端要打开某个开关才能出图」只说一次，每轮都说就成了噪音 */
let capHintShown = false;

/**
 * 把这一轮产出的图贴到终端里。
 *
 * SVG 得先栅格化——终端的图形协议只收位图。转不动（不在桌面版里跑、本机又没装 Chrome）
 * 就安静跳过，下面那行「看图：…」兜底，不在这儿报错吓人：用户要的是看图，
 * 不是听一段关于渲染器的解释。
 *
 * @param {Array<{name: string}|string>} files 这一轮产出的（files 事件的 changed），不是整个工作目录
 * @returns {Promise<string[]>} 真画出来的文件名
 */
async function drawOutputs(files) {
  const cap = imgCap();
  const pick = termImage.pickDrawable(files, 3);
  if (!pick.length || !cap.proto || opts.quiet || opts.json) return [];
  const drawn = [];
  for (const name of pick) {
    let png = null;
    try {
      const p = path.join(getWorkspaceDir(), name);
      if (/\.svg$/i.test(name)) {
        const r = await require("./diagram").svgToPngAnyhow(fs.readFileSync(p, "utf8"));
        png = r && r.png;
      } else if (/\.png$/i.test(name) || cap.proto === "iterm") {
        // iTerm2 那套自己认格式，jpg/gif/webp 原样丢过去就行；
        // kitty 的 f=100 只认 PNG，别的位图这儿不画，让「看图：…」那行接手
        png = fs.readFileSync(p);
      }
    } catch { png = null; }
    if (!png || !png.length) continue;
    // 宽度按终端宽来，留两列边距；终端宽度读不到就按 80 算
    const cols = Math.max(20, Math.min(60, ((process.stderr.columns || 80) - 2)));
    process.stderr.write(dim(`▪ ${name}\n`) + termImage.encode(cap.proto, png, { name, cols }));
    drawn.push(name);
  }
  return drawn;
}

/**
 * 没画出来的图，告诉人怎么才能看到。
 * 交互模式里给 `/open`，一次性模式里给真能粘到 shell 里跑的那条命令——
 * 「用系统默认程序打开」这种话等于没说，人还得自己想命令叫什么。
 * @param {string[]} made 这一轮真产出的文件（不是整个目录——目录里那些是上个月的东西）
 * @param {string[]} drawn drawOutputs 已经画出来的，不用再提
 * @param {boolean} interactive
 */
function hintOutputs(made, drawn, interactive) {
  if (opts.quiet || opts.json) return;
  const rest = termImage.pickDrawable(made, 8).filter((n) => !drawn.includes(n));
  if (!rest.length) return;
  const cap = imgCap();
  if (cap.hint && !capHintShown) { capHintShown = true; prog(dim(`  ${cap.hint}\n`)); }
  if (interactive) {
    prog(dim(`  看图：/open ${rest[0]}`) + dim(rest.length > 1 ? `（或 /open 序号）\n` : "\n"));
    return;
  }
  const { cmd, args } = termImage.openerFor(process.platform, path.join(getWorkspaceDir(), rest[0]));
  prog(dim(`  看图：${[cmd, ...args].filter(Boolean).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}\n`));
}

// ---------- 执行一轮任务（Ctrl+C 停止当前任务而不是直接退出） ----------
/** 任务跑着的时候 = 停它的那个函数，空闲时 = null。交互模式的 Ctrl+C 从这儿调进去 */
let stopCurrent = null;
/** 终端里打的插话，下一步交给 agent。跟网页/手机上补的那句合并成一份 */
const termInterject = [];
/**
 * agent 问一句话时，正等着回答的那个人。
 *
 * 之前这里是空的——cli.js 不传 askUser，于是 agent.js 认定「当前是无人值守运行，没人在线回答」，
 * 让模型自己猜。最近在场的那个人反倒成了唯一问不到的人：网页上点一下就过的岔路
 * （报告交 Word 还是 PDF、封面走生图还是排版截图），在终端里全变成模型替你赌一把。
 *
 * 交互模式下答案从 inbox 那条口子进来（任务跑着的时候敲的字本来就走那儿），
 * 单发模式下现开一个 readline。两条路都往这个槽里放同一样东西：一个「收到答案」的函数。
 * @type {null | ((text: string|null) => void)}
 */
let pendingAsk = null;
/** 交互模式那个常驻 readline。单发模式下一直是 null——那边现开一个用完就关 @type {import("readline").Interface|null} */
let replRl = null;
/** 手机上先答了的时候，把终端这边那个还挂着的提示符撤掉 @type {null | (() => void)} */
let cancelAsk = null;
/** 此刻占着终端那个提示符的是哪道题。撤提示符之前得认一下，别把正等着的另一道题连坐撤掉 */
let askOwner = null;
/** 当前这趟活儿的现场：Ctrl+C 信号、交互还是单发。等回答的几处都要用 @type {null|{ctrl: AbortController, onSigint: () => void, interactive: boolean}} */
let askCtx = null;
/** 正在跑的那趟活儿的实时句柄（手机那一屏就是读它写的文件） @type {any} */
let liveNow = null;
/** 有人能回答吗：stdin 得是终端，且不是在给脚本喂 NDJSON。管道进来的内容早读完了，那头没人 */
const somebodyHome = () => !!process.stdin.isTTY && !opts.json;

// ---------- 手机/网页上答的那一句 ----------
/**
 * 答案到了、但问它的那个人已经不等了 —— 先存着。
 *
 * 为什么要这个抽屉：读回答用的是游标（读过的不再读），一次读会把文件里所有新行都取走。
 * 要是取回来的那条不是当前在等的这道题，直接丢掉就等于**这个答案永远消失**——
 * 手机上明明点了，终端里一直干等到超时。宁可存着没人来领，也不能读走了又扔掉。
 */
const remoteInbox = new Map();
const remoteWaiters = new Map(); // id -> 收到答案时叫谁
let remotePoll = null;

function remoteDeliver(a) {
  const id = String(a.id);
  const fn = remoteWaiters.get(id);
  if (fn) { remoteWaiters.delete(id); fn(a); return; }
  if (remoteInbox.size > 32) remoteInbox.clear(); // 攒到这个数只可能是陈货，留着也没人来领
  remoteInbox.set(id, a);
}

/**
 * 等手机上给这条 id 的回答。
 * @returns 撤销函数。最后一个等的人走了就把轮询停掉——空转着轮询一个没人等的文件没有意义
 */
function remoteWait(id, fn) {
  const key = String(id);
  const had = remoteInbox.get(key);
  if (had) { remoteInbox.delete(key); fn(had); return () => {}; }
  remoteWaiters.set(key, fn);
  if (!remotePoll) {
    remotePoll = setInterval(() => {
      if (!liveNow || !liveNow.live) return;
      for (const a of liveNow.answers()) remoteDeliver(a);
    }, 600);
    if (remotePoll.unref) remotePoll.unref();
  }
  return () => {
    remoteWaiters.delete(key);
    if (!remoteWaiters.size && remotePoll) { clearInterval(remotePoll); remotePoll = null; }
  };
}

/**
 * 终端和手机，谁先答算谁的。
 *
 * @param {string} id 这道题在实时目录里的编号
 * @param {() => Promise<string|null>} readTerminal 终端那条路
 * @param {(a: object) => string} mapRemote 手机上那条答案怎么变成终端里会敲的那半截
 */
function raceRemote(id, readTerminal, mapRemote) {
  askOwner = String(id);
  return new Promise((resolve) => {
    let settled = false;
    let off = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (off) off();
      if (askOwner === String(id)) askOwner = null;
      resolve(v);
    };
    off = remoteWait(id, (a) => {
      const cancel = cancelAsk; // 先抓住：done 之后这个槽可能已经被下一道题占了
      prog(yellow(`\n  » 手机上答了\n`));
      done(mapRemote(a));
      // 终端那个提示符还挂着一道已经有答案的题，不撤掉它会一直等到超时
      if (cancel) { try { cancel(); } catch {} }
    });
    readTerminal().then(done, () => done(null));
  });
}

/**
 * 在终端里读一行 —— 提问和审批共用这一条路。
 *
 * 没人坐在终端前（管道喂进来的、--json 给脚本读的）也照样进来：这儿不接键盘，
 * 只负责把超时和 Ctrl+C 变成 null，答案由手机那条路给。以前这种情况直接当「无人值守」，
 * 于是 `openworkbuddy < 任务.txt` 挂在后台时，agent 问的每一句都没人能答——手机在手上也没用。
 *
 * @returns {Promise<string|null>} null = 超时 / Ctrl+C / Ctrl+D / 被手机那边抢答后撤掉
 */
function termReadLine(promptText, timeoutMs) {
  const ctx = askCtx;
  const sig = ctx ? ctx.ctrl.signal : null;
  return new Promise((done) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sig) sig.removeEventListener("abort", onAbort);
      pendingAsk = null;
      cancelAsk = null;
      // 答完把提示符收回去：任务还在跑，这时候留着「答>」会跟着正文一起冲下来
      if (ctx && ctx.interactive && replRl) replRl.setPrompt("");
      done(v);
    };
    // 超时和 Ctrl+C 都还回 null：提问那边 agent 会带着「用户没回应」继续跑，
    // 审批那边 security 自己按拒绝收场——人走开了不该等于任务作废
    const timer = setTimeout(() => finish(null), Math.max(5000, Number(timeoutMs) || 300000));
    if (timer.unref) timer.unref();
    const onAbort = () => finish(null);
    if (sig) sig.addEventListener("abort", onAbort, { once: true });
    cancelAsk = () => finish(null);
    if (!somebodyHome()) return; // 这头没人，只等手机和超时
    pendingAsk = finish;
    if (ctx && ctx.interactive && replRl) { replRl.setPrompt(askPrompt(promptText)); replRl.prompt(); return; }
    // 单发模式没有常驻 readline，现开一个。它自己接管 stdin，用完就关
    const one = readline.createInterface({ input: process.stdin, output: process.stderr, prompt: askPrompt(promptText) });
    one.prompt();
    cancelAsk = () => { try { one.close(); } catch {} };
    // 顺序不能反：one.close() 会**同步**触发下面那个 close 处理器，
    // 先关再 finish 的话，finish(null) 抢在 finish(t) 前面把 settled 占掉——
    // 人明明答了，agent 收到的却是「没人回应」。实测就是这样错了一版
    one.on("line", (t) => { finish(t); one.close(); });
    one.on("close", () => finish(null)); // Ctrl+D：当没回答（已经答过的话 finish 自己会挡掉）
    // readline 在 TTY 上会把 Ctrl+C 截成自己的事件，外面那个 process.on("SIGINT") 收不到。
    // 不接这一下，等回答的时候按 Ctrl+C 就什么都不会发生
    one.on("SIGINT", () => { try { one.close(); } catch {} if (ctx) ctx.onSigint(); });
    if (sig) sig.addEventListener("abort", () => { try { one.close(); } catch {} }, { once: true });
  });
}

let askSeq = 0;
const newId = (p) => `${p}_${Date.now()}_${++askSeq}`;

/**
 * agent 问一句：终端里摆出来，同时推到手机上。
 *
 * 两头哪头先答都算数。推到手机上这件事不是锦上添花——人起了个长任务就去开会了，
 * 中途那道岔路要么等他回来（几十分钟白烧），要么模型替他赌一把。
 */
async function askUserBoth(ask) {
  const id = newId("ask");
  const timeoutMs = Math.max(30000, Number(ask && ask.timeoutMs) || 300000);
  const live = liveNow;
  if (live) {
    live.pend({
      id, type: "ask",
      question: String((ask && ask.question) || ""),
      options: cliAsk.normalize(ask && ask.options),
      deadline: Date.now() + timeoutMs,
    });
  }
  try {
    return await makeAskUser((promptText, ms) =>
      raceRemote(id, () => termReadLine(promptText, ms), (a) => (a.value == null ? "" : String(a.value))))(ask);
  } finally {
    if (live) live.unpend(id);
  }
}

/**
 * 一条危险操作求批准：终端里摆出来，同时推到手机上。
 *
 * 不接这个钩子的话，命令行里的审批长这样：卡住两分钟，然后「用户未批准」——
 * 而人从头到尾没被问过。超时对审批来说等于拒绝，所以「没人看见」和「看见了不同意」
 * 在日志里长得一模一样，这是最糟的一种沉默。
 */
async function handleApproval(entry) {
  const live = liveNow;
  const deadline = Number(entry.deadline) || Date.now() + 120000;
  const timeoutMs = Math.max(5000, deadline - Date.now());
  if (live) live.pend(cliApprove.card(entry, deadline));
  let v = null;
  try {
    v = await cliApprove.run(entry, {
      write: (x) => process.stderr.write(x),
      readLine: (promptText, ms) => raceRemote(entry.id, () => termReadLine(promptText, ms),
        (a) => (a.allow ? (a.scope === "session" || a.scope === "always" ? "2" : "1") : "3")),
      timeoutMs,
      width: (process.stderr.columns || 80) - 2,
      paint: (x, k) => ({
        warn: (y) => bold(yellow(y)), n: (y) => (ttyErr ? `\x1b[36m${y}\x1b[0m` : y),
        label: bold, detail: dim, hint: dim, code: (y) => (ttyErr ? `\x1b[35m${y}\x1b[0m` : y),
        add: green, del: red, // 改文件的 diff：加的绿、删的红
      }[k] || ((y) => y))(x),
    });
  } finally {
    if (live) live.unpend(entry.id);
  }
  if (!v) return; // 超时 / Ctrl+C：不去 resolve，让 security 按它自己那套（拒绝）收场
  const r = security.resolveApproval(entry.id, v.allow, v.scope);
  if (!r || !r.ok) return; // 手机上已经点过了，或者已经超时——这是正常的竞态，不用报错
  if (!v.allow) prog(yellow("  ✗ 没批准，它会换个办法或者告诉你卡在哪\n"));
  else if (v.scope === "session") prog(green("  ✓ 批了；本次运行期间同类不再问\n"));
  else prog(green("  ✓ 批了这一次\n"));
}

/**
 * 把一次提问摆到终端上，等一个答案。
 *
 * 问题走 **stderr**：`openworkbuddy "…" > 报告.md` 的时候答案在文件里，问题得还在人眼前。
 * 也不受 --quiet 管——把一道正在等回答的选择题静音，换来的不是清净是卡死。
 *
 * @param {(prompt: string) => Promise<string|null>} readLine 怎么读这一行（两种模式各给各的）
 * @returns {(a: {question: string, options: any[], timeoutMs: number}) => Promise<string|null>}
 */
/** 等回答时的提示符。跟平时那个 `openworkbuddy>` 换个颜色和字，一眼看出来现在是它在等你，不是你在等它 */
const askPrompt = (t) => (ttyErr ? `\x1b[33m${t}\x1b[0m` : t);

function makeAskUser(readLine) {
  const paint = {
    q: (x) => bold(yellow(x)),
    n: (x) => (ttyErr ? `\x1b[36m${x}\x1b[0m` : x),
    label: bold, detail: dim, hint: dim, warn: yellow,
  };
  // 「同时摆到手机上」是 askUserBoth 的活儿，不在这儿重做一遍：
  // 两处都 pend 的话，同一道题会在手机上并排出现两张卡、各带一个 id，
  // 而 agent 只认 askUserBoth 那个 id——点另一张的人会发现点了没反应。
  return async (ask) => cliAsk.run(ask, {
    write: (x) => process.stderr.write(x),
    readLine: (promptText, deadline) => readLine(promptText, deadline),
    width: (process.stderr.columns || 80) - 2,
    paint: (x, k) => (paint[k] || ((y) => y))(x),
  });
}

/**
 * 撞车才隔离：别的任务（另一个终端、或者网页那边）此刻正在改同一个 git 仓库，
 * 这一趟就去自己的 worktree 里改，改完把分支名和合回去的命令交出来。见 worktree.js 开头。
 *
 * 为什么包一层而不是写进 runOnce 里：交互模式下 runOnce 是在 REPL 那条异步链上被 await 的，
 * 在里头 enterWorkspace 会把工作目录**留给 REPL**——跑完一趟之后 /cwd 显示的还是那个分身目录，
 * 用户从此在一个他没听说过的地方干活。withWorkspace 是有边界的，出了这个函数自动还原。
 */
async function runOnce(runtime, text, mode, interactive) {
  const wt = require("./worktree");
  const STORE = dataPath("data", "worktrees");
  let opened = null;
  try {
    const busy = cliLive.list({ prune: false })
      .filter((r) => r.live && r.cwd && r.id !== sessionId)
      .map((r) => ({ session: r.id, dir: r.cwd }));
    const p = wt.plan(getWorkspaceDir(), { session: sessionId, busy });
    if (p.need) {
      const o = wt.open(STORE, { repo: p.repo, session: sessionId });
      if (o && o.dir) opened = o;
      else if (o && o.error) process.stderr.write(dim("（分身没开成，照旧在原工作区跑：" + o.error + "）\n"));
    }
  } catch {} // 隔离判断出错绝不能让任务起不来：退回老样子就是这个功能上线前的样子
  if (!opened) return runOnceIn(runtime, text, mode, interactive);
  process.stderr.write(yellow(wt.hint(opened)) + "\n");
  try {
    return await require("./tools").withWorkspace(opened.dir, () => runOnceIn(runtime, text, mode, interactive));
  } finally {
    try {
      const rel = wt.release(STORE, opened.dir, { title: text.slice(0, 40) });
      process.stderr.write(dim(rel && rel.removed ? "（这趟没留下改动，分身已经收掉）\n" : wt.hint(rel) + "\n"));
    } catch {}
  }
}

/** @returns {"ok"|"error"|"aborted"} 给退出码用 */
async function runOnceIn(runtime, text, mode, interactive) {
  // 积分闸门：默认是关的（本地个人用不限额），开了才拦。CLI 消耗记在管理员（首个注册用户）名下
  const owner = account.defaultUser();
  if (owner && account.creditsEnabled() && owner.credits <= 0) {
    process.stderr.write(red(`积分不足（${owner.username} 余额 0）：去 Web 端「账号 · 用量」里充值，或者把「积分限额」关掉。\n`));
    return "error";
  }
  sess.history.push({ role: "user", content: text });
  if (!sess.title) sess.title = text.slice(0, 24);
  // 在终端里起的活儿归「工程」线。网页/手机上切到那个标签就能看见这条会话——
  // 这是两条线里唯一一条服务端替人填的：它确实是从命令行进来的，不是猜的。
  sess.lane = "cli";
  const state = { streamed: false, usage: null, files: null, changed: [], finalParts: [], error: null, md: newMdRenderer() };
  // 挂到实时目录上：网页端的「工程」标签就是靠它知道这台机器的终端里此刻在干什么
  const live = cliLive.announce({
    id: sessionId, title: sess.title || text.slice(0, 60), cwd: getWorkspaceDir(),
    mode, user: owner ? owner.username : "",
  });
  state.live = live;
  live.event({ type: "status", text: `终端里起了一趟活儿：${text.slice(0, 60)}` });
  // 心跳：模型想得久的时候一个事件都不出，光靠事件盖时间戳会被判成「这进程死了」
  const beatTimer = live.live ? setInterval(() => live.beat(), cliLive.BEAT_MS) : null;
  if (beatTimer && beatTimer.unref) beatTimer.unref();
  const ctrl = new AbortController();
  let aborted = false;
  const onSigint = () => {
    if (aborted) {
      // 第二次：不等了。收尾还是要做——MCP 那几个子进程是 spawn 出来的，
      // 不收就留在系统里，下次启动还会再起一批
      process.stderr.write(yellow("\n（不等了，直接退出）\n"));
      try { mcpManager.stopAll(); } catch {}
      process.exit(130);
    }
    aborted = true;
    prog(yellow("\n（收到 Ctrl+C，正在停止任务…再按一次直接退出）\n"));
    ctrl.abort();
  };
  // 单发模式走信号；交互模式下 readline 在终端里把 Ctrl+C 自己截住了，进程根本收不到，
  // 所以那边改从 stopCurrent 这个把手调进来——改写前那条路在交互模式下从来没通过
  process.on("SIGINT", onSigint);
  stopCurrent = onSigint;
  // 等回答的那几处（提问、审批）要用到这一趟的 Ctrl+C 信号和实时句柄
  askCtx = { ctrl, onSigint, interactive: !!interactive };
  liveNow = live;
  // 危险操作求批准时，把卡片同时摆到终端和手机上。不订这个钩子的话，
  // 命令行里的审批就是「卡住两分钟然后被拒」，人从头到尾没被问过
  const offApproval = security.watchApprovals((ev) => {
    if (ev.type === "open") { handleApproval(ev.entry).catch(() => {}); return; }
    // 别处点过了 / 超时了：把手机上那张卡撤下来，别留着一个点了没反应的按钮
    if (ev.type === "close") {
      live.unpend(ev.id);
      // 只撤这条自己的提示符：认 id 才行，不然会把同时挂着的另一道题一起撤了
      if (askOwner === String(ev.id) && cancelAsk) { try { cancelAsk(); } catch {} }
    }
  });
  let finalText = "";
  // Goal 模式：第一次用这句话建目标（拆成验收标准），已有进行中的目标就直接接着冲。
  // 目标卡存在会话里，跟网页端是同一份——在手机上起的头，回到终端 `openworkbuddy -s <会话>` 能接着干。
  if (modes.isGoalMode(mode)) {
    if (!sess.goal || sess.goal.status !== "active") {
      prog(dim("拆验收标准…\n"));
      try { sess.goal = await goalKit.start(goalThink, text); }
      catch (e) { prog(yellow(`拆验收标准失败：${e.message}\n`)); }
    }
    if (sess.goal && sess.goal.status === "active") sess.goal.paused = ""; // 又开跑了，把「已暂停」摘掉
    if (sess.goal) { printGoalCard(sess.goal); live.event({ type: "goal", goal: sess.goal }); }
  }
  try {
    // 外层：目标轮。普通模式只走一轮；goal 模式没达标自动再跑，最多 goalKit.MAX_ROUNDS 轮
    let roundStopped = null;
   for (let goalRound = 0; ; goalRound++) {
    roundStopped = null;
    const r = await runtime.runTask({
      history: sess.history,
      sessionId, // 文件检查点记在这个会话名下，/rewind 才知道哪些是这趟活儿改的
      // 进行中的目标注进任务上下文：agent 每一轮都对着验收标准干活，不跑偏
      projectContext: goalKit.contextFor(sess.goal) || undefined,
      emit: makeEmit(state),
      mode: modes.agentMode(mode), // goal 在外面那层循环里，agent 只认识 ask/plan/craft
      user: owner ? owner.username : undefined, // 记忆按人取，命令行走管理员这本账
      stopSignal: ctrl.signal,
      // 底层 CLI 引擎的线程 id：跟会话存在一起，所以在桌面开的头能在这儿接着跑，反过来也一样
      engineSession: lanes.engineSessionFor(sess, cfgEngine()),
      // 能问就问。终端前有人当然能问；人起了长任务就去开会了也照样能问——askUserBoth
      // 会把这一句同时推到手机上，两头哪头先答都算数。
      //
      // ⚠️ 但「播出去了」不等于「有人在看」。live.live 只说明这趟活儿在盘上登记了，
      // 没人扫过码、手机根本没打开的时候它一样是 true。管道喂进来的 `openworkbuddy < 任务.txt`、
      // 挂在 crontab 里的 --json，那头确实没人：按「有人」算的话，模型每问一句都要
      // 干等满 5 分钟超时才肯往下走，一个夜里跑的批处理能就此堵成早上还没跑完。
      // 所以默认按 TTY 判；确实打算「人不在电脑前、答案从手机上给」的，显式写 --ask-remote。
      askUser: (somebodyHome() || (opts.askRemote && live.live)) ? askUserBoth : undefined,
      // 网页/手机上补的那句话，在两步之间读走。终端这边也回显一下——
      // 不然坐在电脑前的人只会看见 agent 突然改了主意，不知道是有人从手机上插了一句
      getInterject: () => {
        const more = live.interjections();
        // 坐在电脑前的人也能插话：任务跑着的时候在终端里打的字排在 termInterject 里，
        // 跟手机上补的那句走同一个口子
        if (termInterject.length) more.push(...termInterject.splice(0));
        if (more.length) prog(yellow(`\n  » 收到插话：${more.join(" / ").slice(0, 120)}\n`));
        return more;
      },
    });
    if (r && r.sessionId) lanes.rememberEngineSession(sess, r.engine || cfgEngine(), r.sessionId);
    if (r && r.finalText) finalText = r.finalText;
    if (r && r.stopped) roundStopped = r.stopped;

    // 没有进行中的目标 / 用户按了 Ctrl+C → 不验收不加轮
    if (!sess.goal || sess.goal.status !== "active" || ctrl.signal.aborted) break;
    sess.goal.note = "";
    sess.goal.paused = "";
    prog(dim("\n对着验收标准验收…\n"));
    // 证据用「这一轮真写过的文件」，不是整个工作目录：命令行的工作目录常常是个大仓库，
    // 整个扫进去等于拿别人早就写好的文件给这一轮打勾
    await goalKit.verify(goalThink, sess, finalText, (w) => { sess.goal.note = w; }, state.changed);
    sess.goal.round = (sess.goal.round || 0) + 1;
    printGoalCard(sess.goal);
    live.event({ type: "goal", goal: sess.goal });
    saveSess();
    if (sess.goal.status === "done") break;
    if (!modes.isGoalMode(mode)) break;
    // 自动补跑用完了。别悄悄不跑——写清楚为什么停、还差几项，要不要接着烧钱交回给用户
    if (goalRound + 1 >= goalKit.MAX_ROUNDS) {
      sess.goal.paused = `自动补跑已用满 ${goalKit.MAX_ROUNDS} 轮，还差 ${goalKit.progress(sess.goal).unmet} 项没达成`;
      prog(yellow(`  暂停：${sess.goal.paused}；想接着冲就再说一句「继续」\n`));
      live.event({ type: "goal", goal: sess.goal });
      saveSess();
      break;
    }
    // 这轮是被超时/上限硬切断的：同样的条件再跑一轮大概率原样再撞，别把用户的时间和钱烧在死循环里
    if (roundStopped) {
      sess.goal.paused = `这轮任务被强制收尾（${roundStopped}），暂停自动补跑`;
      prog(yellow(`  暂停：${sess.goal.paused}；解决后说一句「继续」接着冲\n`));
      live.event({ type: "goal", goal: sess.goal });
      saveSess();
      break;
    }
    const fb = goalKit.feedbackFor(sess.goal);
    sess.history.push({ role: "user", content: fb });
    prog(dim(`\n  » 第 ${sess.goal.round + 1} 轮：只补没达成的那几项\n`));
   }
  } catch (e) {
    state.error = e.message;
    process.stderr.write(red(`\n出错了：${e.message}\n`));
  }
  process.removeListener("SIGINT", onSigint);
  stopCurrent = null;
  offApproval();
  askCtx = null;
  liveNow = null;
  if (beatTimer) clearInterval(beatTimer);
  live.finish({ error: state.error, title: sess.title });
  // --json 下正文没走 stdout，最终文本从事件里攒回来，落盘的内容两种模式必须一样
  if (!finalText && state.finalParts.length) finalText = state.finalParts.join("");
  // 落盘：Web 端打开该会话也能回放（最终文本 + 用量）
  sess.transcript.push({ type: "user", text, mode, at: new Date().toISOString() });
  const events = [];
  if (finalText) events.push({ type: "text", delta: finalText });
  if (state.usage) events.push(state.usage);
  sess.transcript.push({ type: "assistant", events, at: new Date().toISOString() });
  saveSess();
  // 记账：与 Web 端同一本账（data/usage/<年-月>.jsonl，按月分片、一笔一行只追加；见 usage-store.js）
  if (owner && state.usage && state.usage.calls > 0) {
    const spent = account.chargeRun(owner, { ...state.usage, source: "cli", sessionId });
    state.credits = { spent, balance: owner.credits };
  }
  printSummary(state);
  // 图在最后：用量、积分、产出清单都打完了再贴，顺序反过来的话图会把那几行顶到屏幕外面
  hintOutputs(state.changed, await drawOutputs(state.changed), !!interactive);
  return aborted ? "aborted" : state.error ? "error" : "ok";
}

/** 管道进来的内容。没接管道（stdin 是终端）就返回空串，绝不阻塞等输入。 */
function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { buf += d; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
}
const STDIN_MAX = 200000; // 再多就不是「材料」是「数据集」了，该让 agent 自己去读文件

// ---------- 带进来的文件 ----------
// 用户原话：「还有我的 cli 也要支持复制文件 图片这些啊」（原话里用的是改名前的旧命令名）。
//
// 终端里把文件带进来有三条路，三条都得认：从访达把文件拖进窗口（粘出来的是反斜杠
// 转义过的路径）、用「拷贝路径」粘进来（空格没转义，只有整行当一条路径才认得出）、
// 或者敲 `@` 让它列工作目录里有什么。再加一个 /paste 直接吃剪贴板里的截图。
//
// 要紧的是**文件不进对话历史**：跟网页端走同一套约定——先把文件搬进工作目录，正文后面
// 挂一句「（已上传文件：…）」，让模型自己决定是 look_at_image 还是 read_file。图片一旦
// 进了历史，往后每一步都要重发一遍，纯文本模型还会当场 400；而会话是存盘的，那就等于
// 把这个会话永久弄坏了。所以带文件的正确做法只有一种：给个名字，让它自己去看。
let visionWarned = false;
/** 把认出来的文件搬进工作目录，返回给模型看的名字；搬不动的当场说清楚为什么 */
function bringIn(files) {
  if (!files || !files.length) return [];
  const r = attach.collect(files, { workspaceDir: getWorkspaceDir() });
  for (const s of r.skipped) prog(yellow(`  ！${s.ref} 没带上：${s.why}\n`));
  if (r.names.length && attach.anyImage(r.names) && !visionWarned) {
    visionWarned = true;
    const v = (config.media || {}).vision || {};
    // 不吭声地把图交出去，回头模型说「我看不了图」，人只会以为是自己路径写错了
    if (!(String(v.base_url || "").trim() && String(v.model || "").trim())) {
      prog(dim(`  没单独配视觉模型，图交给主模型（${llm.model}）试着看；它要是纯文本的就看不了，设置 → 模型 → 视觉模型 配一个就行\n`));
    }
  }
  return r.names;
}
/** 一行话里哪几个词是文件。相对路径先按工作目录找，再按人现在所在的目录找 */
function splitFiles(text) {
  return attach.parseLine(text, {
    home: os.homedir(),
    roots: [getWorkspaceDir(), process.cwd()],
    exists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
  });
}

// ---------- 主流程 ----------
(async () => {
  // ---------- openworkbuddy engines：看本机能拿什么当底层，以及一键切过去 ----------
  if (sub === "engines") {
    const engines = require("./engines");
    const want = words[0] === "use" ? String(words[1] || "").trim() : "";
    if (words[0] === "use") {
      if (engines.get(want) === undefined) {
        process.stderr.write(red(`没有这个引擎：${want}。可选：${engines.list().map((b) => b.id).join(" / ")}\n`));
        process.exit(1);
      }
      if (want !== "builtin") {
        // 切过去之前先确认它真的装了。让用户以为切成功、下一次跑任务才报错，是最难查的那种坑
        const found = (await engines.detectAll((config.agent || {}).engine_options || {})).find((e) => e.id === want);
        if (!found || !found.installed) {
          const b = engines.get(want);
          process.stderr.write(red(`${b.label} 没装或跑不起来，没有切换。\n`) + dim(`装法：${b.install}\n`));
          process.exit(1);
        }
      }
      // 临存盘前再读一遍。上面那次读到这儿中间隔着一次引擎探测，能跑好几秒——
      // 这期间桌面端那个进程很可能刚存过一次配置。拿几秒前的整份内存盖回去，人家刚改的就没了。
      const latest = store.readJson(CONFIG_PATH, config) || config;
      latest.agent = latest.agent || {};
      latest.agent.engine = want;
      store.writeJsonAtomic(CONFIG_PATH, latest, { pretty: true });
      process.stdout.write(green(`底层引擎已切到「${(engines.get(want) || engines.BUILTIN).label}」\n`));
      process.exit(0);
    }
    const cur = (config.agent || {}).engine || "builtin";
    const found = await engines.detectAll((config.agent || {}).engine_options || {});
    const rows = [{ ...engines.BUILTIN, installed: true, version: "" }, ...found];
    for (const e of rows) {
      const mark = e.id === cur ? green(" ●") : "  ";
      const state = e.id === "builtin" ? "" : e.installed ? green(`已装 ${e.version}`) : yellow("没装");
      process.stdout.write(`${mark} ${e.id.padEnd(12)} ${e.label}  ${state}\n`);
      process.stdout.write(dim(`     ${e.note}\n`));
      if (!e.installed && e.install) process.stdout.write(dim(`     装法：${e.install}\n`));
    }
    process.stdout.write(dim("\n切换：openworkbuddy engines use <id>。选了本机 Claude Code / Codex，任务就跑在你已经付过钱的订阅上，不再消耗 API 额度。\n"));
    process.exit(0);
  }

  if (opts.list) {
    const rows = listCliSessions(opts.list);
    if (!rows.length) { process.stdout.write("（还没有任何会话）\n"); process.exit(0); }
    for (const r of rows) {
      // 本地时间。toISOString() 给的是 UTC，跟会话 id 里那串本地时间戳差一个时区，
      // 同一个会话在 id 上写着 17:36、在列表里显示 09:36，照时间挑会挑错。
      const d = new Date(r.mtime), q = (n) => String(n).padStart(2, "0");
      const when = `${d.getFullYear()}-${q(d.getMonth() + 1)}-${q(d.getDate())} ${q(d.getHours())}:${q(d.getMinutes())}`;
      process.stdout.write(`${r.id}  ${when}  ${r.from}  ${String(r.turns).padStart(3)} 轮  ${r.title}${r.engine ? dim("  [" + r.engine + "]") : ""}\n`);
    }
    process.stdout.write(dim(`\n续接：openworkbuddy resume <id> "接着做…"；不给 id 就接最近动过的那个（桌面开的也能接）\n`));
    process.exit(0);
  }

  // 带进来的文件。这一步必须排在读管道**前面**：`cat 报错.log | openworkbuddy "这什么意思"` 里
  // 提到的路径是材料不是附件，扫一遍会把人家日志里随口提到的文件都搬进工作目录
  const namedFiles = [];
  for (const ref of opts.files) {
    const raw = attach.expandHome(attach.fromFileUrl(ref) || ref, os.homedir());
    const tries = path.isAbsolute(raw) ? [raw] : [path.resolve(process.cwd(), raw), path.resolve(getWorkspaceDir(), raw)];
    const hit = tries.find((x) => { try { return fs.existsSync(x); } catch { return false; } });
    // -f 是人明说的，找不到就当场停。让模型对着一个不存在的文件名瞎猜，钱花了事没办
    if (!hit) { process.stderr.write(red(`-f ${ref}：找不到这个文件\n`)); process.exit(2); }
    namedFiles.push({ ref, path: hit });
  }
  const shot = splitFiles(oneShot);
  for (const m of shot.missing) prog(yellow(`  ！${m} 找不到，当普通文字发过去了\n`));
  if (shot.files.length) oneShot = shot.text; // 没摘出东西就一个字都不动，双空格之类的原样留着
  const wanted = namedFiles.concat(shot.files);

  // 管道：有任务描述时当附加材料，没有时管道内容本身就是任务（openworkbuddy < 任务.txt）
  const piped = await readStdin();
  if (piped.trim()) {
    const body = piped.length > STDIN_MAX
      ? piped.slice(0, STDIN_MAX) + `\n…（标准输入共 ${piped.length} 字符，这里只截了前 ${STDIN_MAX} 个）`
      : piped;
    oneShot = oneShot
      ? `${oneShot}\n\n---\n以下是从标准输入读到的内容：\n\n${body}`
      : body.trim();
  }
  // 先判「有没有话要问」，再往工作目录里搬东西：搬完才发现没话可问，人补一句重跑，
  // 工作目录里就多出一份 报告-2.md——同一个文件躺两遍，之后谁也说不清该看哪一个
  if (!oneShot && wanted.length) {
    process.stderr.write(red(`带上了 ${wanted.map((f) => path.basename(f.path)).join("、")}，可没说要拿它干什么。\n`));
    process.stderr.write(dim(`把要问的话也写上：openworkbuddy -f 图.png "这张图里写了什么"\n`));
    process.exit(2);
  }
  if (!oneShot && !process.stdin.isTTY) { console.log(cliArgs.helpText()); process.exit(1); }
  const attachNames = bringIn(wanted);
  if (attachNames.length) prog(dim(`  带上了 ${attachNames.join("、")}\n`));

  if (opts.mcp && (config.mcp_servers || []).length) {
    // 在界面上关掉的那几台，命令行里也别连——同一份 config，两边看见的工具表就该是同一份
    mcpManager.setDisabled(config.mcp_disabled || []);
    const on = config.mcp_servers.filter((x) => !mcpManager.disabled.has(x.name));
    prog(dim(`连接 MCP（${on.length} 个${on.length < config.mcp_servers.length ? `，另有 ${config.mcp_servers.length - on.length} 个已关` : ""}，--no-mcp 可跳过）… `));
    await mcpManager.startAll(config.mcp_servers);
    prog(dim(`${mcpManager.toolDefs().length} 个工具\n`));
  }
  const runtime = createAgentRuntime({ config, llm, mcpManager, experts, expertTeams });
  const engineId = (config.agent || {}).engine || "builtin";
  const engineBackend = require("./engines").get(engineId);
  const who = engineBackend ? `底层 ${engineBackend.label}` + green("（不花 API 额度）") : `模型 ${llm.provider}（${llm.model}）`;
  // 权限档只在「不是默认那档」时印。默认 auto 天天见，印了就是噪音；
  // 而 full（命令也不问了）和 plan（一个字都不写）恰恰是那种「以为自己在另一档」会出事的状态，
  // 必须让人在第一行就看见——尤其 --perm 是一次性的，退出就没了，更不该只存在于自己的记忆里。
  // full 单独多说半句：这一档连「删除保护」一起关掉（rm 类命令在别的档位都要点头，这档不问了），
  // 这是 e2e 里钉死的设计，不是漏洞——但一个打了 --perm full 就走开的人，得先在这行里看见它。
  const permLine = permNow() === security.DEFAULT_MODE ? ""
    : ` · 权限 ${security.PERMISSION_MODES[permNow()].label}${permNow() === "full" ? yellow("（连删除也不问了）") : ""}`;
  prog(dim(`${who} · 模式 ${modes.modeLabel(opts.mode)}${permLine} · 工作目录 ${getWorkspaceDir()} · 会话 ${sessionId}\n`));

  if (oneShot) {
    const r = await runOnce(runtime, attach.withNote(oneShot, attachNames), opts.mode);
    mcpManager.stopAll();
    process.exit(r === "ok" ? 0 : r === "aborted" ? 130 : 1);
  }

  // ---- REPL ----
  // 这一段是重写过的。改写前有四样毛病，在健康机器上一个都不报错，只是悄悄办错事：
  //   1. 粘贴多行只进去第一行——readline 一个换行一个 line 事件，rl.question 一次只接一条，
  //      剩下的没人接、静默丢掉（实测贴 4 行进去，循环只收到 1 行）。
  //   2. Ctrl+C 停不掉任务——终端模式下 readline 自己把 Ctrl+C 截走了，
  //      runOnce 里那句 process.once("SIGINT") 在交互模式下从来没被调用过。
  //   3. 打错的斜杠命令（/exi、/moe）整行当任务发给模型，钱花了事没办。
  //   4. Ctrl+D 之后等在 question 上的 Promise 永远不 resolve，MCP 子进程跟着挂死。
  // 现在一行输入先过 repl-commands 那张纯表，再由这儿决定怎么说、怎么做。
  const repl = require("./repl-commands");
  const PROMPT = ttyErr ? "\x1b[36mopenworkbuddy>\x1b[0m " : "openworkbuddy> ";
  const HIST_FILE = dataPath("data", "cli-history.txt");
  const loadHistory = () => {
    // 文件里老的在前（跟 bash 一样，人直接 cat 也顺眼），readline 要的是新的在前
    try { return repl.sanitizeHistory(fs.readFileSync(HIST_FILE, "utf8").split("\n").reverse()); } catch { return []; }
  };
  const saveHistory = () => {
    // 里面是这个人自己的任务原话，权限跟 config.json 一个待遇（store.SECRET_MODE = 0600）
    try {
      const list = repl.sanitizeHistory(Array.isArray(rl.history) ? rl.history : []);
      if (!list.length) return;
      fs.mkdirSync(path.dirname(HIST_FILE), { recursive: true });
      fs.writeFileSync(HIST_FILE, list.slice().reverse().join("\n") + "\n", { mode: store.SECRET_MODE });
      store.tighten(HIST_FILE, store.SECRET_MODE); // writeFileSync 的 mode 过 umask，老文件也得补收一次
    } catch {}
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT,
    completer: completeLine,
    history: loadHistory(),
    historySize: repl.HISTORY_MAX,
    removeHistoryDuplicates: true,
  });
  replRl = rl; // runOnce 里等回答时要用它读一行，那边在这个闭包外面

  // 输入侧：line 事件原样交给 repl.makeInbox——合并粘贴、排队、插话、关掉时叫醒等着的那个人，
  // 全在那张纯逻辑里。时钟和定时器能从外面塞进去，所以这套时序在测试里可以手动推、逐帧断言
  let quitArmed = 0;
  // 带上了、还没跟着问题发出去的文件名。拖一个文件进来先攒着，等人把要问的话打完再一块儿发——
  // 拖进来的那一下就发出去，等于让模型自己猜要拿这个文件干嘛
  const pending = [];
  const inbox = repl.makeInbox({
    onInterject: (text) => {
      // 它正等着一个答案：这一行是回答，不是插话。不先认这一条的话，
      // 人明明回答了，agent 却在那儿干等到超时，然后按「没人回应」自己定
      if (pendingAsk) { const f = pendingAsk; pendingAsk = null; f(text); return; }
      // 任务跑着的时候敲的字是「插话」，不是下一条任务
      termInterject.push(text);
      prog(yellow(`\n  » 记下了，下一步带给它：${text.replace(/\n/g, " ").slice(0, 60)}\n`));
    },
    onMerged: (n, blocks) => {
      // 粘进来的 N 行，readline 一行一条记进了历史。合成一条之后把多出来的退掉，
      // 不然往上翻一次只翻回一行，还把真正有用的历史挤没了
      if (n > 1 && blocks.length === 1 && Array.isArray(rl.history)) rl.history.splice(0, n - 1);
      saveHistory();
    },
  });
  rl.on("line", (raw) => inbox.line(raw));
  rl.on("close", () => { menuClose(); inbox.close(); });

  // ---- 打 `/` 就把菜单弹出来 ----
  // 用户原话：「怎么cli模型，我输入/的时候没有自动补全啊」。Tab 补全一直是有的，
  // 但一个记不住命令的人第一反应是打个 `/` 等着看有什么，不会去按 Tab。
  //
  // 画在输入行**下面**，每次按键擦掉重画。两条守则：
  //   1. **相对移动，不算绝对行号。** 先用换行把光标顶下去（顶到屏幕底会自然滚屏），
  //      再按同样的行数往回移——滚没滚都不会错位，这是终端里唯一稳的做法。
  //   2. **没挑过就不替人做主。** 只弹不选：直接回车按原样发走，只有按过 ↑↓ 或 Tab
  //      才算「我挑了这条」。不然人打了一半的字会被菜单悄悄换掉。
  // 任何一步出岔子（终端不认这些指令、Node 换了内部实现）就整场关掉菜单：
  // 宁可回到「按 Tab 补全」，也不能把人的输入行搅成一团。
  const tw = require("./text-width"); // 中文占两列，对齐一律走它
  const MENU_MAX = 6;
  const menuState = { rows: 0, items: [], sel: -1, dead: false };
  const menuUsable = () => !menuState.dead && !!process.stdout.isTTY && !!process.stdin.isTTY;

  function menuErase() {
    if (!menuState.rows) return;
    try {
      const col = rl.getCursorPos().cols;
      readline.moveCursor(process.stdout, 0, 1);
      readline.cursorTo(process.stdout, 0);
      readline.clearScreenDown(process.stdout);
      readline.moveCursor(process.stdout, 0, -1);
      readline.cursorTo(process.stdout, col);
    } catch { menuState.dead = true; }
    menuState.rows = 0;
  }
  function menuClose() { menuErase(); menuState.items = []; menuState.sel = -1; }

  // 模态选择器：/resume、/model 回车之后进这儿。↑↓ 挑、打字搜、回车定、Esc 走人。
  // 跟 / 菜单共用同一个 _ttyWrite 拦截点，也共用 menuState.dead 这个「这台终端不认」的开关：
  // 一旦画花过一次，两边一起退回「印一张表、敲序号」——少一半交互也比把人的终端搅烂强。
  const picker = { on: false, lines: 0, view: null, key: null };
  const pickerUsable = () =>
    !menuState.dead && !!ttyWriteOrig && !!process.stdout.isTTY && !!process.stdin.isTTY;

  function pickerErase() {
    if (!picker.lines) return;
    try {
      readline.cursorTo(process.stdout, 0);
      readline.moveCursor(process.stdout, 0, -picker.lines);
      readline.clearScreenDown(process.stdout);
    } catch { menuState.dead = true; }
    picker.lines = 0;
  }

  /** 摆出来让人挑一个；挑中了给那一行，Esc / Ctrl+C 给 null。列表空就直接 null，不摆空框 */
  function chooseFrom(rows, o) {
    const opt = o || {};
    const all = Array.isArray(rows) ? rows : [];
    if (!all.length) return Promise.resolve(null);
    return new Promise((done) => {
      let q = "";
      let sel = 0;
      const paint = () => {
        pickerErase();
        const v = repl.pickerView(all, { q, sel, title: opt.title, verb: opt.verb, hint: opt.hint, max: repl.PICKER_ROWS });
        sel = v.sel < 0 ? 0 : v.sel;
        picker.view = v;
        // 搜索框单独一行，打了字就不压暗——框里那几个字是人自己刚敲的，压暗等于告诉他没生效
        const out = ["", dim(v.head), v.typing ? v.search : dim(v.search)];
        for (const l of v.lines) out.push(l.on ? `\x1b[36m${l.text}\x1b[39m` : dim(l.text));
        out.push(dim(v.foot));
        try {
          process.stdout.write(out.join("\n") + "\n");
          picker.lines = out.length;
        } catch { menuState.dead = true; picker.lines = 0; }
      };
      const finish = (row) => {
        picker.on = false; picker.key = null;
        pickerErase();
        picker.view = null;
        done(row || null);
      };
      picker.key = (ch, k) => {
        if (k.ctrl && (k.name === "c" || k.name === "d")) return finish(null);
        if (k.name === "escape") return finish(null);
        if (k.name === "return" || k.name === "enter") {
          const v = picker.view;
          return finish(v && v.total ? v.hits[v.sel] : null);
        }
        if (k.name === "up" || k.name === "down") {
          const n = (picker.view && picker.view.total) || 0;
          if (!n) return;
          sel = k.name === "down" ? (sel + 1) % n : (sel <= 0 ? n - 1 : sel - 1);
          return paint();
        }
        if (k.name === "backspace") { if (q) { q = q.slice(0, -1); sel = 0; paint(); } return; }
        if (k.ctrl && k.name === "u") { if (q) { q = ""; sel = 0; paint(); } return; }
        if (k.ctrl || k.meta) return;                     // 别的组合键一律忽略，不要当搜索词吃进去
        if (typeof ch === "string" && ch && !/[\x00-\x1f\x7f]/.test(ch)) { q += ch; sel = 0; paint(); }
      };
      picker.on = true;
      paint();
    });
  }

  // `@` 补路径：工作目录里有什么，边打边列。名字里有空格的按 shell 那套转义写回去——
  // 这样它跟从访达拖进来的路径长得一模一样，parseLine 两边都认得。
  // 目录补完留个 `/` 不留空格：这个词还没打完，菜单接着往下列
  const AT_MAX = 40;
  function fileMenu(line) {
    const s = String(line || "");
    const t = attach.atToken(s);
    if (!t) return null;
    const cut = t.prefix.lastIndexOf("/");
    const sub = cut >= 0 ? t.prefix.slice(0, cut + 1) : "";
    const base = cut >= 0 ? t.prefix.slice(cut + 1) : t.prefix;
    const dir = sub.startsWith("~") || path.isAbsolute(sub)
      ? attach.expandHome(sub, os.homedir())
      : path.join(getWorkspaceDir(), sub);
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    const low = base.toLowerCase();
    const items = [];
    for (const e of ents) {
      if (e.name.startsWith(".")) continue; // 点开头的是配置和缓存，不是人要带走的东西
      if (low && !e.name.toLowerCase().startsWith(low)) continue;
      const isDir = e.isDirectory();
      items.push({
        text: e.name + (isDir ? "/" : ""),
        insert: s.slice(0, t.at) + "@" + attach.escPath(sub + e.name) + (isDir ? "/" : " "),
        desc: isDir ? "目录" : "",
      });
    }
    items.sort((a, b) => a.text.localeCompare(b.text, "zh"));
    return items.length ? { kind: "file", items: items.slice(0, AT_MAX) } : null;
  }
  // Tab 走的是 readline 自己的补全（菜单没开、或者这台机器上菜单用不了的时候）。
  // 两边共用 fileMenu 和 repl.menu，不会出现「菜单里有、Tab 补不出来」
  function completeLine(line) {
    const f = fileMenu(line);
    if (f) return [f.items.map((i) => i.insert), String(line == null ? "" : line)];
    return repl.complete(line);
  }

  function menuDraw() {
    if (!menuUsable() || inbox.busy) { menuClose(); return; }
    let pos = null;
    try { pos = rl.getCursorPos(); } catch { menuState.dead = true; menuClose(); return; }
    const hit = require("./repl-commands").menu(rl.line || "") || fileMenu(rl.line || "");
    const items = hit ? hit.items.slice(0, MENU_MAX) : [];
    // 输入折行了就不画：底下那几行的位置算不准，宁可没菜单也不能画歪
    if (!items.length || pos.rows > 0) { menuClose(); return; }
    menuErase();
    menuState.items = items;
    if (menuState.sel >= items.length) menuState.sel = items.length - 1;
    const labelW = items.reduce((w, it) => Math.max(w, tw.cols(it.text)), 0);
    const room = Math.max(20, (process.stdout.columns || 80) - 1);
    const lines = items.map((it, i) => {
      const on = i === menuState.sel;
      let body = ` ${on ? "›" : " "} ${tw.padCols(it.text, labelW)}${it.desc ? "  " + it.desc : ""}`;
      while (tw.cols(body) > room) body = body.slice(0, -1);
      return on ? `\x1b[36m${body}\x1b[39m` : `\x1b[2m${body}\x1b[22m`;
    });
    try {
      process.stdout.write("\n" + lines.join("\n"));
      readline.moveCursor(process.stdout, 0, -lines.length);
      readline.cursorTo(process.stdout, pos.cols);
      menuState.rows = lines.length;
    } catch { menuState.dead = true; menuState.rows = 0; }
  }

  /** 说一句话但不弄乱正在打的那一行：把它收起来、说、再原样摆回去 */
  function sayAbove(text) {
    menuClose();
    try {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
    } catch { menuState.dead = true; }
    process.stdout.write(text);
    try { rl.prompt(true); } catch { menuState.dead = true; }
    menuDraw();
  }

  // Shift+Tab 循环权限档。放权这件事十有八九是「手停在半路上才发现档位不对」，
  // 那时候再去敲 /perm ask 已经太慢——Codex 的 /approvals、Claude Code 的 Shift+Tab 都在这个位置。
  function cyclePerm() {
    // 「全自动」不进这个圈：Shift+Tab 就挨着 Tab，误碰一下就把命令确认也关了，
    // 而人正盯着自己那半行字，根本不会去读屏幕上多出来的一行。要到全自动得明着敲 /perm full。
    const ids = Object.keys(security.PERMISSION_MODES).filter((id) => id !== "full");
    if (!ids.length) return;
    const cur = permNow();
    const at = ids.indexOf(cur); // 当前是 full 就落到第一档，等于往回收，安全
    const next = ids[((at < 0 ? -1 : at) + 1) % ids.length];
    config.security = { ...(config.security || {}), permission_mode: next };
    const m = security.PERMISSION_MODES[next];
    sayAbove(dim(`权限 → 「${m.label}」（${next}）　${m.desc}（只管这一趟；Shift+Tab 到不了「全自动」，那个得敲 /perm full）\n`));
  }

  // Esc Esc：把之前问过的话拉回输入行改了重问。Codex 的招牌交互。
  // 这儿只「放回去」，不回卷历史——真删掉已经跑过的那几轮，等于把模型已经做过的事悄悄抹了，
  // 而人看不见抹了什么。要重来就开 /new，要接回去就 /resume，两条路都在明面上。
  let escArmed = 0;
  async function reEditLast() {
    const msgs = (sess.transcript || [])
      .filter((t) => t && t.type === "user" && String(t.text || "").trim());
    if (!msgs.length) { sayAbove(dim("这个会话还没问过什么，没得改\n")); return; }
    if (!pickerUsable()) { sayAbove(dim(`上次问的是：${String(msgs[msgs.length - 1].text).replace(/\s+/g, " ").slice(0, 60)}\n`)); return; }
    const rows = msgs.slice(-40).reverse().map((t, i) => {
      const text = String(t.text).replace(/\s+/g, " ").trim();
      return { id: String(i), label: text.length > 56 ? text.slice(0, 56) + "…" : text, meta: "", hay: text, text };
    });
    try {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
    } catch { menuState.dead = true; }
    const picked = await chooseFrom(rows, { title: "openworkbuddy> 把哪一句放回去改？", verb: "放回输入行", hint: "打字就筛你问过的话" });
    try { rl.prompt(true); } catch { menuState.dead = true; }
    if (picked) rl.write(picked.text);
    menuDraw();
  }

  // 按键先过这儿再交给 readline：↑↓ 在菜单开着的时候是「挑哪条」，不是翻历史。
  // _ttyWrite 是 readline 的内部，拿不到就降级成「只弹不挑」——菜单照样看得见，
  // Tab 走 readline 自己的补全。宁可少一半功能，也不能因为 Node 换了实现就崩在这儿。
  const ttyWriteOrig = typeof rl._ttyWrite === "function" ? rl._ttyWrite.bind(rl) : null;
  if (ttyWriteOrig) {
    rl._ttyWrite = (ch, key) => {
      const k = key || {};
      if (picker.on) { picker.key(ch, k); return; } // 选择器开着就整场归它，readline 一个键都收不到
      if (k.name === "tab" && k.shift) { cyclePerm(); return; } // 得排在菜单之前，不然被当成补全的 Tab 吃掉
      if (menuState.items.length && !k.ctrl && !k.meta) {
        if (k.name === "up" || k.name === "down") {
          const n = menuState.items.length;
          menuState.sel = k.name === "down"
            ? (menuState.sel + 1) % n
            : (menuState.sel <= 0 ? n - 1 : menuState.sel - 1);
          menuDraw();
          return;
        }
        if (k.name === "escape") { menuClose(); return; }
        if (k.name === "tab" || ((k.name === "return" || k.name === "enter") && menuState.sel >= 0)) {
          const pick = menuState.items[menuState.sel < 0 ? 0 : menuState.sel];
          menuClose();
          rl.write(null, { ctrl: true, name: "e" });
          rl.write(null, { ctrl: true, name: "u" }); // 清掉这行，再把整条命令写回去
          rl.write(pick.insert);
          return;
        }
      }
      // Esc Esc 得认 sequence，不能靠掐表：Node 的 keypress 解码器会把连按的两下 ESC
      // 合成一个事件（sequence 是两个 \x1b），掐表那套永远等不到第二下。
      // 计时那条留着兜底——万一哪天 Node 改了实现，真发两个事件，这边照样认。
      if (k.name === "escape" && !rl.line && !inbox.busy) {
        const t = Date.now();
        if (k.sequence === "\x1b\x1b" || t - escArmed < 900) { escArmed = 0; void reEditLast(); return; }
        escArmed = t;
        return;
      }
      if (k.name === "return" || k.name === "enter") menuClose(); // 回车前先擦干净，不然菜单会留在正文里
      ttyWriteOrig(ch, key);
      menuDraw();
    };
  }

  rl.on("SIGINT", () => {
    menuClose();
    if (inbox.busy) { if (stopCurrent) stopCurrent(); return; } // 停这趟活儿，不退出
    if (rl.line) { // 打了一半不想要了：清掉这行就行，别退出
      rl.write(null, { ctrl: true, name: "e" });
      rl.write(null, { ctrl: true, name: "u" });
      quitArmed = 0;
      return;
    }
    const now = Date.now();
    if (now - quitArmed < 3000) { rl.close(); return; }
    quitArmed = now;
    process.stdout.write("\n");
    prog(dim("再按一次 Ctrl+C 退出，或者敲 /exit\n"));
    rl.prompt();
  });
  const nextInput = () => inbox.next();

  const runReplCommand = async (v) => {
    if (v.name === "help") { prog(repl.helpText()); return; }
    if (v.name === "clear") { process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); return; }
    if (v.name === "mode") {
      if (!v.arg) { prog(dim(`当前是 ${modes.modeLabel(opts.mode)}；换：/mode ${modes.MODE_ARG}\n`)); return; }
      // 这儿原来一个字的校验都没有。`/mode goal` 敲进去照收，状态行接着印「模式 goal」，
      // 而底下 `["ask","plan","craft"].includes("goal")` 判 false，安静地按 craft 跑完——
      // 用户以为自己开了目标验收，实际上从头到尾没验收过一次。认不出来就当场说，别装作切好了。
      if (!modes.isMode(v.arg)) { prog(yellow(modes.modeHint(v.arg) + "\n")); return; }
      opts.mode = v.arg;
      prog(dim(`已经切到 ${modes.modeLabel(v.arg)}\n`));
      return;
    }
    if (v.name === "perm") {
      const cur = permNow();
      if (!v.arg) {
        // 不给值就把四档连同「这档到底意味着什么」一起摆出来。只印 id 的话，
        // plan / ask / auto / full 四个英文词谁也分不清哪个更放得开，只能去翻文档。
        prog(dim(`现在是「${security.PERMISSION_MODES[cur].label}」（${cur}）。换：/perm <档位>\n`));
        for (const [id, m] of Object.entries(security.PERMISSION_MODES)) {
          prog(`  ${id === cur ? green("◆") : dim("·")} ${id.padEnd(5)} ${m.label}　${dim(m.desc)}\n`);
        }
        return;
      }
      if (!security.PERMISSION_MODES[v.arg]) { prog(yellow(`没有「${v.arg}」这个档位，只能是 ${Object.keys(security.PERMISSION_MODES).join(" / ")}\n`)); return; }
      // 只动内存里这份。跟 --perm 同一个道理：交互里临时松一档，不该把 config.json 也改了，
      // 否则退出以后所有的活儿都跟着松了，而人早就忘了自己在这儿敲过一句 /perm。
      config.security = { ...(config.security || {}), permission_mode: v.arg };
      const m = security.PERMISSION_MODES[v.arg];
      prog(dim(`已经切到「${m.label}」——${m.desc}（只管这一趟，没改配置文件）\n`));
      return;
    }
    if (v.name === "new") {
      // 换一个新会话文件，而不是把当前这个清空后覆盖回去——刚才那段对话是资料，不该被顺手抹掉
      const oldId = sessionId;
      sessionId = newSessionId();
      sessFile = sessFileOf(sessionId);
      sess = { history: [], transcript: [], title: "" };
      prog(dim(`开了新会话 ${sessionId}（刚才那段还在：/resume ${oldId}）\n`));
      return;
    }
    if (v.name === "init") {
      // 已经有的话先说一声再动手：整篇盖掉人手写的项目规范，是这条命令最容易犯的错
      const ws = getWorkspaceDir();
      const has = ["AGENTS.md", "CLAUDE.md"].filter((n) => {
        try { return fs.statSync(path.join(ws, n)).size > 0; } catch { return false; }
      }).join(" 和 ");
      const t = repl.initTask({ has });
      prog(dim(t.note));
      return t.prompt;   // 交回主循环当一趟活儿跑：权限档、改文件前的确认、/diff 里的记录一个都不少
    }
    if (v.name === "compact") {
      if (!runtime.compactHistory) { prog(yellow("这个引擎不支持手动压缩\n")); return; }
      const before = require("./agent").historyChars(sess.history || []);
      const n = (sess.history || []).length;
      if (n < 4) { prog(dim("才聊了几句，没什么可压的\n")); return; }
      prog(dim("压缩中……（要过一趟模型，十几秒）\n"));
      let removed = 0;
      try {
        await runtime.compactHistory(sess.history, { force: true, emit: (e) => { if (e && e.type === "compact") removed = e.removed; } });
      } catch (e) { prog(red(`压缩没成（${e.message}），上下文一点没动\n`)); return; }
      prog(dim(repl.compactedText(before, require("./agent").historyChars(sess.history || []), removed)));
      prog(dim(contextLine() + "\n"));
      saveSess();
      return;
    }
    if (v.name === "diff") {
      // 「动过」以工具调用为准，不听模型自述：它说改了而没真调 write_file 的情况是存在的
      const seen = new Map();
      for (const e of sess.history || []) {
        if (e.role !== "assistant") continue;
        for (const c of e.toolCalls || []) {
          if (c.name !== "write_file" && c.name !== "edit_file") continue;
          const p = String(((c.args || c.input || {}).path) || "").trim();
          if (p) seen.set(p, true);
        }
      }
      const ws = getWorkspaceDir();
      const rows = [...seen.keys()].map((p) => {
        const abs = path.isAbsolute(p) ? p : path.join(ws, p);
        try {
          const st = fs.statSync(abs);
          return { path: p, state: "ok", size: repl.sizeText(st.size), when: repl.ago(st.mtimeMs, Date.now()) };
        } catch { return { path: p, state: "gone" }; }
      });
      let git = "", notRepo = false;
      const inRepo = spawnSync("git", ["-C", ws, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
      if (inRepo.status === 0 && String(inRepo.stdout).trim() === "true") {
        const d = spawnSync("git", ["-C", ws, "diff", "--stat", "HEAD"], { encoding: "utf8" });
        git = d.status === 0 ? String(d.stdout).trim() : "";
        if (!git) git = "跟 HEAD 一模一样，没有未提交的改动。";
      } else notRepo = true;
      prog(repl.changedFilesText(rows, { git, notRepo }));
      return;
    }
    if (v.name === "rewind") {
      // 只退这个会话自己留的检查点：别的会话、用户手改的文件一概不碰
      const ck = require("./checkpoints");
      const ws = getWorkspaceDir();
      const rows = ck.list(ws, sessionId);
      if (!v.arg) { prog(repl.checkpointListText(rows, Date.now())); return; }
      const pick = repl.pickCheckpoint(rows, v.arg);
      if (!pick) { prog(yellow(`没有第 ${v.arg} 步。/rewind 不带序号先看有哪些\n`)); return; }
      const r = ck.rewind(ws, sessionId, pick.id);
      prog(r.ok ? repl.rewindResultText(r) : yellow(r.error + "\n"));
      return;
    }
    if (v.name === "mcp") {
      const st = mcpManager.status();
      const rows = [
        ...(st.connected || []).map((c) => ({ name: c.name + (c.plugin ? `（${c.plugin}）` : ""), ok: true, tools: c.tools })),
        ...(st.failures || []).map((x) => ({ name: x.name + (x.plugin ? `（${x.plugin}）` : ""), ok: false, why: x.error || x.raw || "没接上" })),
      ];
      prog(repl.mcpText(rows));
      return;
    }
    if (v.name === "resume") {
      // 光有 `openworkbuddy resume` 不够：那条是**开新进程**才用得上的写法。人已经坐在交互模式里，
      // 想翻回半小时前那段就得先 /exit 再重开——而一 exit，当前这段的上下文、带着还没发出去的文件、
      // 临时调过的 /mode /perm 全跟着没了。所以这儿干的是「原地换一条」，别的什么都不动。
      const rows = repl.sessionRows(listCliSessions(repl.RESUME_MAX), { now: Date.now(), currentId: sessionId });
      let r = repl.pickSessionRow(rows, v.arg);
      // 选单只列最近十二条，更早的照样接得上——只要他手里有 id。/new 和下面那句都会把
      // 「刚离开的那条」的 id 打出来，就是留给这一刻用的
      const raw = String(v.arg || "");
      if (r.kind === "none" && /^(cli_|s_)[\w-]+$/.test(raw) && fs.existsSync(sessFileOf(raw))) {
        r = { kind: "ok", row: { id: raw, title: "", turns: 0, from: raw.startsWith("cli_") ? "命令行" : "桌面" } };
      }
      if (r.kind === "list") {
        if (!pickerUsable()) { prog(repl.sessionListText(rows)); return; } // 管道里、或者这台终端画不了
        const picked = await chooseFrom(repl.sessionPickerRows(rows), {
          title: "openworkbuddy> 接着哪一条往下聊？", verb: "接上",
          hint: "打字就筛，标题 / 你说过的话 / 产出文件名都在里头",
        });
        if (!picked) { prog(dim("没接，还在原来这条\n")); return; }
        r = { kind: "ok", row: picked.row };
      }
      if (r.kind === "none") { prog(yellow(`没认出「${r.arg}」——${r.why}。/resume 不带参数看最近这些\n`)); return; }
      if (r.kind === "many") {
        prog(yellow(`「${r.arg}」对得上好几条：${r.rows.map((x) => `${x.n} ${x.title || x.id}`).join("、")}。写序号或者写全一点\n`));
        return;
      }
      const row = r.row;
      if (row.id === sessionId) { prog(dim("本来就在这条会话里\n")); return; }
      // 读不出来就当场停，绝不「接了一个空的」——那等于把人的旧对话悄悄换成一张白纸，
      // 而他下一句话是冲着旧对话说的，模型却一无所知
      const f = sessFileOf(row.id);
      const loaded = store.readJson(f, null);
      if (!loaded || typeof loaded !== "object") {
        prog(red(`${row.id} 这条读不出来（${f}），没给你接过去，当前这条一点没动\n`));
        return;
      }
      const leaving = sessionId;
      sessionId = row.id;
      sessFile = f;
      sess = { history: [], transcript: [], title: "", ...loaded };
      const turns = (sess.transcript || []).filter((t) => t && t.type === "user").length;
      prog(dim(`接上了${row.from}会话 ${sessionId}${sess.title ? "：" + sess.title : ""}（${turns} 轮）\n`));
      // 接过来的上下文是要花钱的：一条跑过二十轮的会话接过来，下一句话就带着那二十轮一起发出去。
      // 不印这行的话，人只会在账单上发现
      prog(dim(contextLine() + "\n"));
      const last = (sess.transcript || []).filter((t) => t && t.type === "user").pop();
      if (last && last.text) prog(dim(`上次问到：${String(last.text).replace(/\s+/g, " ").slice(0, 60)}\n`));
      if (sess.goal && sess.goal.status === "active") printGoalCard(sess.goal);
      // 桌面那边可能正开着同一条。文件是原子改名写的，坏不了，但后写的那次会盖掉前一次——
      // 这事不说出来，人会以为两边自动同步
      if (row.from === "桌面") prog(yellow("这条是桌面端开的；桌面要是同时开着它，两边写同一个文件，后写的会盖掉先写的\n"));
      prog(dim(`刚才那条还在：/resume ${leaving}\n`));
      return;
    }
    if (v.name === "session") { prog(dim(`${sessionId}\n${sessFile}\n`)); return; }
    if (v.name === "model") {
      const engMod = require("./engines");
      const opt = (config.agent || {}).engine_options || {};
      let det = [];
      try { det = await engMod.detectAll(opt); } catch (e) { prog(yellow(`本机引擎探测不了（${e.message}），先只列模型\n`)); }
      const byId = new Map(det.map((d) => [d.id, d]));
      const provs = Array.isArray(config.providers) ? config.providers : [];
      const rows = repl.modelRows({
        engines: engMod.list().map((b) => ({
          id: b.id, label: b.label,
          installed: byId.has(b.id) ? byId.get(b.id).installed : false,
          install: (byId.get(b.id) || b).install || "",
        })),
        models: (config.models || []).map((m) => ({
          name: m.name, model: m.model,
          channelName: (provs.find((p) => p.id === m.channel) || {}).name || "",
        })),
        engine: cfgEngine(),
        activeModel: config.active_model,
      });
      let r = repl.pickModelRow(rows, v.arg);
      if (r.kind === "list") {
        if (!pickerUsable()) { prog(repl.modelListText(rows)); return; }
        const picked = await chooseFrom(repl.modelPickerRows(rows), {
          title: "openworkbuddy> 这趟活儿谁来干？", verb: "换过去",
          hint: "打字就筛，型号名和厂商都在里头",
        });
        if (!picked) { prog(dim("没换，还是刚才那个\n")); return; }
        r = { kind: "ok", row: picked.row };
      }
      if (r.kind === "none") { prog(yellow(`没认出「${r.arg}」——${r.why}。/model 不带参数看选单\n`)); return; }
      if (r.kind === "many") {
        prog(yellow(`「${r.arg}」对得上好几条：${r.rows.map((x) => `${x.n} ${x.label}`).join("、")}。写序号或者写全一点\n`));
        return;
      }
      const row = r.row;
      if (row.current) { prog(dim(`本来用的就是 ${row.label}\n`)); return; }
      if (!row.ready) {
        // 不许静默降级：选了个没装的引擎，就当场说清楚，绝不偷偷退回内置去花 API 的钱
        prog(red(`${row.label} 这台机器上没装，没法切。${row.install ? "装它：" + row.install : ""}\n`));
        return;
      }
      config.agent = config.agent || {};
      if (row.kind === "engine") {
        config.agent.engine = row.key;
        prog(dim(`换成 ${row.label}；这趟活儿交给它跑，不花 API 额度\n`));
      } else {
        const was = cfgEngine();
        config.agent.engine = "builtin";
        config.active_model = row.key;
        llmImpl = createLLM(config); // 壳子不动，里层换掉——已经建好的 runtime 下一轮就用新的
        if (was !== "builtin") {
          // 顺手改了另一个字段，必须说出来：不说的话，用户以为只换了模型，
          // 实际上连「谁来跑」都换了，账单也从订阅挪回了 API
          const old = engMod.get(was);
          prog(dim(`底层引擎从「${(old && old.label) || was}」扳回内置——不扳的话选模型不起作用\n`));
        }
        prog(dim(`换成 ${row.label}（${llm.model}）；只管这一趟，配置文件没动\n`));
      }
      return;
    }

    if (v.name === "status") {
      const eng = require("./engines").get(cfgEngine());
      const who = eng ? `底层 ${eng.label}` + green("（不花 API 额度）") : `模型 ${llm.provider}（${llm.model}）`;
      const turns = (sess.transcript || []).filter((t) => t.type === "user").length;
      prog(dim(`模式 ${opts.mode} · ${who}\n工作目录 ${getWorkspaceDir()}\n会话 ${sessionId} · 跑过 ${turns} 轮\n`));
      prog(dim(contextLine() + "\n"));
      if (pending.length) prog(dim(`还带着没发出去的文件：${pending.join("、")}\n`));
      return;
    }
    if (v.name === "cd") {
      // 底下的 setWorkspaceDir 只收绝对路径，.. 和 ~ 在这儿先翻译好——
      // 改写前 /cd .. 和 /cd ~/项目 一律报「工作空间必须是绝对路径」
      const target = repl.resolveCd(v.arg, getWorkspaceDir(), os.homedir());
      if (!target) { prog(dim(`当前工作目录 ${getWorkspaceDir()}\n`)); return; }
      try { setWorkspaceDir(target); prog(dim(`工作目录换到 ${getWorkspaceDir()}\n`)); }
      catch (e) { prog(red(`换不过去：${e.message}\n`)); }
      return;
    }
    if (v.name === "files") {
      try {
        const names = fs.readdirSync(getWorkspaceDir()).filter((f) => !f.startsWith("."));
        process.stdout.write((names.join("\n") || "（空）") + "\n");
      } catch (e) { prog(red(`看不了：${e.message}\n`)); }
      return;
    }
    if (v.name === "open") {
      const dir = getWorkspaceDir();
      let names = [];
      try { names = fs.readdirSync(dir).filter((f) => !f.startsWith(".")); } catch {}
      const hit = termImage.resolveTarget(v.arg, names, lastFiles);
      if (hit.kind === "ambiguous") {
        prog(yellow(`${v.arg} 对上了 ${hit.candidates.length} 个：${hit.candidates.slice(0, 5).join("、")}；说全一点\n`));
        return;
      }
      if (hit.kind === "outofrange") {
        prog(yellow(hit.count ? `刚才那行只列了 ${hit.count} 个；/files 看全部\n` : `还没产出过东西；/files 看工作目录里有什么\n`));
        return;
      }
      if (hit.kind === "missing") { prog(yellow(`工作目录里没有 ${v.arg}；/files 看有什么\n`)); return; }
      // kind === "dir"：不给名字 = 打开工作目录本身，人到访达/资源管理器里自己挑
      const target = hit.kind === "file" ? path.join(dir, hit.name) : dir;
      const { cmd, args } = termImage.openerFor(process.platform, target);
      const r = spawnSync(cmd, args, { stdio: "ignore" });
      // 打不开的原因就两种：没有这个命令（Linux 精简装没 xdg-open），或者系统没给它配默认程序。
      // 两种都不该只说一句「失败」——把绝对路径给出去，人至少能自己复制过去打开
      if (r.error || r.status) prog(yellow(`打不开（${r.error ? r.error.code || r.error.message : "退出码 " + r.status}）：${target}\n`));
      else prog(dim(`已交给系统打开：${path.basename(target)}\n`));
      return;
    }
    if (v.name === "paste") {
      // 剪贴板里可能躺着三样东西，按「复制的文件 > 截图位图 > 一大段文字」的顺序认。
      // 顺序有讲究：在访达里 Cmd+C 一个图片文件，剪贴板里同时有文件引用和这张图的位图，
      // 先认文件带进来的是原图，先认位图就成了一张重新编码、名字是时间戳的 PNG
      const dir = getWorkspaceDir();
      const dest = path.join(dir, attach.freeName(dir, attach.stampName("粘贴图", "png"), new Set(), fs));
      let r;
      try { r = attach.readClipboard({ dest }); }
      catch (e) { prog(red(`读不了剪贴板：${e.message}\n`)); return; }
      if (r.kind === "unsupported") { prog(yellow(`${r.why}；把文件直接拖进来也一样\n`)); return; }
      if (r.kind === "empty") { prog(dim("剪贴板里没有能带进来的东西（复制的文件、截图、或者一大段文字）\n")); return; }
      if (r.kind === "text") {
        // 短的直接填进输入行让人接着改；几千字塞进一行，光标一动整个屏幕就乱了，所以长的存成文件
        if (r.text.length <= attach.BIG_TEXT_CHARS) { rl.write(r.text.replace(/\r?\n/g, " ").trim()); return; }
        const name = attach.freeName(dir, attach.stampName("粘贴文本", "txt"), new Set(), fs);
        try { fs.writeFileSync(path.join(dir, name), r.text); }
        catch (e) { prog(red(`存不下来：${e.message}\n`)); return; }
        if (!pending.includes(name)) pending.push(name);
        prog(dim(`  ${r.text.length} 字，存成 ${name} 了；接着打你要问的\n`));
        return;
      }
      const got = r.kind === "files" ? r.paths.map((x) => ({ ref: x, path: x })) : [{ ref: r.file, path: r.file }];
      // 位图那条本来就写在工作目录里，collect 认得出「已经在里面了」，不会再复制一份
      const names = bringIn(got);
      for (const n of names) if (!pending.includes(n)) pending.push(n);
      if (names.length) prog(dim(`  带上了 ${names.join("、")}；接着打你要问的\n`));
      return;
    }
    if (v.name === "drop") {
      if (!pending.length) { prog(dim("本来就没带着什么\n")); return; }
      // 只是不往这句话上挂了，文件不删：删掉的可能正是人刚拖进来、还打算用的那份
      prog(dim(`不带了：${pending.join("、")}（文件还在工作目录里，/files 看得到）\n`));
      pending.length = 0;
      return;
    }
  };

  prog(bold("OpenWorkBuddy CLI 交互模式") + dim("　/help 看命令 · 文件拖进来就带上 · 多行需求直接粘 · Ctrl+C 停当前这趟\n"));
  let last = "ok";
  rl.prompt();
  for (;;) {
    const line = await nextInput();
    if (line === null) { process.stdout.write("\n"); break; } // Ctrl+D / 关掉了：正常收尾，不挂死
    let v = repl.parse(line);
    if (v.kind === "blank") {
      if (pending.length) prog(dim(`  还带着 ${pending.join("、")}；打一句要问的就一块儿发出去，不要了敲 /drop\n`));
      rl.prompt();
      continue;
    }
    if (v.kind === "unknown") { prog(yellow(repl.unknownText(v))); rl.prompt(); continue; }
    if (v.kind === "bad-arg") { prog(yellow(repl.badArgText(v))); rl.prompt(); continue; }
    // 命令现场交出来的那趟活儿（/init）：不再过 splitFiles——那一步是摘「人拖进来的文件」的，
    // 拿它去扫一句现成的话，会把 AGENTS.md 这种词当附件摘走，剩下的句子当场缺一块
    let 现成的 = "";
    if (v.kind === "cmd") {
      if (v.name === "exit") break;
      const 交出来的 = await runReplCommand(v);
      if (typeof 交出来的 !== "string" || !交出来的.trim()) { rl.prompt(); continue; }
      现成的 = 交出来的;
      v = { kind: "task", text: 现成的 };
    }
    // 这一行里带进来的文件：拖进来的、粘路径进来的、@ 补出来的，都在这儿摘出去，剩下的才是要问的话
    const spl = 现成的 ? { files: [], missing: [], text: 现成的 } : splitFiles(v.text);
    for (const m of spl.missing) prog(yellow(`  ！${m} 找不到，当普通文字发过去了\n`));
    for (const n of bringIn(spl.files)) if (!pending.includes(n)) pending.push(n);
    const body = spl.files.length ? spl.text : v.text;
    if (!body) {
      // 只把文件拖进来、还没说要干什么：先攒着，等下一句
      prog(dim(`  带上了 ${pending.join("、")}；接着打你要问的，不要了敲 /drop\n`));
      rl.prompt();
      continue;
    }
    inbox.setBusy(true);
    menuClose(); // 活儿要开跑了，菜单先收掉——正文一冲下来它就成了屏幕上的残渣
    rl.setPrompt(""); // 任务跑着的时候别让提示符插进流式正文里
    last = await runOnce(runtime, attach.withNote(body, pending.splice(0)), opts.mode, true);
    inbox.setBusy(false);
    quitArmed = 0;
    rl.setPrompt(PROMPT);
    rl.prompt();
  }
  saveHistory();
  rl.close();
  mcpManager.stopAll();
  process.exit(last === "ok" ? 0 : last === "aborted" ? 130 : 1);
})();
