// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 开机闸门（boot-check.js）与体检（doctor.js）的判据测试。
 *
 * 这两个模块的服务对象是「现在就卡在门外的人」。麻烦在于：那个现场在测试里造不出来——
 * 总不能把这台机器的 Node 降到 16、把磁盘挂成只读、再把 3800 让给别的程序，
 * 只为了跑一遍断言。所以两边的判词都刻意写成了纯函数，这份测试打的就是那些纯函数：
 * 事实进，人话出。
 *
 * 每一节都配反向对照。只会变绿的断言不是测试——尤其是这种「平时永远走不到」的分支，
 * 一旦写错，要等到真有用户卡住才会发现，而那时候他手里唯一的线索正是这句错话。
 *
 * 还有一条是反向的红线：体检报告是最容易被人整段贴进 issue 的东西，
 * 所以它**绝不能带出 Key 的值**。⑥ 那一节专门证明这一点。
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { mod } = require("./lib/mod");
const { entry } = require("./lib/entry");
const ROOT = path.join(__dirname, "..");
const srcLib = require("./lib/src"); // server / tools / canvas 三组源码的唯一读法，见 test/lib/src.js
const boot = require(mod("boot-check"));
const doctor = require(mod("doctor"));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });

// ── ① 开机闸门：Node 太老 ───────────────────────────────────────────────
console.log("\n① 开机闸门：Node 太老");
const old = boot.bootProblem({ nodeVersion: "v16.20.2", minMajor: 18, missingDeps: [] });
ok(!!old && old.code === "node-too-old", "v16 被拦下", old);
ok(old && /v16\.20\.2/.test(old.title), "报的是他机器上那个真实版本号，不是一句泛泛的「版本太老」", old && old.title);
ok(old && /18/.test(old.title), "说了要几以上", old && old.title);
ok(old && /nodejs\.org|nvm|brew/.test(old.fix), "给了照着做就能修好的装法", old && old.fix);
eq(boot.bootProblem({ nodeVersion: "v18.0.0", minMajor: 18, missingDeps: [] }), null, "反向对照：刚好到线的 v18 放行");
eq(boot.bootProblem({ nodeVersion: "v22.11.0", minMajor: 18, missingDeps: [] }), null, "反向对照：新版本放行");
// 认不出版本号时的取舍：放行。把一台本来能跑的机器拦在门外，比漏掉一个老 Node 更糟——
// 前者是「昨天还好好的，升级完打不开了」，后者至少还能跑到真正出错的那一步。
eq(boot.bootProblem({ nodeVersion: "", minMajor: 18, missingDeps: [] }), null, "版本号认不出来时放行，不拿自己的判据把人锁在门外");
eq(boot.bootProblem({ nodeVersion: "不是版本号", minMajor: 18, missingDeps: [] }), null, "乱七八糟的版本号也放行");

// ── ② 开机闸门：依赖没装，而且源码版和装机版说的不是同一句 ───────────────
console.log("\n② 开机闸门：依赖没装");
const dev = boot.bootProblem({ nodeVersion: "v20.0.0", missingDeps: ["express"], packaged: false });
ok(dev && /npm install/.test(dev.fix), "源码版让他跑 npm install", dev && dev.fix);
ok(dev && /npmmirror/.test(dev.fix), "顺手给了国内镜像——「装不上」跟「没装」是两种卡法", dev && dev.fix);
const pkg = boot.bootProblem({ nodeVersion: "v20.0.0", missingDeps: ["express"], packaged: true });
ok(pkg && /Releases|重新下载/.test(pkg.fix), "装机版让他重下安装包（那边压根没有 npm install 这回事）", pkg && pkg.fix);
ok(pkg && !/npm install/.test(pkg.fix), "★装机版绝不能让他跑 npm install★ 那是一条走不通的路，会白耗一晚上", pkg && pkg.fix);
// 两样一起坏时先说 Node：在老 Node 上跑 npm install 装出来的树本身就可能是坏的，
// 先让他修依赖等于让他白装一遍
const both = boot.bootProblem({ nodeVersion: "v16.0.0", missingDeps: ["express"], packaged: false });
eq(both && both.code, "node-too-old", "Node 和依赖都坏时，先说 Node");

// ── ③ 闸门真的挂在三个入口的最前面 ──────────────────────────────────────
console.log("\n③ 闸门挂在入口的最前面");
for (const f of ["server.js", "cli.js"]) {
  const src = fs.readFileSync(path.join(ROOT, f), "utf8");
  const gate = src.indexOf(`require(${JSON.stringify(mod.spec(f.replace(/\.js$/, ""), "boot-check"))})`);
  const express = src.indexOf('require("express")');
  const first = src.indexOf('require("fs")');
  ok(gate > 0, `${f} 里挂了闸门`);
  // 排在 require 队列后面的闸门等于没有：缺依赖的人会先撞上 Cannot find module
  if (express > 0) ok(gate < express, `${f}：闸门排在 require("express") 前面`, { gate, express });
  if (first > 0) ok(gate < first, `${f}：闸门排在第一批 require 前面`, { gate, first });
}
const missNow = boot.findMissing(ROOT, boot.REQUIRED_DEPS);
eq(missNow.length, 0, "这个仓库本身依赖是齐的（否则上面那些测试也跑不起来）", missNow);
ok(boot.findMissing(path.join(os.tmpdir(), "根本没有这个目录"), ["express"]).length === 1,
  "反向对照：换个空目录，findMissing 真的报缺");

