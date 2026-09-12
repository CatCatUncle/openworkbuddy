"use strict";
/**
 * `wb doctor` —— 「打不开 / 跑不起来」时的一次性体检。
 *
 * 为什么要有这么个东西：这个项目的报障里，绝大多数不是 bug，是环境。Node 老了、依赖没装、
 * 3800 被别的程序占着、家目录被公司策略重定向到一个连不上的网络盘、config.json 被手改坏了。
 * 这几种在日志里长得都不一样，但用户描述出来是同一句话：「打不开」。一条条问要来回三四轮。
 *
 * 每一条体检项都必须回答两件事：**现在是什么样**，以及**照着做什么能修好**。
 * 只说「✗ 端口不可用」而不说怎么办的检查项，等于把锅原样还给用户。
 *
 * 结构上刻意分成两半：
 *   - `verdictXxx(facts)` 是**纯函数**——事实进，判词出。真造不出「Node 是 16」「磁盘只读」
 *     这些现场，所以判词只能靠纯函数来验；混在 I/O 里就等于永远没人测。
 *   - `gather()` 负责去真的摸磁盘、试端口，摸完喂给上面那些纯函数。
 *
 * 一条红线：**不打印任何 Key 的值**，只报「填了/没填」。体检报告是最容易被人贴到 issue 里的东西。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const LEVELS = { ok: 0, warn: 1, bad: 2 };

/** 一条体检结果。level 决定退出码：只要有一条 bad，`wb doctor` 就退 1（好写进 CI 和安装脚本） */
function item(name, level, detail, fix) {
  return { name, level, detail, fix: fix || "" };
}

// ── 判词：纯函数，事实进，人话出 ────────────────────────────────────────

/** Node 版本。跟 boot-check / install.sh / package.json engines 共用同一个下限 */
function verdictNode(nodeVersion, minMajor) {
  const raw = String(nodeVersion || "").replace(/^v/, "");
  const major = parseInt(raw.split(".")[0], 10);
  if (!major) return item("Node 版本", "warn", `认不出版本号（${nodeVersion}）`, `要 ${minMajor} 以上，跑 node -v 自己核一下。`);
  if (major < minMajor) {
    return item("Node 版本", "bad", `v${raw}，太老了`,
      `要 ${minMajor} 以上。nodejs.org 下 LTS 版覆盖装；用 nvm 的话 nvm install 20 && nvm use 20。`);
  }
  return item("Node 版本", "ok", `v${raw}`);
}

/** 依赖装没装 */
function verdictDeps(missing, packaged) {
  if (!missing.length) return item("依赖", "ok", "齐了");
  if (packaged) {
    return item("依赖", "bad", `安装包里少了 ${missing.join("、")}`,
      "到 GitHub Releases 重新下载最新版覆盖安装。");
  }
  return item("依赖", "bad", `少了 ${missing.join("、")}`,
    "在项目目录里跑一次 npm install。国内网络慢：npm install --registry=https://registry.npmmirror.com");
}

/**
 * 数据目录：所有会被写的东西都落在这儿。
 * 公司电脑把用户目录重定向到离线网络盘是真实发生过的事故，报错长得像权限问题，其实是路径问题。
 */
function verdictDataDir(facts) {
  const { dir, writable, errCode, viaEnv, exists } = facts;
  const how = viaEnv ? "（来自 OPENWORKBUDDY_HOME）" : "";
  if (writable) return item("数据目录", "ok", dir + how + (exists === false ? "（还没建，第一次启动时会自动建）" : ""));
  const why = errCode === "EROFS" ? "这个盘是只读的"
    : errCode === "ENOSPC" ? "磁盘满了"
      : errCode === "ENOENT" ? "上一级目录不存在"
        : "写不进去（" + (errCode || "未知原因") + "）";
  return item("数据目录", "bad", `${dir}${how} —— ${why}`,
    "设一个环境变量 OPENWORKBUDDY_HOME 指到本机一个能写的文件夹再启动，"
    + "比如 macOS/Linux：export OPENWORKBUDDY_HOME=~/OpenWorkBuddy；Windows：setx OPENWORKBUDDY_HOME D:\\OpenWorkBuddy");
}

/** config.json：在不在、能不能解析 */
function verdictConfig(facts) {
  const { file, exists, parsed, error } = facts;
  if (!exists) {
    return item("配置文件", "warn", `还没有 ${file}`,
      "跑一次 npm start（或打开桌面版）会自动生成；也可以从 config.example.json 复制一份。");
  }
  if (!parsed) {
    return item("配置文件", "bad", `${file} 解析不了：${error || "格式不对"}`,
      "多半是手改时漏了逗号或引号。用 JSON 校验器看一眼；实在修不了就改名备份，"
      + "再从 config.example.json 复制一份重新填。");
  }
  return item("配置文件", "ok", file);
}