// 手写的依赖清单会漂：加第 14 个包的人不会记得回来改 boot-check，
// 而这个文件存在的全部意义就是别让用户拿到一句 Cannot find module
const declared = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).dependencies || {});
eq(boot.readDeps(ROOT).sort().join(","), declared.sort().join(","),
  "★要查的依赖清单 = package.json 的 dependencies★ 差一个，那个包缺了就是一句 Cannot find module",
  { 查的: boot.readDeps(ROOT).length, 声明的: declared.length });
ok(declared.length > boot.FALLBACK_DEPS.length,
  "先验料：声明的依赖本来就比手写那份兜底清单多（不然这条断言证不出东西）",
  { declared: declared.length, fallback: boot.FALLBACK_DEPS.length });
// 闸门自己读不到清单时不能两头极端：既不许因此把人拦在门外，也不许因此一条都不查
eq(boot.readDeps(path.join(os.tmpdir(), "根本没有这个目录")).join(","), boot.FALLBACK_DEPS.join(","),
  "package.json 读不出来就退回手写那三个，不是空清单（空清单 = 闸门静默失效）");
// 一次整体装失败和真只少一个包，屏幕上不能长得一模一样——该做的事不同
const many = boot.bootProblem({ nodeVersion: "v20.0.0", missingDeps: declared, packaged: false });
ok(/等 \d+ 个/.test(many.title) && many.title.includes(String(declared.length)),
  "★十三个全没有时报出总数★ 只印前三个的话，整体装失败看着就像只少三个包", many.title);
const one = boot.bootProblem({ nodeVersion: "v20.0.0", missingDeps: ["express"], packaged: false });
ok(!/等 \d+ 个/.test(one.title) && one.title.includes("express"),
  "反向对照：真只少一个的时候不许硬加「等 N 个」", one.title);
// 装机版和源码版是两份 package.json：拿这边的清单去查那边，查的就是错的清单
const bc = fs.readFileSync(mod("boot-check"), "utf8");
ok(/missingDeps: findMissing\(rootDir, readDeps\(rootDir\)\)/.test(bc),
  "enforce 里的清单得跟着 rootDir 走，不能用模块加载时那一份");

// ── ④ 体检：端口那三种坏法解法完全不同，不许糊成一句 ─────────────────────
console.log("\n④ 体检：端口");
const pAcc = doctor.verdictPort({ port: 3800, host: "127.0.0.1", errCode: "EACCES" });
const pUse = doctor.verdictPort({ port: 3800, host: "127.0.0.1", errCode: "EADDRINUSE", who: "other" });
const pSelf = doctor.verdictPort({ port: 3800, host: "127.0.0.1", errCode: "EADDRINUSE", who: "self" });
const pNa = doctor.verdictPort({ port: 3800, host: "192.168.1.9", errCode: "EADDRNOTAVAIL" });
const pFree = doctor.verdictPort({ port: 3800, host: "127.0.0.1", errCode: "" });
eq(pFree.level, "ok", "端口空着 = 正常");
ok(/Hyper-V|预留|保留段/.test(pAcc.fix), "EACCES → 说的是「换个端口」那条路（Windows 上多半是 Hyper-V 预留了）", pAcc.fix);
ok(/lsof|netstat/.test(pUse.fix), "EADDRINUSE → 说的是「去查谁占的、关掉它」那条路", pUse.fix);
ok(pAcc.fix !== pUse.fix, "★这两句必须不一样★ 糊成一句的话，一半人会照着错的那条走", { a: pAcc.fix, b: pUse.fix });
eq(pSelf.level, "ok", "占着 3800 的就是 OpenWorkBuddy 自己 = 「已经开着」，不是故障");
ok(pUse.level === "bad" && pSelf.level === "ok",
  "★同一个 EADDRINUSE，认出是自己就变正常，认不出才报错★ 不分这一下，天天在用的人每次体检都吃一条假告警");
ok(/server\.host|127\.0\.0\.1/.test(pNa.fix), "EADDRNOTAVAIL → 让他把 host 改回 127.0.0.1（换过网络之后常见）", pNa.fix);
const said = [pAcc, pUse, pSelf, pNa, pFree].map((x) => x.detail + x.fix);
eq(new Set(said).size, said.length, "五种端口状况说出五句互不相同的话");

// ── ⑤ 体检：其余几项 ────────────────────────────────────────────────────
console.log("\n⑤ 体检：其余几项");
eq(doctor.verdictNode("v25.0.0", 18).level, "ok", "Node 够新");
eq(doctor.verdictNode("v16.0.0", 18).level, "bad", "反向对照：Node 太老是要处理的，不是「留意一下」");
eq(doctor.verdictDeps([], false).level, "ok", "依赖齐了");
eq(doctor.verdictDeps(["express"], false).level, "bad", "反向对照：缺依赖");
const ddOk = doctor.verdictDataDir({ dir: "/x", writable: true, viaEnv: false, exists: true });
const ddNew = doctor.verdictDataDir({ dir: "/x", writable: true, viaEnv: false, exists: false });
const ddRo = doctor.verdictDataDir({ dir: "/x", writable: false, errCode: "EROFS", viaEnv: false, exists: true });
eq(ddOk.level, "ok", "数据目录能写");
eq(ddNew.level, "ok", "★目录还不存在不是毛病★ 全新安装本来就是这样，第一次启动会自己建");
ok(/还没建/.test(ddNew.detail), "但要说清楚它还不存在，别让人以为已经有了", ddNew.detail);
eq(ddRo.level, "bad", "反向对照：只读盘是要处理的");
ok(/只读/.test(ddRo.detail), "EROFS 翻成人话「这个盘是只读的」", ddRo.detail);
ok(/OPENWORKBUDDY_HOME/.test(ddRo.fix), "给的是「换个地方放数据」这条真能走通的路", ddRo.fix);
ok(/OPENWORKBUDDY_HOME/.test(doctor.verdictDataDir({ dir: "/x", writable: true, viaEnv: true, exists: true }).detail),
  "路径是环境变量给的就说一声——不然他会对着一个「怎么不是我配的那个目录」发懵");
eq(doctor.verdictConfig({ file: "/x/config.json", exists: true, parsed: true }).level, "ok", "配置能解析");
const cfgBad = doctor.verdictConfig({ file: "/x/config.json", exists: true, parsed: false, error: "Unexpected token }" });
eq(cfgBad.level, "bad", "反向对照：解析不了是要处理的");
ok(/逗号|引号/.test(cfgBad.fix), "指出手改 JSON 最常犯的那两个错", cfgBad.fix);
eq(doctor.verdictConfig({ file: "/x/config.json", exists: false }).level, "warn",
  "★还没有 config.json 只是「留意」★ 第一次启动会生成，把它判成故障等于吓唬每个新用户");
const eNo = doctor.verdictEngine({ id: "claude-code", label: "本机 Claude Code", installed: false, install: "npm i -g x" });
eq(eNo.level, "bad", "选了本机 CLI 却没装 —— 这是「设置里看着好好的、一跑任务就报错」那类坑");
ok(/openworkbuddy engines use builtin/.test(eNo.fix), "给了「换回内置引擎」这条不用装东西的退路", eNo.fix);
eq(doctor.verdictEngine({ id: "builtin", label: "内置引擎" }).level, "ok", "反向对照：内置引擎永远是好的");
eq(doctor.verdictWorkspace({ dir: "/x", writable: true, exists: true }).level, "ok", "工作区能写");
eq(doctor.verdictWorkspace({ dir: "/x", writable: false, errCode: "EACCES" }).level, "bad", "反向对照：工作区写不进去");

// 外部 CLI：缺了只算「留意」，绝不能让 openworkbuddy doctor 退 1——安装脚本里写的是
// `openworkbuddy doctor && npm start`，为一个可选工具挡住启动是本末倒置
const tAll = [
  { name: "ffmpeg", use: "图文成片、录屏", bin: "/usr/bin/ffmpeg", install: "brew install ffmpeg" },
  { name: "pandoc", use: "Word 互转", bin: "/usr/bin/pandoc", install: "brew install pandoc" },
];
eq(doctor.verdictTools(tAll).level, "ok", "外部工具都在");
const tMiss = doctor.verdictTools([tAll[0], { name: "pandoc", use: "Word 互转", bin: "", install: "brew install pandoc" }]);
eq(tMiss.level, "warn", "缺外部工具只算「留意」，不是「要处理」");
eq(doctor.worst([tMiss]), doctor.LEVELS.warn, "反向对照：缺外部工具时 openworkbuddy doctor 的退出码还是 0");
ok(/pandoc/.test(tMiss.detail) && /Word/.test(tMiss.detail), "说清楚缺的是哪个、它是干嘛用的", tMiss.detail);
ok(/brew install pandoc/.test(tMiss.fix), "给了照着能敲的装法", tMiss.fix);
ok(!/ffmpeg/.test(tMiss.fix), "反向对照：已经装了的不该出现在「怎么修」里", tMiss.fix);
eq(doctor.verdictTools([]).level, "ok", "反向对照：一个都不查时不该报警");
// 装法要分平台给：Windows 用户看到 brew 只会更糊涂
for (const plat of ["darwin", "win32", "linux"]) {
  for (const t of doctor.EXTERNAL_TOOLS) {
    ok(!!(t.install[plat] || t.install.other), `${t.name} 在 ${plat} 上有装法`);
  }
}

// 别名表：shell 报错里蹦出来的名字，常常不是清单上那个代表名。
// ffprobe 和 ffmpeg 是同一条 brew 装出来的，可 video-compose 量每段时长用的正是 `ffprobe`——
// 按原名去查清单一无所获，用户就会看到「没装 ffprobe」，然后去搜一个根本不存在的包。
const kt = (n, plat, field) => { const t = doctor.knownTool(n, plat); return t ? t[field] : "（没认出来）"; };
eq(kt("ffmpeg", "darwin", "install"), "brew install ffmpeg", "认得出本名");
eq(kt("ffprobe", "darwin", "name"), "ffmpeg", "★ffprobe 要折回 ffmpeg 名下★ 同一个包装出来的，装法就是同一句");
eq(kt("libreoffice", "darwin", "name"), "soffice", "libreoffice 折回 soffice");
eq(kt("pdftoppm", "darwin", "name"), "pdftotext", "pdftoppm 折回 pdftotext（poppler 一个包装出来的）");
eq(kt("FFMPEG", "win32", "install"), "winget install ffmpeg", "名字不分大小写，装法跟着平台走");
eq(kt("  ffmpeg  ", "linux", "install"), "apt install ffmpeg", "前后空格不影响，Linux 落到 other 那档");
eq(doctor.knownTool("nosuchtool", "darwin"), null, "反向对照：不认识的命令不瞎给装法");
eq(doctor.knownTool("", "darwin"), null, "反向对照：空名字不算");
eq(doctor.knownTool(null, "darwin"), null, "反向对照：没给名字不算");
// 别名指过去的那个名字必须真在清单上。写错一个字，这条路就静默断了——
// 不报错、不告警，只是从此再也翻译不出来，而那正是没人会去查的一种坏法
for (const [alias, primary] of Object.entries(doctor.TOOL_ALIASES)) {
  ok(doctor.EXTERNAL_TOOLS.some((t) => t.name === primary), `别名 ${alias} 指向的 ${primary} 真在外部工具清单上`, primary);
  ok(!doctor.EXTERNAL_TOOLS.some((t) => t.name === alias), `反向对照：${alias} 自己不在清单上（在的话就该直接查它，别绕别名）`, alias);
}