/**
 * 配置内容有没有写错。
 *
 * 跟上面那条「配置文件」分开报：那条只管 JSON 解析得开解不开，而这里最常见的坏法
 * 恰恰是解析得开——键名少个字母、端口写成带引号的 "3800"，程序当那一行不存在，
 * 一声不吭。体检就是专门来抓这种「看着好好的、其实没生效」的。
 */
function verdictConfigLint(found) {
  if (!found.length) return item("配置内容", "ok", "没发现写错的地方");
  const worstBad = found.some((f) => f.level === "bad");
  return item("配置内容", worstBad ? "bad" : "warn",
    found.map((f) => f.text).join("；"),
    found.map((f) => f.hint).join(" "));
}

/** 拿模板当底册跑一遍体检；模板读不到就跳过，别让体检自己先死在这儿 */
function lintConfig(config, paths) {
  try {
    const def = JSON.parse(fs.readFileSync(paths.appPath("config.example.json"), "utf8"));
    return require("./config-lint").lint(config, def);
  } catch {
    return [];
  }
}

/**
 * 模型渠道：只报数和「填没填 Key」，**绝不打印 Key 本身**。
 * 体检报告是最容易被整段贴到 issue 里的东西。
 */
function verdictModels(facts) {
  const { channels, keyed, chatModels } = facts;
  if (!channels) {
    return item("模型渠道", "bad", "一个渠道都没配",
      "打开设置页 → 模型，填一个渠道的接口地址和 Key；或者 wb engines use claude-code 直接用本机已装的 CLI，不需要 Key。");
  }
  if (!keyed) {
    return item("模型渠道", "bad", `${channels} 个渠道，没有一个填了 Key`,
      "设置页 → 模型 → 展开渠道卡片填 Key。Anthropic 官方渠道也要填。");
  }
  if (!chatModels) {
    return item("模型渠道", "bad", `${channels} 个渠道（${keyed} 个有 Key），但一个对话模型都没有`,
      "设置页 → 模型 → 在渠道卡片里「加模型」，填上模型名（比如 deepseek-chat）。");
  }
  const lvl = keyed < channels ? "warn" : "ok";
  const tail = keyed < channels ? `，其中 ${channels - keyed} 个还没填 Key` : "";
  return item("模型渠道", lvl, `${channels} 个渠道 / ${chatModels} 个对话模型${tail}`,
    lvl === "warn" ? "没填 Key 的那几个渠道底下的模型点了会 401，设置页 → 模型里补上。" : "");
}

/**
 * 端口。EACCES 必须判在 EADDRINUSE 前面：两者都是「端口用不了」，但解法完全相反——
 * 前者得换端口，后者得去关掉占用的那个程序。Windows 上 Hyper-V / WSL 会成片预留端口，
 * 落在保留段里报的正是 EACCES。这条判据跟 electron-main.js 的 bootHint 是同一套。
 */
function verdictPort(facts) {
  const { port, host, errCode, who } = facts;
  if (!errCode) return item("端口", "ok", `${host}:${port} 空着`);
  // 端口被占着，占的又正是 OpenWorkBuddy 自己——这是「已经开着」，不是故障。
  // 不分这一下的话，每个正常使用中的用户跑一次体检都会看到一条黄色告警，看两次就不看了。
  if (errCode === "EADDRINUSE" && who === "self") {
    return item("端口", "ok", `${host}:${port} —— OpenWorkBuddy 已经在这个端口上跑着`);
  }
  if (/EACCES|EPERM/.test(errCode)) {
    return item("端口", "bad", `${host}:${port} 没权限`,
      "Windows 上多半是 Hyper-V / WSL 预留了这段端口（netsh interface ipv4 show excludedportrange protocol=tcp 能看到保留段）。"
      + "把 config.json 里的 server.port 换成一个没被预留的，比如 3810。");
  }
  if (errCode === "EADDRINUSE") {
    return item("端口", "bad", `${host}:${port} 被别的程序占了（应答的不是 OpenWorkBuddy）`,
      "关掉占用它的程序，或把 config.json 里的 server.port 换一个（比如 3810）。"
      + "查是谁占的：macOS/Linux `lsof -i :" + port + "`，Windows `netstat -ano | findstr :" + port + "`。");
  }
  if (errCode === "EADDRNOTAVAIL") {
    return item("端口", "bad", `${host} 这个地址在这台机器上不存在`,
      "换过网络之后常见。把 config.json 里的 server.host 改回 127.0.0.1。");
  }
  return item("端口", "bad", `${host}:${port} 试不通（${errCode}）`, "把这行贴到 issue 里。");
}