// Windows 上给的装法：scoop / choco 得先装包管理器本身，照着敲第一句就撞墙。winget 是系统自带的
eq(kt("pdftotext", "win32", "install"), "winget install oschwartz10612.Poppler", "★Windows 装 poppler 给 winget★ 包名照 winget-pkgs 里的写");
eq(kt("pdftoppm", "win32", "install"), "winget install oschwartz10612.Poppler", "别名折过去也是同一句");
ok(doctor.EXTERNAL_TOOLS.every((t) => !/\b(scoop|choco)\b/.test(t.install.win32 || "")),
  "Windows 那一列里一个 scoop / choco 都没有", doctor.EXTERNAL_TOOLS.map((t) => t.install.win32));
eq(kt("pdftotext", "darwin", "install"), "brew install poppler", "反向对照：Mac 上还是 brew，没被一起改掉");
// Windows 上的 python：python3 是商店占位程序，体检得说清楚有没有一个真能用的
eq(kt("python", "win32", "install"), "winget install Python.Python.3.12", "Windows 认得 python，给 winget 的装法");
eq(kt("py", "win32", "name"), "python", "py（python.org 的启动器）折回 python");
eq(doctor.knownTool("python", "darwin"), null, "反向对照：Mac 上不认 python——那边没这个坑，体检和报错提示都跟以前一样");
eq(doctor.knownTool("py", "linux"), null, "反向对照：Linux 上 py 也不认");
eq(doctor.knownTool("python3", "win32"), null, "反向对照：python3 不折回 python（占位程序那句提示归 run_shell 的报错翻译管）");

// ── ⑥ 红线：体检报告里不许出现 Key ──────────────────────────────────────
console.log("\n⑥ 体检报告不许带出 Key");
const SECRET = "sk-这是一把不该出现在体检报告里的钥匙";
const cfg = {
  providers: [
    { id: "openrouter", name: "OpenRouter", api_key: SECRET, base_url: "https://openrouter.ai/api/v1" },
    { id: "ark", name: "火山方舟", api_key: "", base_url: "https://ark.example/api/v3" },
  ],
  models: [{ name: "主力", channel: "openrouter", model: "deepseek-chat" }],
};
const counted = doctor.countModels(cfg);
eq(counted.channels, 2, "数出 2 个渠道");
eq(counted.keyed, 1, "数出 1 个填了 Key");
eq(counted.chatModels, 1, "数出 1 个对话模型");
const mv = doctor.verdictModels(counted);
const whole = JSON.stringify(mv) + doctor.render([mv]);
ok(!whole.includes(SECRET), "★整份体检报告里搜不到那把 Key★ 报告是最容易被整段贴进 issue 的东西", mv);
ok(!whole.includes("sk-"), "连 Key 的前缀都不出现");
ok(/2 个渠道/.test(mv.detail) && /1 个还没填 Key/.test(mv.detail), "只报数：几个渠道、几个还没填", mv.detail);
eq(mv.level, "warn", "有一半没填 Key = 留意（能跑，点到那几个会 401）");
eq(doctor.verdictModels({ channels: 0, keyed: 0, chatModels: 0 }).level, "bad", "反向对照：一个渠道都没有是真跑不了");
eq(doctor.verdictModels({ channels: 2, keyed: 0, chatModels: 1 }).level, "bad", "反向对照：一把 Key 都没填也是真跑不了");
eq(doctor.verdictModels({ channels: 2, keyed: 2, chatModels: 0 }).level, "bad", "反向对照：有 Key 没模型照样跑不了");
eq(doctor.verdictModels({ channels: 2, keyed: 2, chatModels: 3 }).level, "ok", "反向对照：都齐了就是 ok");
ok(/engines use claude-code/.test(doctor.verdictModels({ channels: 0, keyed: 0, chatModels: 0 }).fix),
  "没 Key 的人还有第二条路：直接用本机已装的 CLI，一分钱不花", doctor.verdictModels({ channels: 0, keyed: 0, chatModels: 0 }).fix);

// ── ⑦ 每一条都得给「怎么修」，退出码得说实话 ────────────────────────────
console.log("\n⑦ 有毛病就必须给怎么修");
const allBad = [
  doctor.verdictNode("v16.0.0", 18),
  doctor.verdictDeps(["express"], false),
  doctor.verdictDataDir({ dir: "/x", writable: false, errCode: "EROFS" }),
  doctor.verdictConfig({ file: "/x", exists: true, parsed: false, error: "x" }),
  doctor.verdictModels({ channels: 0, keyed: 0, chatModels: 0 }),
  doctor.verdictPort({ port: 3800, host: "127.0.0.1", errCode: "EACCES" }),
  doctor.verdictWorkspace({ dir: "/x", writable: false, errCode: "EACCES" }),
  doctor.verdictEngine({ id: "codex", label: "本机 Codex", installed: false, install: "npm i -g codex" }),
];
const noFix = allBad.filter((it) => !it.fix).map((it) => it.name);
eq(noFix.length, 0, "★每一条坏消息都带着「怎么修」★ 只说哪儿坏了不说怎么办，等于把锅原样还给用户", noFix);
eq(new Set(allBad.map((it) => it.fix)).size, allBad.length, "八条怎么修互不相同（复制粘贴出来的修法治不了病）");
eq(doctor.worst(allBad), doctor.LEVELS.bad, "整体结论：有 bad");
eq(doctor.worst([doctor.verdictNode("v22.0.0", 18)]), doctor.LEVELS.ok, "反向对照：全好时结论是 ok");
eq(doctor.worst([doctor.verdictConfig({ file: "/x", exists: false })]), doctor.LEVELS.warn, "只有 warn 时结论是 warn（退出码还是 0）");

// ── ⑧ 排版：中文列对得齐 ────────────────────────────────────────────────
console.log("\n⑧ 排版");
eq(doctor.cols("依赖"), 4, "中日韩字符按两列算");
eq(doctor.cols("Node"), 4, "西文按一列算");
eq(doctor.cols("Node 版本"), 9, "混排也算得对");
// 三条项目名长短不一（Node 版本 9 列 / 依赖 4 列 / 配置文件 8 列），详情却得从同一列开始
const three = [
  doctor.verdictNode("v22.0.0", 18),
  doctor.verdictDeps([], false),
  doctor.verdictConfig({ file: "/x/config.json", exists: true, parsed: true }),
];
const drawn = doctor.render(three).split("\n");
// 量的是「详情前面那段的显示宽度」：找到详情在行里的位置，把前缀按列数算一遍
const at = three.map((it) => {
  const line = drawn.find((l) => l.includes(it.detail));
  return line === undefined ? -1 : doctor.cols(line.slice(0, line.indexOf(it.detail)));
});
eq(new Set(at).size, 1, "★三行的详情从同一列开始★ padEnd 数的是码位不是显示宽度，拿它对中文列会参差不齐", at);
ok(at[0] > 0, "而且真量到了东西（-1 说明这行压根没画出来）", at);
ok(doctor.render([doctor.verdictNode("v16.0.0", 18)]).includes("怎么修："),
  "render 把「怎么修」也画出来了（判得对但不显示等于没判）");

// ── ⑨ /api/ping 得是免登录的，而且排在登录闸前面 ────────────────────────
console.log("\n⑨ /api/ping 免登录");
const srv = srcLib.src("server");
const ping = srv.indexOf('app.get("/api/ping"');
const guard = srv.indexOf("app.use(account.authGuard)");
ok(ping > 0, "server.js 里有 /api/ping");
ok(guard > 0 && ping < guard,
  "★/api/ping 必须注册在 authGuard 前面★ 排在后面的话它也要登录，而体检恰恰是在「还没登录」的机器上跑的",
  { ping, guard });
const body = srv.slice(ping, ping + 300);
ok(/app: "openworkbuddy"/.test(body), "回的是认得出的应用名——doctor 靠它分辨「是我自己」还是「别人占了」", body.slice(0, 120));
ok(!/api_key|token|user|cookie/i.test(body), "★只回应用名和版本号★ 免登录的接口多回一个字段就是多一处白送的情报", body.slice(0, 200));