/** 工作区：成果文件落这儿，不能写等于任务跑完什么都拿不到 */
function verdictWorkspace(facts) {
  const { dir, writable, errCode, exists } = facts;
  if (writable) return item("工作区", "ok", dir + (exists === false ? "（还没建，第一次交付文件时会自动建）" : ""));
  return item("工作区", "bad", `${dir} 写不进去（${errCode || "未知原因"}）`,
    "设置页 → 常规 → 工作目录，换到一个你有写权限的文件夹；命令行里也可以 wb -C <目录> 临时指定。");
}

/** 底层引擎：选了本机 CLI 却没装，是「设置里看着好好的、一跑任务就报错」那类最难查的坑 */
function verdictEngine(facts) {
  const { id, label, installed, version, install } = facts;
  if (id === "builtin") return item("底层引擎", "ok", `${label}（走配置里的模型 API）`);
  if (installed) return item("底层引擎", "ok", `${label} ${version || ""}`.trim() + "，不消耗 API 额度");
  return item("底层引擎", "bad", `选的是 ${label}，但本机没装或跑不起来`,
    (install ? `装法：${install}；` : "") + "或者 wb engines use builtin 换回内置引擎。");
}

/** 整体结论：有 bad 就退 1。给安装脚本和 CI 用 */
function worst(items) {
  return items.reduce((m, it) => Math.max(m, LEVELS[it.level] || 0), 0);
}

// ── 真去摸：I/O 那一半 ──────────────────────────────────────────────────

/**
 * 试着写一个临时文件再删掉。只看「能不能写」，不留痕迹。
 *
 * 目录还不存在是全新安装的常态。这时候要问的是「上一级建不建得出来」，而不是顺手
 * 把它建出来——体检是来看病的，不该改用户的磁盘。所以往上找到第一个真实存在的祖先去试。
 */
function probeWritable(dir) {
  let probe = path.resolve(dir);
  let exists = true;
  while (!fs.existsSync(probe)) {
    exists = false;
    const up = path.dirname(probe);
    if (up === probe) break; // 一路找到根还没有：只能拿根去试，试不通下面会如实报
    probe = up;
  }
  const f = path.join(probe, ".owb-doctor-" + process.pid);
  try {
    fs.writeFileSync(f, "x");
    fs.unlinkSync(f);
    return { dir, exists, writable: true };
  } catch (e) {
    try { fs.unlinkSync(f); } catch {}
    return { dir, exists, writable: false, errCode: e.code || e.message };
  }
}

/**
 * 端口上应答的是谁。
 *
 * 只用来把「OpenWorkBuddy 自己开着」跟「别的程序占了」分开——这两件事对用户的意思完全相反。
 * 认人靠 /api/ping —— 整个服务里唯一不需要登录的接口。早先这儿问的是 /api/info，
 * 那条要登录：开着登录闸的机器上它回 401，于是自家实例被判成「别的程序占了」。
 * 连不上、超时、回的不是这个形状，一律当「别人」：宁可多报一次，也别把故障说成正常。
 */
function fetchText(port, host, path, timeoutMs) {
  return new Promise((resolve) => {
    const http = require("http");
    const req = http.get({ host, port, path, timeout: timeoutMs || 1500 }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      // 只要开头这一截：认身份用不着把整个首页拉下来
      res.on("data", (d) => { buf += d; if (buf.length > 4096) { req.destroy(); res.destroy(); } });
      res.on("end", () => resolve(buf));
      res.on("close", () => resolve(buf));
    });
    req.on("timeout", () => { req.destroy(); resolve(""); });
    req.on("error", () => resolve(""));
  });
}

/**
 * 这个端口上应答的是不是 OpenWorkBuddy 自己。
 *
 * 两条依据，缺一不可：
 *   1. /api/ping —— 0.1.6 起才有，最准；
 *   2. 首页 HTML 里的 <title> —— 从第一版就在，用来认**还没升级的那个自己**。
 * 只有第 2 条的原因很实在：这个功能自己就是新加的，而端口上跑着的那份多半是升级前启动的。
 * 光看 ping 的话，每个「开着旧版、跑一下体检」的人都会被告知「端口被别的程序占了」——
 * 一条足够把人劝退的假警报。
 *
 * 认不出来一律算「别的程序」：宁可多报一次要人去查，也别把真故障说成正常。
 */
async function probeWho(port, host, timeoutMs) {
  const ping = await fetchText(port, host, "/api/ping", timeoutMs);
  try {
    const j = JSON.parse(ping);
    if (j && j.app === "openworkbuddy") return "self";
  } catch {}
  const home = await fetchText(port, host, "/", timeoutMs);
  if (/<title>\s*OpenWorkBuddy\s*<\/title>/i.test(home)) return "self";
  return "other";
}