// ── ⑩ 真跑一遍：什么都没配的机器上，openworkbuddy doctor 自己不能先死 ──────────────
// 这是整条链路唯一没法靠纯函数验的一环。cli.js 在读不到 config.json 时是 exit 1 的，
// 而「读不到 config.json」正是最需要体检的时刻——体检工具被自己那道闸挡在门外，
// 等于这个功能对最需要它的人不存在。所以这里起一个真的子进程，用一个空目录当家目录。
console.log("\n⑩ 空机器上真跑一遍 openworkbuddy doctor");
const { spawnSync } = require("child_process");
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), "owb-doctor-"));
try {
  const r = spawnSync(process.execPath, [entry("cli"), "doctor"], {
    encoding: "utf8",
    // 端口挑一个没人用的：体检会去 listen 一下，不该碰用户正开着的那个实例
    env: { ...process.env, OPENWORKBUDDY_HOME: EMPTY, PORT: "3899" },
    timeout: 60000,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  ok(!/找不到 config\.json/.test(out), "★没有 config.json 也照跑★ 被自己那道闸挡住的话，这个功能对最需要它的人等于不存在", out.slice(0, 200));
  ok(/Node 版本/.test(out) && /端口/.test(out) && /模型渠道/.test(out) && /外部工具/.test(out), "九项体检都画出来了", out.slice(0, 200));
  ok(/还没有/.test(out) && /config\.json/.test(out), "如实说「还没有 config.json」，并告诉他怎么生成");
  eq(r.status, 1, "有要处理的项时退出码是 1（openworkbuddy doctor && npm start 才拦得住）");
  ok(!fs.existsSync(path.join(EMPTY, "config.json")), "体检不往用户磁盘上写东西");
  ok(fs.readdirSync(EMPTY).length === 0, "★连目录都没顺手建★ 体检是来看病的，不该改用户的磁盘", fs.readdirSync(EMPTY));
  // 反向对照：配齐了就该是 0。拿一份最小可用配置再跑一遍，证明上面那个 1 不是「永远都 1」
  fs.writeFileSync(path.join(EMPTY, "config.json"), JSON.stringify({
    server: { port: 3899 },
    providers: [{ id: "p1", name: "某渠道", kind: "openai", base_url: "https://example.invalid/v1", api_key: "x" }],
    models: [{ name: "主力", provider: "openai", channel: "p1", model: "some-model", base_url: "https://example.invalid/v1", api_key: "x" }],
  }));
  const r2 = spawnSync(process.execPath, [entry("cli"), "doctor"], {
    encoding: "utf8", env: { ...process.env, OPENWORKBUDDY_HOME: EMPTY, PORT: "3899" }, timeout: 60000,
  });
  eq(r2.status, 0, "反向对照：配齐了退出码是 0", ((r2.stdout || "") + (r2.stderr || "")).slice(-400));
  // 「一切正常」不能直接写死断言：外部工具那条是可选项，装没装因机器而异（CI 的 runner 上
  // 就没有 LibreOffice）。所以改成「除了可选的外部工具，不许还有别的告警」——
  // 既证明了上面那个 1 不是「永远都 1」，又不会变成一条跟着机器环境飘的测试
  const out2 = r2.stdout || "";
  const flagged = out2.split("\n").filter((l) => /^[!✗] /.test(l)).map((l) => l.slice(2).trim().split(/\s{2,}/)[0]);
  eq(flagged.filter((n) => n !== "外部工具").length, 0,
    "反向对照：配齐之后除了可选的外部工具，没有任何一条要处理/要留意", flagged);
  ok(/一切正常|体检结果：能跑/.test(out2), "并且给出了「能跑」这句结论", out2.slice(-200));
} finally {
  fs.rmSync(EMPTY, { recursive: true, force: true });
}

// ── ⑪ 认「端口上那个是不是自己」：旧版没有 /api/ping，照样得认出来 ──────────
// 这一节是被真机打脸打出来的：本机 3800 上跑着的就是 OpenWorkBuddy，只不过是升级前
// 启动的那份，没有 /api/ping。只认 ping 的话，它被判成「被别的程序占了」——
// 而升级后第一次跑体检的人，遇到的恰恰全是这个情形。
(async () => {
  console.log("\n⑪ 认端口上那个程序是不是自己");
  const http = require("http");
  const serve = (handler) => new Promise((r) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => r(srv));
  });
  const HTML = (title, body) => `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body || ""}</body></html>`;
  const open = [];
  try {
    // ① 新版：/api/ping 直接报家门
    const s1 = await serve((req, res) => {
      if (req.url === "/api/ping") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ app: "openworkbuddy", version: "9.9.9" })); }
      res.statusCode = 404; res.end("no");
    });
    open.push(s1);
    eq(await doctor.probeWho(s1.address().port, "127.0.0.1"), "self", "新版：ping 报了家门就是自己");

    // ② 旧版：ping 要登录（401），但首页的 <title> 从第一版起就在
    const s2 = await serve((req, res) => {
      if (req.url === "/api/ping") { res.statusCode = 401; return res.end(JSON.stringify({ error: "未登录", setup: false })); }
      res.setHeader("Content-Type", "text/html");
      res.end(HTML("OpenWorkBuddy"));
    });
    open.push(s2);
    eq(await doctor.probeWho(s2.address().port, "127.0.0.1"), "self",
      "★旧版没有 ping，靠首页 title 也得认出是自己★ 不认的话，升级后第一次体检全是假告警");

    // ③ 反向对照：别人的服务，两条依据都不成立
    const s3 = await serve((req, res) => { res.statusCode = 404; res.end(HTML("nginx 默认页")); });
    open.push(s3);
    eq(await doctor.probeWho(s3.address().port, "127.0.0.1"), "other", "反向对照：别的程序照样报「被占了」");

    // ④ 反向对照：正文里提了一嘴 OpenWorkBuddy 不算——认亲只认 title，不然一篇博客也成了自己
    const s4 = await serve((req, res) => {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/html");
      res.end(HTML("某人的博客", "今天试了试 OpenWorkBuddy，还行。"));
    });
    open.push(s4);
    eq(await doctor.probeWho(s4.address().port, "127.0.0.1"), "other",
      "反向对照：正文提到名字不算，只认 <title>");

    // ⑤ 反向对照：压根没人监听，也不能说成「自己开着」
    const s5 = await serve((_req, res) => res.end("x"));
    const deadPort = s5.address().port;
    await new Promise((r) => s5.close(r));
    eq(await doctor.probeWho(deadPort, "127.0.0.1", 400), "other", "反向对照：没人应答 = other");
  } finally {
    for (const srv of open) srv.close();
  }

  // ── ⑫ Windows：Python 是真是假、注册表 PATH 读没读成 ──────────────────────
  // 这台机器不是 Windows，所以平台、找命令、跑命令全换成假的：只验判断逻辑
  console.log("\n⑫ Windows：查 Python、体检前现读注册表 PATH");
  try {
    const STUB = "C:\\Users\\小王\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe";
    const PY = "C:\\Windows\\py.exe";
    const REAL = "C:\\Program Files\\Python312\\python.exe";
    const fakeWhich = (bins) => ({ resolveBin: async (n) => ({ bin: bins[n] || "" }) });
    const fakeRun = (code) => { const calls = []; const run = async (bin, args) => { calls.push([bin, args]); return { code }; }; run.calls = calls; return run; };

    // ① 占位程序：带 -c 1 跑一次退 9009，不能算数，接着找 py
    let run = fakeRun(9009);
    eq(await doctor.probePython(fakeWhich({ python: STUB, py: PY }), run), PY, "★商店占位程序跑不起来，不算数，改用 py★");
    eq(JSON.stringify(run.calls), JSON.stringify([[STUB, ["-c", "1"]]]), "验的时候带了 -c 1（不带参数会把商店弹出来），只验 WindowsApps 里那个");
    run = fakeRun(9009);
    eq(await doctor.probePython(fakeWhich({ python: STUB }), run), "", "只有占位程序、没有 py：如实报没有");
    // ② 商店真装的 Python 也在 WindowsApps 里：跑得起来就认
    run = fakeRun(0);
    eq(await doctor.probePython(fakeWhich({ python: STUB, py: PY }), run), STUB, "反向对照：WindowsApps 里跑得起来的是真 Python，照认");
    // ③ 别处的 python 是安装器放的真身，不多起一个子进程
    run = fakeRun(9009);
    eq(await doctor.probePython(fakeWhich({ python: REAL }), run), REAL, "Program Files 里的 python 直接认");
    eq(run.calls.length, 0, "反向对照：不在 WindowsApps 里就不跑 -c 1");
    // ③b WindowsApps 排在真 Python 前面：src/platform/which 现在认得出别名（stat 报错、lstat 在），resolveBin 先撞上的是占位程序。
    //     跑不起来就跳过 WindowsApps 再找一遍，后面那个真的照认，不能报「缺」
    const W = require(mod("which"));
    const APPS = "C:\\Users\\小王\\AppData\\Local\\Microsoft\\WindowsApps";
    const PYDIR = "C:\\Users\\小王\\AppData\\Local\\Programs\\Python\\Python312";
    const kinds = { [APPS + "\\python.exe"]: "alias", [PYDIR + "\\python.exe"]: "file", ["C:\\Windows\\py.exe"]: "file" };
    const st = (k) => ({ isFile: () => k === "file", isDirectory: () => false });
    const wio = {
      statSync: (p) => { if (kinds[p] === "file") return st("file"); throw Object.assign(new Error(kinds[p] ? "UNKNOWN: unknown error, stat" : "ENOENT"), { code: kinds[p] ? "UNKNOWN" : "ENOENT" }); },
      lstatSync: (p) => { if (kinds[p]) return st(kinds[p]); throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
      accessSync: () => {},
    };
    const dirsWhich = (dirs, extra = true) => ({
      resolveBin: async (n) => ({ bin: W.findIn(dirs, n, "win32", wio) }),
      ...(extra ? { searchDirs: () => dirs, findIn: (d, n) => W.findIn(d, n, "win32", wio) } : {}),
    });
    // findIn 现在把别名排到最后（后面有真文件就给真的），所以这里 resolveBin 照 PATH 顺序先给别名，专门验 probePython 自己那道跳过
    const aliasFirst = (dirs) => ({
      resolveBin: async (n) => ({ bin: W.findIn(dirs.filter((d) => d === APPS), n, "win32", wio) || W.findIn(dirs, n, "win32", wio) }),
      searchDirs: () => dirs, findIn: (d, n) => W.findIn(d, n, "win32", wio),
    });
    eq(W.findIn([APPS, PYDIR], "python", "win32", wio), PYDIR + "\\python.exe", "（前提）WindowsApps 在前时，findIn 也先给后面那个真的");
    run = fakeRun(9009);
    eq(await doctor.probePython(dirsWhich([APPS, PYDIR]), run), PYDIR + "\\python.exe", "占位程序排在前面、后面有真 Python → 认后面那个，不跑 -c 1");
    eq(run.calls.length, 0, "真文件不在 WindowsApps 里，不多起子进程");
    run = fakeRun(9009);
    eq(await doctor.probePython(aliasFirst([APPS, PYDIR]), run), PYDIR + "\\python.exe", "★resolveBin 先给了占位程序、后面有真 Python → 认后面那个，不报缺★");
    eq(JSON.stringify(run.calls), JSON.stringify([[APPS + "\\python.exe", ["-c", "1"]]]), "只对占位程序跑了一次 -c 1，后面那个不跑");
    run = fakeRun(0);
    eq(await doctor.probePython(aliasFirst([APPS, PYDIR]), run), APPS + "\\python.exe", "反向对照：WindowsApps 里那个跑得起来（商店真装的）→ 就认它");
    run = fakeRun(9009);
    eq(await doctor.probePython(dirsWhich([APPS, "C:\\Windows"]), run), "C:\\Windows\\py.exe", "反向对照：后面没有真 python → 照旧退到 py");
    run = fakeRun(9009);
    eq(await doctor.probePython(dirsWhich([APPS]), run), "", "反向对照：只有占位程序 → 如实报没有");
    run = fakeRun(9009);
    eq(await doctor.probePython({ resolveBin: aliasFirst([APPS, PYDIR, "C:\\Windows"]).resolveBin }, run), "C:\\Windows\\py.exe", "反向对照：which 不给 searchDirs / findIn 时跟以前一样，直接退到 py");
    const rowReal = (await doctor.probeTools(dirsWhich([APPS, PYDIR]), "win32", fakeRun(9009))).find((t) => t.name === "python");
    ok(!!rowReal && rowReal.bin === PYDIR + "\\python.exe", "probeTools：体检里 python 那一行填的是后面那个真的", rowReal);

    // ④ probeTools：python 只在 Windows 上查
    const which4 = fakeWhich({ ffmpeg: "C:\\ff\\ffmpeg.exe", python: STUB });
    const win = await doctor.probeTools(which4, "win32", fakeRun(9009));
    const pyRow = win.find((t) => t.name === "python");
    ok(!!pyRow && pyRow.bin === "", "Windows 上体检列出 python，占位程序被判成「缺」", win);
    ok(pyRow && pyRow.install === "winget install Python.Python.3.12", "缺 python 时给的装法是 winget", pyRow);
    const mac = await doctor.probeTools(which4, "darwin");
    eq(mac.map((t) => t.name).join(","), "ffmpeg,pdftotext,pandoc,soffice", "反向对照：Mac 上体检的清单跟以前一模一样，不多查 python");
    const v = doctor.verdictTools(win);
    ok(/python（跑技能里的 Python 脚本）/.test(v.detail) && /winget install Python\.Python\.3\.12/.test(v.fix), "报告里写了缺 python、怎么装", v);

    // ⑤ 注册表 PATH：只在 Windows 上现读，读不成照实写进报告
    let refreshed = 0;
    const whichR = (error) => ({ ...fakeWhich({}), refreshWinPath: async () => { refreshed++; return { dirs: [], error }; } });
    eq(await doctor.freshWinPath(whichR("系统 PATH：3 秒没读完"), "win32"), "系统 PATH：3 秒没读完", "Windows 上体检前读一次注册表，读不成的原话带回来");
    eq(refreshed, 1, "读了一次");
    eq(await doctor.freshWinPath(whichR(""), "darwin"), "", "反向对照：Mac 上什么都不读");
    eq(refreshed, 1, "反向对照：Mac 上 refreshWinPath 一次都没被调");
    eq(await doctor.freshWinPath({ ...fakeWhich({}), refreshWinPath: async () => { throw new Error("炸了"); } }, "win32"), "炸了", "refreshWinPath 自己抛了也不让体检崩，原话带回来");
    const vErr = doctor.verdictTools(win, { pathError: "用户 PATH：拒绝访问。" });
    ok(/注册表里的 PATH 没读全（用户 PATH：拒绝访问。）/.test(vErr.detail), "★缺东西又没读全注册表时，报告里照实写上★", vErr.detail);
    ok(!/注册表/.test(doctor.verdictTools(win).detail), "反向对照：读成了就不提", doctor.verdictTools(win).detail);
    ok(!/注册表/.test(doctor.verdictTools([{ name: "ffmpeg", use: "x", bin: "C:\\ff.exe", install: "" }], { pathError: "x" }).detail),
      "反向对照：什么都不缺时不提（那条报错不影响结论）");

    // ⑥ gather 真把这几步串起来了：Windows 先读注册表、再查（含 python），读不成写进「外部工具」那一行
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-doctor-win-"));
    try {
      const freePort = await new Promise((r) => { const s = require("net").createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
      const order = [];
      const gWhich = {
        resolveBin: async (n) => { order.push("find:" + n); return { bin: n === "ffmpeg" ? "C:\\ff\\ffmpeg.exe" : "" }; },
        refreshWinPath: async () => { order.push("refresh"); return { dirs: [], error: "系统 PATH：拒绝访问。" }; },
      };
      const gDeps = (platform) => ({
        paths: { APP_DIR: ROOT, DATA_DIR: tmp, isPackaged: () => false, dataPath: (n) => path.join(tmp, n) },
        config: { server: { port: freePort, host: "127.0.0.1" } },
        engines: { BUILTIN: { label: "内置引擎" } },
        workspaceDir: tmp,
        bootCheck: { MIN_NODE: 18, findMissing: () => [], readDeps: () => ({}) },
        which: gWhich, platform,
      });
      const oldPort = process.env.PORT; delete process.env.PORT;
      let items;
      try { items = await doctor.gather(gDeps("win32")); } finally { if (oldPort !== undefined) process.env.PORT = oldPort; }
      const row = items.find((i) => i.name === "外部工具");
      eq(order[0], "refresh", "Windows：先读注册表，再一个个查", order);
      ok(order.includes("find:python") && order.includes("find:py"), "Windows：python、py 都查了", order);
      ok(row && /注册表里的 PATH 没读全（系统 PATH：拒绝访问。）/.test(row.detail), "读不成的原话进了「外部工具」那一行", row);
      order.length = 0;
      delete process.env.PORT;
      try { items = await doctor.gather(gDeps("darwin")); } finally { if (oldPort !== undefined) process.env.PORT = oldPort; }
      const rowMac = items.find((i) => i.name === "外部工具");
      ok(!order.includes("refresh") && !order.some((s) => /python|:py$/.test(s)), "反向对照：Mac 上不读注册表、不查 python", order);
      ok(rowMac && !/注册表/.test(rowMac.detail), "反向对照：Mac 上的报告里没有注册表那句", rowMac);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  } catch (e) {
    ok(false, "⑫ 这一节自己崩了：" + ((e && e.stack) || e));
  }

  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail === 0 ? 0 : 1);
})();