/** 试着监听一下再马上关掉。这是唯一能分清 EACCES / EADDRINUSE / EADDRNOTAVAIL 的办法 */
function probePort(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let done = false;
    const finish = (errCode) => { if (done) return; done = true; try { srv.close(); } catch {} resolve({ port, host, errCode }); };
    srv.once("error", (e) => finish(e.code || String(e.message)));
    srv.once("listening", () => finish(""));
    try { srv.listen(port, host); } catch (e) { finish(e.code || String(e.message)); }
  });
}

/** 从 config 里数渠道和 Key —— 只数，不取值 */
function countModels(config) {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const models = Array.isArray(config.models) ? config.models : [];
  return {
    channels: providers.length,
    keyed: providers.filter((p) => p && String(p.api_key || "").trim()).length,
    chatModels: models.filter((m) => m && String(m.model || "").trim()).length,
  };
}

/**
 * 跑一整轮体检。
 * @param {object} deps 把外部依赖显式传进来，测试好替：{ paths, config, engines, workspaceDir, bootCheck }
 */
async function gather(deps) {
  const { paths, config, engines, workspaceDir, bootCheck } = deps;
  const items = [];
  items.push(verdictNode(process.versions.node, bootCheck.MIN_NODE));
  items.push(verdictDeps(bootCheck.findMissing(paths.APP_DIR, bootCheck.REQUIRED_DEPS), paths.isPackaged()));
  items.push(verdictDataDir({ ...probeWritable(paths.DATA_DIR), viaEnv: !!process.env.OPENWORKBUDDY_HOME }));

  const cfgFile = paths.dataPath("config.json");
  const exists = fs.existsSync(cfgFile);
  let parsed = false, error = "";
  if (exists) {
    try { JSON.parse(fs.readFileSync(cfgFile, "utf8")); parsed = true; }
    catch (e) { error = e.message; }
  }
  items.push(verdictConfig({ file: cfgFile, exists, parsed, error }));
  items.push(verdictConfigLint(parsed ? lintConfig(config || {}, paths) : []));
  items.push(verdictModels(countModels(config || {})));

  const srv = (config && config.server) || {};
  const port = +process.env.PORT || srv.port || 3800;
  const host = process.env.HOST || srv.host || "127.0.0.1";
  const portFacts = await probePort(port, host);
  if (portFacts.errCode === "EADDRINUSE") portFacts.who = await probeWho(port, host);
  items.push(verdictPort(portFacts));

  items.push(verdictWorkspace(probeWritable(workspaceDir)));

  const want = String(((config || {}).agent || {}).engine || "builtin").trim() || "builtin";
  if (want === "builtin") {
    items.push(verdictEngine({ id: "builtin", label: engines.BUILTIN.label }));
  } else {
    const b = engines.get(want) || { label: want, install: "" };
    let found = null;
    try { found = (await engines.detectAll(((config || {}).agent || {}).engine_options || {})).find((e) => e.id === want); } catch {}
    items.push(verdictEngine({
      id: want, label: b.label, installed: !!(found && found.installed),
      version: found && found.version, install: b.install,
    }));
  }
  return items;
}

/** 把结果画成一屏。色由调用方给（CLI 那边判过 isTTY 了），这儿只管排版 */
const { cols, padCols } = require("./text-width"); // 中文占两列，padEnd 数的是码位——对齐一律走它

function render(items, paint) {
  const c = paint || ((s) => s);
  const mark = { ok: "✓", warn: "!", bad: "✗" };
  const lines = [];
  const w = items.reduce((m, it) => Math.max(m, cols(it.name)), 0);
  for (const it of items) {
    lines.push(`${c(mark[it.level], it.level)} ${padCols(it.name, w)}  ${it.detail}`);
    if (it.fix) lines.push(`    ${c("怎么修：" + it.fix, "dim")}`);
  }
  const bad = items.filter((i) => i.level === "bad").length;
  const warn = items.filter((i) => i.level === "warn").length;
  lines.push("");
  lines.push(bad
    ? c(`体检结果：${bad} 项要处理${warn ? `，${warn} 项要留意` : ""}。照上面的「怎么修」做完再启动。`, "bad")
    : warn
      ? c(`体检结果：能跑，${warn} 项要留意。`, "warn")
      : c("体检结果：一切正常。", "ok"));
  return lines.join("\n") + "\n";
}

module.exports = {
  verdictNode, verdictDeps, verdictDataDir, verdictConfig, verdictModels,
  verdictPort, verdictWorkspace, verdictEngine,
  worst, countModels, probeWritable, probePort, probeWho, fetchText, gather, render, cols, LEVELS,
  verdictConfigLint,
};
