"use strict";
/**
 * Docker 一键部署的测试。
 *
 *   node test/deploy.js            静态部分：秒级，不需要 Docker，e2e 里跑的是这个
 *   node test/deploy.js --build    真的 build 一个镜像、真的把容器跑起来、真的注册管理员
 *
 * 静态部分不是「文件存在就算过」。它盯的是三件一破就出事的事：
 *
 *   1. .dockerignore 有没有把凭证和用户数据挡在镜像外面。
 *      镜像层是只读快照，config.json 一旦进去，push 到任何 registry 就是公开你的 API Key，
 *      而且删不掉。这条是这个文件里最重要的断言。
 *   2. compose 里所有变量能不能在「什么都没设」的情况下插值成功。
 *      ${VAR:?...} 这种写法会连不在当前 profile 里的服务一起卡住——docker compose build
 *      都跑不起来。这坑踩过一次。
 *   3. server.js 在数据目录 ≠ 代码目录时会不会把内置技能铺过去。
 *      不铺的话容器能起来、界面能打开，就是技能列表空的——最难查的那种「没坏但没用」。
 *
 * --build 那部分才是真验收：不看文件，看容器里到底跑成了什么样。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const BUILD = process.argv.includes("--build");

let pass = 0, fail = 0;
// 少数几条断言要 await（比如逐个 require 生产依赖），攒在这儿最后统一跑
const awaitables = [];
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
/** 去掉注释再扫。不去的话，文件里那句「别写 ${VAR:?...}」的说明本身就会被当成犯规。 */
const bare = (t) => t.split("\n").map((l) => (/^\s*#/.test(l) ? "" : l.replace(/\s+#.*$/, ""))).join("\n");

// ===================================================================
// 【1】.dockerignore：凭证和用户数据不许进镜像
// ===================================================================
console.log("\n【1】.dockerignore —— 镜像里不许有你的 Key 和你的文件");

ok(fs.existsSync(path.join(ROOT, ".dockerignore")), ".dockerignore 存在（没有它 COPY . . 会把整个仓库塞进去）");
const IGN = read(".dockerignore");

/** 按 Docker 的 ignore 规则判一个路径会不会被排除（够用的子集：前缀目录 + 通配 + ! 取反） */
function ignored(p) {
  let hit = false;
  for (let line of IGN.split("\n")) {
    line = line.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const neg = line.startsWith("!");
    const pat = (neg ? line.slice(1) : line).replace(/\/$/, "");
    // 目录前缀命中，或整段通配命中
    const re = new RegExp("^" + pat.split("*").map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "(/|$)");
    if (re.test(p)) hit = !neg;
  }
  return hit;
}

// 自检：先证明 ignored() 本身不是个恒真函数，不然下面全是废话
ok(!ignored("server.js") && !ignored("public/index.html") && !ignored("engines/tool-bridge.js"),
   "自检：源码文件不会被误判成排除（否则下面的断言全是空的）");

for (const p of [
  "config.json",            // 模型 API Key
  "config.json.bak",
  "data/users.json",        // 账号、密码哈希、token
  "data/orgs.json",
  "workspace/客户资料.docx", // 成果文件
  "backups/2026-01-01.zip",
  "plugins/whatever/x.js",
  "schedules.json",
  ".env",
  "id_rsa.pem",
  "粘贴文本_0909_162900.txt",
]) ok(ignored(p), `不进镜像：${p}`);

for (const p of ["node_modules/express/index.js", "dist/OpenWorkBuddy.dmg", ".git/config", "eval/runs/x.json"])
  ok(ignored(p), `不进镜像（纯体积）：${p}`);

// 上面那张清单是手抄的，而手抄的清单必然漏。2026-09-20 一查就漏了五条——projects/、
// logs/、.openworkbuddy/、openworkbuddy-data/，以及改名前那个同样存着 Key 的数据目录——
// .gitignore 里早写着，这边一直没跟上。
// 漏掉的后果不是镜像大一点。Dockerfile 是 COPY . .，在开发机上 build 一次，真任务的追踪账本
// （本机那份 traces.jsonl 3.3 MB，里头是提示词原文和工具参数）和 openworkbuddy-data/config.json
// 里的模型 Key 就固化进只读镜像层，push 到任何 registry 之后删不掉也改不了。
// 而且这几条特别难被发现：它们只在「从源码树直接跑过」的机器上才有内容，CI 上永远是空目录。
//
// 所以判据改成推导的：git 不要的东西，docker 一样不许要。以后往 .gitignore 加一行，
// 忘了同步这边就在这儿红一次，不用再指望有谁记得。
/** 返回「git 挡住了、docker 没挡住」的那些条目。判据抽出来，下面拿编的数据反向验一遍 */
function dockerMisses(gitTxt, dockerTxt) {
  const norm = (txt) => txt.split("\n")
    .map((l) => l.replace(/\s+#.*$/, "").trim())          // 行尾注释（node_modules/ 那行就有）
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
    .map((l) => l.replace(/^\/+/, "").replace(/\/+$/, ""));
  const pats = new Set(norm(dockerTxt));
  const dirs = [...pats].filter((p) => !p.includes("*"));  // 目录整个排掉的，底下的文件不用再列一遍
  return norm(gitTxt).filter((p) => !pats.has(p) && !dirs.some((d) => p.startsWith(d + "/")));
}
const gitOnly = dockerMisses(read(".gitignore"), IGN);
ok(gitOnly.length === 0,
  ".gitignore 挡住的每一条，.dockerignore 也挡着（漏的那条会被 COPY . . 烤进只读镜像层）",
  "这几条只在 .gitignore 里：" + gitOnly.join("、"));

// 反向对照：这条判据得真会红，也不能红错人
ok(dockerMisses("projects/\n", "data/\n").join() === "projects",
  "反向对照：docker 那边少一条就抓得到");
ok(dockerMisses("docs/images/demo.mp4\n", "docs/images/\n").length === 0,
  "反向对照：上级目录已经整个排掉的，不算漏（不然每加一张图都误报一次）");
ok(dockerMisses("node_modules/\n", "node_modules/   # 镜像里自己装\n").length === 0,
  "反向对照：行尾注释要剥干净（不剥的话现成的 node_modules/ 那行就会被判成没挡）");
ok(dockerMisses(read(".gitignore"), "").length > 20,
  "反向对照：把 .dockerignore 清空会抓出一大把（证明上面那条不是因为解析失败才绿的）");

// 反向对照：server.js 真正 require 的本地模块，一个都不许被排除掉。
// v0.1.1 的装机包就是被白名单漏掉 engines/ 才「装完打不开」的，同一个坑不踩第二次。
const serverSrc = read("server.js");
const localReqs = [...new Set([...serverSrc.matchAll(/require\("\.\/([^"]+)"\)/g)].map((m) => m[1]))]
  .filter((n) => n !== "package.json");
const missed = localReqs.filter((n) => {
  const f = fs.existsSync(path.join(ROOT, n + ".js")) ? n + ".js" : n;
  return ignored(f);
});
ok(missed.length === 0, `server.js require 的 ${localReqs.length} 个本地模块一个都没被 .dockerignore 挡掉`, missed);
ok(!ignored("skills"), "skills/ 得进镜像（首次启动要从这儿铺到数据目录）");
ok(!ignored("config.example.json"), "config.example.json 得进镜像（没有它连 config.json 都生不出来）");

// ===================================================================
// 【2】compose：什么变量都不设也得能跑
// ===================================================================
console.log("\n【2】docker-compose.yml —— 空环境下也能插值成功");

const COMPOSE = bare(read("docker-compose.yml"));
const bad = [...COMPOSE.matchAll(/\$\{([A-Z_]+):\?/g)].map((m) => m[1]);
ok(bad.length === 0, "没有 ${VAR:?...} 这种写法（它会连不在 profile 里的服务一起把 build 卡死）", bad);

const vars = [...new Set([...COMPOSE.matchAll(/\$\{([A-Z_]+)([:\-?][^}]*)?\}/g)].map((m) => m[1] + (m[2] || "")))];
const noDefault = vars.filter((v) => !v.includes(":-"));
ok(noDefault.length === 0, "每个变量都带默认值（用户不写 .env 直接 up 也不炸）", noDefault);

ok(/OPENWORKBUDDY_HOME:\s*\/data/.test(COMPOSE), "数据目录用 OPENWORKBUDDY_HOME=/data 统一到一个卷");
// 只看 app 这个服务的挂载：caddy 自己那几个卷不算
const appBlock = (COMPOSE.split(/^  app:$/m)[1] || "").split(/^  [a-z]/m)[0];
const mounts = [...appBlock.matchAll(/^\s+- (.+):(\/[^:\s]+)(:ro)?$/gm)].map((m) => m[2]);
ok(mounts.length === 1 && mounts[0] === "/data", "app 只有一个数据挂载点，没有按文件挂的 bind mount（宿主机上那个文件不存在时 Docker 会给你建个同名目录，然后报一个看不懂的错）", mounts);
ok(/"\$\{OPENWORKBUDDY_BIND:-127\.0\.0\.1\}/.test(COMPOSE), "端口默认只绑 127.0.0.1（这个 agent 手里有 shell，默认不对外）");

// Dockerfile 里不许留 VOLUME：留了每次重建容器都多一个匿名卷，攒着占磁盘
const DF = read("Dockerfile");
ok(!/^VOLUME/m.test(DF), "Dockerfile 里没有 VOLUME 声明（否则每次 recreate 都掉一个匿名卷）");
ok(/OPENWORKBUDDY_HOME=\/data/.test(DF), "Dockerfile 也设了 OPENWORKBUDDY_HOME（不用 compose、光 docker run 也对）");
ok(/COPY package\*\.json \.\/[\s\S]*RUN npm (ci|install)[\s\S]*COPY \. \./.test(DF),
   "先拷 package.json 装依赖、再拷代码（改一行业务代码不用重装几百个包）");
// 这条卡的是命令本身：install 会重新解析 semver，同一个 commit 不同日期 build 出的镜像不一样
ok(/RUN npm ci --omit=dev/.test(DF), "Dockerfile 用 npm ci 照 lockfile 装（npm install 会让镜像依赖漂移）");
ok(/HEALTHCHECK/.test(DF) && /\/api\/auth\/state/.test(DF), "有健康检查，打的是不需要登录的那个端点");

// ===================================================================
// 【3】deploy.sh：一条命令，且不偷偷动系统
// ===================================================================
console.log("\n【3】deploy.sh —— 一条命令起来，且不背着你改系统");

ok(fs.existsSync(path.join(ROOT, "deploy.sh")), "deploy.sh 存在");
const SH = read("deploy.sh"); // 这份要保留注释：下面几条断言就是在查注释里有没有硬编码的密钥
ok((fs.statSync(path.join(ROOT, "deploy.sh")).mode & 0o111) !== 0, "deploy.sh 有可执行位");
ok(spawnSync("bash", ["-n", path.join(ROOT, "deploy.sh")]).status === 0, "bash -n 通过");

// 空数组展开：macOS 自带的是 bash 3.2，"${A[@]}" 在 set -u 下会报 unbound variable
ok(!/(^|[^+])"\$\{PROFILE\[@\]\}"/.test(SH), "没有 \"${PROFILE[@]}\" 裸写法（macOS 的 bash 3.2 + set -u 会当场炸）");
ok(/\$\{PROFILE\[@\]\+"\$\{PROFILE\[@\]\}"\}/.test(SH), "空数组用的是 ${A[@]+\"${A[@]}\"} 的兼容写法");

// 这个脚本不许自作主张改系统：装 Docker、开防火墙、改 systemd 都得用户自己点头
for (const forbidden of [/\bapt-get install\b/, /\bsystemctl (enable|start) docker\b/, /\bufw\b/, /\biptables\b/, /curl[^\n]*\|\s*sh\b/])
  ok(!new RegExp(forbidden.source, "m").test(SH.replace(/^\s*#.*$/gm, "").replace(/die "[^"]*"/gs, "")),
     `脚本自己不执行：${forbidden.source}（只在报错信息里告诉用户怎么装）`);

ok(/--domain/.test(SH) && /--update/.test(SH) && /--down/.test(SH) && /--logs/.test(SH), "四个子命令都在：--domain / --update / --logs / --down");
ok(/State\.Health\.Status/.test(SH), "等的是容器真的 healthy，不是 sleep 几秒就宣布成功");
ok(/第一个注册的就是管理员/.test(SH), "起来之后提醒用户马上注册管理员（空实例挂着=谁先访问谁是管理员）");
ok(!/[A-Za-z0-9_]{20,}\s*$/m.test(SH.split("\n").filter((l) => /KEY|TOKEN|SECRET|PASSWORD/i.test(l)).join("\n")),
   "脚本里没有硬编码的密钥");

const ENVX = bare(read("deploy/env.example"));
// 「长 = 可疑」这条粗规矩要放过路径：默认值 ./openworkbuddy-data 就有 20 个字符，
// 而真漏进来的密钥不会以 ./ 或 / 开头。判据放在「开头长什么样」上，比放在长度上准。
ok(!/=(?!\.{0,2}[\/~])[^\s#]{16,}/.test(ENVX), "deploy/env.example 里没有任何真值（全是空的、路径、或者显而易见的默认值）");
ok(/OPENWORKBUDDY_DATA|OPENWORKBUDDY_BIND|OPENWORKBUDDY_PORT|OPENWORKBUDDY_DOMAIN/.test(ENVX), "env.example 覆盖了 compose 用到的变量");
for (const v of ["OPENWORKBUDDY_DATA", "OPENWORKBUDDY_BIND", "OPENWORKBUDDY_PORT", "OPENWORKBUDDY_DOMAIN", "OPENWORKBUDDY_TRUST_PROXY"])
  ok(new RegExp("^" + v + "=", "m").test(ENVX), `env.example 里有 ${v}`);

// 反代下的限流：挂了 caddy 之后所有请求都来自代理那一个 IP，
// 注册闸（5 次/15 分钟）会变成「第 6 个同事注册不了」，登录闸会变成「有人错几次全公司进不去」。
// 但这个开关只能是显式打开的——没反代却打开，等于伪造一行头就换一个新 IP。
ok(/OPENWORKBUDDY_TRUST_PROXY:\s*\$\{OPENWORKBUDDY_TRUST_PROXY:-0\}/.test(COMPOSE), "compose 透传 OPENWORKBUDDY_TRUST_PROXY 且默认 0（不信转发头）");
ok(/^OPENWORKBUDDY_TRUST_PROXY=0$/m.test(ENVX), "env.example 里 OPENWORKBUDDY_TRUST_PROXY 默认 0");
ok(/\[ -n "\$DOMAIN" \] && setenv OPENWORKBUDDY_TRUST_PROXY 1/.test(SH), "deploy.sh --domain（自带 caddy）时才自动把它打开");
ok(!/setenv OPENWORKBUDDY_TRUST_PROXY 1\s*$/m.test(bare(SH).split("\n").filter((l) => !/\$DOMAIN/.test(l)).join("\n")),
   "反向对照：没有一处无条件把 OPENWORKBUDDY_TRUST_PROXY 打开");

// deploy.sh 会在仓库目录里直接建 .env 和 openworkbuddy-data/，而 openworkbuddy-data/config.json 里就是 API Key。
// 这两条不在 .gitignore 里，用户一个 `git add -A` 就把自己的 Key 提上去了。
const GI = read(".gitignore").split("\n").map((l) => l.trim());
ok(GI.includes(".env"), ".env 在 .gitignore 里（deploy.sh 会在仓库里建它）");
ok(GI.includes("openworkbuddy-data/") || GI.includes("openworkbuddy-data"), "openworkbuddy-data/ 在 .gitignore 里（里面的 config.json 就是你的 API Key）");
ok(GI.includes("config.json"), "反向对照：config.json 本来就在（不是刚被谁删了）");

// ===================================================================
// 【4】seedDataDir：数据目录 ≠ 代码目录时，内置技能得铺过去
// ===================================================================
console.log("\n【4】换了数据目录，内置技能还在不在");

ok(/^seedDataDir\(\);/m.test(serverSrc), "server.js 启动时真的调了 seedDataDir（不能是注释掉的那种——注释掉照样能匹配裸正则）（以前只有 electron-main 调，纯 node 起的容器技能是空的）");

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-seed-"));
  const r = spawnSync(process.execPath, ["-e", `
    process.env.OPENWORKBUDDY_HOME = ${JSON.stringify(tmp)};
    const p = require(${JSON.stringify(path.join(ROOT, "paths.js"))});
    p.seedDataDir();
    const fs = require("fs"), path = require("path");
    const dirs = fs.readdirSync(path.join(${JSON.stringify(tmp)}, "skills"), { withFileTypes: true }).filter(e => e.isDirectory());
    console.log(JSON.stringify({ skills: dirs.length, experts: fs.existsSync(path.join(${JSON.stringify(tmp)}, "experts.json")) }));
  `], { encoding: "utf8" });
  let out = {};
  try { out = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch {}
  const bundled = fs.readdirSync(path.join(ROOT, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  ok(out.skills === bundled && bundled > 0, `内置技能全都铺过去了（${out.skills}/${bundled}）`, { got: out.skills, want: bundled });
  ok(out.experts === true, "experts.json 也铺过去了");
  // 反向对照：数据目录就是代码目录时（开发态 / npm run app），它必须是空操作
  const r2 = spawnSync(process.execPath, ["-e", `
    const p = require(${JSON.stringify(path.join(ROOT, "paths.js"))});
    console.log(p.DATA_DIR === p.APP_DIR ? "noop" : "seeded");
  `], { encoding: "utf8" });
  ok((r2.stdout || "").includes("noop"), "反向对照：开发态两个目录本来就是同一个，seed 是空操作（行为一个字节不变）");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ===================================================================
// 【5】依赖声明：代码里 require 的 npm 包，package.json 里必须有名字
// ===================================================================
// 这条和【1】【4】是同一类事：装机包在用户手上打不开。
// 区别是这类断不掉在文件上——scripts/check-package-files.js 明确跳过 node_modules，
// 它只管本仓库的文件在不在包里。npm 包在不在，只能看 dependencies 写没写。
// 开发机的 node_modules 是一层层装出来的，别的包顺带带进来的东西这儿也 require 得到，
// 于是本地全绿、用户那份照着 dependencies 装的包一用就 MODULE_NOT_FOUND。
console.log("\n【5】用到的 npm 包，package.json 里有没有声明");

{
  const gate = require(path.join(ROOT, "scripts", "check-package-files.js"));

  const missing = gate.missingDeps();
  ok(
    missing.length === 0,
    "装机态会跑到的源文件里，require 的 npm 包全都写进 dependencies 了",
    missing.map((m) => `${m.pkg}（${m.file}）`)
  );

  // 反向对照：把 dependencies 当成空的，这条闸门必须立刻炸，而且得点出是哪个文件
  const wouldCatch = gate.missingDeps({});
  const names = wouldCatch.map((m) => m.pkg);
  ok(wouldCatch.length > 0, "反向对照：dependencies 清空后闸门会红（不是恒真的断言）", { got: wouldCatch.length });
  ok(
    names.includes("@anthropic-ai/sdk") && wouldCatch.some((m) => m.pkg === "@anthropic-ai/sdk" && m.file === "llm.js"),
    "反向对照：能定位到 @anthropic-ai/sdk 来自 llm.js（就是它漏声明，害得选了 Claude 的人发第一条消息才报错）",
    names
  );
  ok(names.includes("express"), "反向对照：@scope 之外的普通包也认得出来（express）", names);

  // 包名解析本身的边界：作用域包只留两段，node: 前缀和相对路径不算依赖
  const parsed = gate.bareRequires(
    'require("@scope/pkg/sub/deep");require("plain/sub");require("node:fs");require("./local");require("fs")'
  );
  ok(
    JSON.stringify(parsed) === JSON.stringify(["@scope/pkg", "plain", "fs"]),
    "包名解析：@scope/pkg 只留两段、node: 前缀跳过、相对路径不算",
    parsed
  );

  // 例外名单不是随便加的：每一条都得有「为什么不用声明」的实据
  const pkgJson = JSON.parse(read("package.json"));
  ok(
    !Object.keys(pkgJson.dependencies || {}).includes("electron"),
    "electron 留在 devDependencies（进了 dependencies 的话装机包里会多塞一整份 Electron）"
  );
  ok(
    /try\s*\{[^}]*require\("ws"\)/.test(read("im-qq.js")),
    "ws 的例外成立：它只是 Node 22 以下的兜底分支，外面包着 try/catch"
  );

  // Claude 这条渠道现在是真能用的：声明在、地址算法只有一份
  ok(
    /"@anthropic-ai\/sdk"\s*:/.test(read("package.json")),
    "Anthropic SDK 已声明为正式依赖（设置页把「Anthropic Claude」摆出来了，就不能让人装不上）"
  );
  const llmSrc = read("llm.js");
  ok(
    /baseURL:\s*anthropicBase\(cfg\.base_url\)\.baseURL/.test(llmSrc),
    "真跑时把 base_url 传给了 SDK（以前没传，填了中转的人验活过、一发消息打的还是官方）"
  );
  ok(
    /anthropicBase\(m\.base_url\)\.messagesUrl/.test(read("server.js")),
    "向导验活和真跑用同一个地址算法（两套算法 = 绿勾骗人）"
  );
}

// ===================================================================
// 【6】装机包瘦身：既不能虚胖，也不能删过头
// ===================================================================
// issue #1「下载了打不开」里最难查的一种：Windows 免安装版每次启动都要把整包解压到 %TEMP%，
// 再被 Defender 逐个文件扫一遍——文件越多，「任务管理器里有进程、屏幕上没窗口」的时间越长。
// 所以要删掉运行时一个字节都不读的东西（source map、类型声明）。
// 但删过头更惨：包签得漂漂亮亮，一打开就 Cannot find module。
// 这一节钉的就是这两头——瘦身真生效，且瘦完还 require 得起来。
console.log("\n【6】装机包瘦身：既不能虚胖，也不能删过头");

{
  const gate = require(path.join(ROOT, "scripts", "check-package-files.js"));
  const cfg = read("electron-builder.config.js");

  // —— 删的是哪些文件：只按「运行时永远不读的文件类型」删
  ok(/"!node_modules\/\*\*\/\*\.map"/.test(cfg), "排除了 source map（116 MB，只有 devtools 会读）");
  ok(/"!node_modules\/\*\*\/\*\.d\.ts"/.test(cfg), "排除了 .d.ts 类型声明（35 MB，编译期产物）");
  ok(/"!node_modules\/@types\/\*\*"/.test(cfg), "排除了 @types 整个作用域");

  // —— 绝不能按目录名删。这条不是洁癖，是踩过的坑：
  // @iconify/utils 的运行时代码住在 lib/emoji/test/ 下、exceljs 的核心在 lib/doc/ 下，
  // 按 test/doc/example 删完，mermaid 和 exceljs 当场 require 不起来，省下的只有 1 MB。
  ok(!/!node_modules[^"]*\{?[^"]*\b(tests?|__tests__|examples?|docs?)\b/.test(cfg),
     "没有按目录名删（test/doc/example 里住着真代码：@iconify/utils、exceljs 都栽在这儿）");
  // 许可证要求随分发附上原文，省这几 MB 不值当
  ok(!/!node_modules[^"]*LICENSE/i.test(cfg) && !/!node_modules[^"]*\*\.md/.test(cfg),
     "LICENSE 和 *.md 一律留着（MIT 之类的许可证要求随分发附上原文）");

  // —— 三道闸门都接在 afterPack 上，而且排在签名之前：
  // 顺序反了的话，一个必定打不开的包会被签得漂漂亮亮发出去
  const iComplete = cfg.indexOf("assertPackComplete");
  const iDeps = cfg.indexOf("assertDepsRequirable");
  const iSlim = cfg.indexOf("assertSlimmed");
  const iSign = cfg.indexOf("await adhocSign(ctx)");
  ok(iComplete > 0 && iDeps > 0 && iSlim > 0, "afterPack 里三道闸门都在", { iComplete, iDeps, iSlim });
  ok(iSign > 0 && iComplete < iSign && iDeps < iSign && iSlim < iSign,
     "  └ 而且都排在签名前面（先验货再盖章，别把打不开的包签漂亮了发出去）", { iSign });

  // —— assertSlimmed 真跑：认得出残留，也不许错杀
  ok(gate.DEAD_WEIGHT.some((re) => re.test("index.js.map")), "认得 .map");
  ok(gate.DEAD_WEIGHT.some((re) => re.test("index.d.ts")) && gate.DEAD_WEIGHT.some((re) => re.test("index.d.mts")),
     "认得 .d.ts / .d.mts");
  ok(!gate.DEAD_WEIGHT.some((re) => re.test("index.js")) && !gate.DEAD_WEIGHT.some((re) => re.test("LICENSE")) &&
     !gate.DEAD_WEIGHT.some((re) => re.test("sourcemap.js")),
     "不误伤真代码、许可证，和名字里带 map 的正常文件");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-slim-"));
  try {
    fs.mkdirSync(path.join(tmp, "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "node_modules", "x", "index.js"), "module.exports=1");
    const clean = gate.assertSlimmed(tmp);
    ok(clean.files === 1 && clean.leftovers.length === 0, "干净的包能过闸", clean.files);
    // 反向对照：塞一个 .map 进去，闸门必须红——否则这条断言恒真，等于没测
    fs.writeFileSync(path.join(tmp, "node_modules", "x", "index.js.map"), "{}");
    let threw = null;
    try { gate.assertSlimmed(tmp); } catch (e) { threw = e.message; }
    ok(threw && /排除没生效/.test(threw), "反向对照：剩一个 .map 就红，并且指名道姓", (threw || "没抛").slice(0, 60));
    ok(threw && /index\.js\.map/.test(threw), "  └ 报错里点得出是哪个文件（不然只能一个个翻）");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // —— assertDepsRequirable 真跑：本仓库的生产依赖必须全都 require 得起来。
  // 这是唯一能证明「瘦身没删过头」的办法——光看文件名对不出来。
  awaitables.push(async () => {
    let err = null;
    try { await gate.assertDepsRequirable(ROOT); } catch (e) { err = e.message; }
    ok(!err, "生产依赖逐个 require 得起来（删过头的话这条会红，而不是等用户报障）", (err || "").slice(0, 300));

    // 反向对照：指到一个没有 node_modules 的空目录，闸门必须红
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "owb-dep-"));
    try {
      fs.writeFileSync(path.join(empty, "package.json"), JSON.stringify({ dependencies: { express: "*", "not-a-real-pkg-xyz": "*" } }));
      let threw = null;
      try { await gate.assertDepsRequirable(empty); } catch (e) { threw = e.message; }
      ok(threw && /not-a-real-pkg-xyz/.test(threw), "反向对照：装不上的依赖会被点名（不是恒真的断言）", (threw || "没抛").slice(0, 80));
      ok(threw && /必定打不开/.test(threw), "  └ 报错说清后果，别让人以为只是个警告");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
}

console.log("\n【7】反代模板 —— 流式输出能不能活下来，全看这几行");

// 网页端「一个字一个字出」全靠 SSE。挂反代之后它最常见的死法不是报错，
// 是**看起来没坏**：点了开始一直转圈，过半天哗一下全刷出来，用户只会以为模型慢。
// 实测（nginx 1.30.0，上游每 250ms 吐一行，量每行到达客户端的时刻）：
//   gzip off                       + proxy_buffering off → 276/523/774/1025/1276/1527  逐行到
//   gzip on（types 不含 SSE 类型）   + proxy_buffering off → 256/523/758/1009/1260/1515  逐行到
//   gzip on（types 不含 SSE 类型）   + proxy_buffering on  → 272/522/773/1023/1274/1526  逐行到
//   gzip on（types **含** SSE 类型） + proxy_buffering off → 273/510/761/1012/1263/1515  逐行到
//   gzip on（types **含** SSE 类型） + proxy_buffering on  → 1511ms × 6   ★全卡到最后一起出★
// 所以真正的判据不是「gzip 开没开」，是**gzip 有没有压到 text/event-stream**，
// 而且要配上缓冲才会出事。nginx 自带的 gzip_types 默认只有 text/html，压不到 SSE；
// 雷是从网上抄一长串带 text/event-stream 的 MIME 清单，或者图省事写 gzip_types *;。
// 下面这两条就是守这个：清单里不许有 SSE 类型，缓冲必须关（互为第二道保险）。
{
  // 只看生效的指令，注释不算。模板里那句「千万别写 proxy_set_header Accept-Encoding ""」
  // 本身就含着要禁的那串字，上面那段说明里也反复出现 text/event-stream——
  // 照着原文匹配的话，写警告的人反而被自己的警告判挂。
  const ngx = read("deploy/nginx.conf").replace(/^\s*#.*$/gm, "").replace(/\s+#.*$/gm, "");
  const types = (ngx.match(/^\s*gzip_types\s+([^;]*);/m) || [, ""])[1];
  ok(!/text\/event-stream/.test(types),
     "nginx 模板的 gzip_types 里混进了 text/event-stream：再配上缓冲，SSE 会整个攒到最后一起出");
  ok(!/\*/.test(types), "nginx 模板写了 gzip_types *：等于把 text/event-stream 也圈进去了");
  ok(/proxy_buffering off;/.test(ngx), "nginx 模板没关 proxy_buffering：流式回答会变成「卡半天然后全出来」");
  // 这一行网上的模板很爱加（为了让 nginx 自己压）。加了之后应用收不到 Accept-Encoding，
  // 只能发未压缩的原文，首屏从 388KB 变回 1134KB——纯亏，而且没人会发现。
  ok(!/proxy_set_header\s+Accept-Encoding\s+""/.test(ngx),
     "nginx 模板把 Accept-Encoding 抹掉了：应用自己压的那份就发不出来，首屏白白大三倍");
  // keepalive 要成对出现：upstream 里写了 keepalive，却不配 proxy_http_version 1.1
  // 和清空 Connection 的话，nginx 还是每个请求新开一条 TCP，那个 keepalive 等于没写。
  if (/keepalive\s+\d+;/.test(ngx)) {
    ok(/proxy_http_version 1\.1;/.test(ngx) && /proxy_set_header Connection "";/.test(ngx),
       "upstream 配了 keepalive，却没配 proxy_http_version 1.1 + 清空 Connection —— 长连接不会生效");
  }
  ok(/proxy_read_timeout\s+(\d+)s;/.test(ngx) && +RegExp.$1 >= 600,
     "proxy_read_timeout 太短：一个任务跑十几分钟很正常，短了会在中途把流掐断（服务端其实还在跑）");
  // 文档里点名了这个文件，文件却不在 → 照着文档做的人第一步就卡住
  ok(/deploy\/nginx\.conf/.test(read("docs/远程访问.md")), "远程访问文档里没点名 deploy/nginx.conf");

  // caddy 那份是同一件事的另一种写法，别只修一边。
  // 实测 caddy v2.11.4：encode 本来就不压 text/event-stream，flush_interval 写不写都逐行到
  // （263/522/771/1027/1282/1532 对 274/518/764/1025/1278/1517）。所以这行是第二道保险，
  // 不是唯一那道——留着，因为将来若有别的非 SSE 长响应，靠的就是它。
  const caddy = read("deploy/Caddyfile");
  ok(/flush_interval -1/.test(caddy), "Caddyfile 少了 flush_interval -1：长响应少一道保险");
}

// ===================================================================
// 【8】开源 / 商业的那条线：口子留着，但开源版身上不许有阉割的痕迹
// ===================================================================
{
  console.log("\n【8】企业加装包的挂载点 + 开源版不许被阉割");

  const srv = read("server.js");

  // ---- 口子本身 ----
  ok(/require\.resolve\("@openworkbuddy\/enterprise"\)/.test(srv),
     "server.js 里没有企业加装包的挂载点：docs/开源与商业版边界.md 第 4 节承诺了「开源版留挂载点」，说了就得有");

  // 先 resolve 探、再 require 载：这两步必须分开。合成一步的话，「没装」和
  // 「装了但自己缺依赖」报的都是 MODULE_NOT_FOUND，后者会被当成前者悄悄咽掉——
  // 客户拿到的就是一台企业功能静悄悄失踪的服务器。
  const loader = srv.slice(srv.indexOf("const enterprise = (() =>"), srv.indexOf("const entDeps"));
  ok(loader.length > 0, "没找到企业加装包的加载器");
  ok(/require\.resolve\([^)]*\)[\s\S]{0,200}catch[\s\S]{0,200}return null/.test(loader),
     "没装应当安静地返回 null；这一档要是也打日志，等于每台个人机器天天报一条假故障");
  ok(/console\.error\(/.test(loader),
     "「装了却加载失败」这一档被咽掉了：那是真事故，必须吵出来");

  // deps 是传进去的，不是让企业包自己 require 的——它不该知道开源版的目录长什么样
  const depsArg = (srv.match(/const entDeps = \{([^}]*)\}/) || [])[1] || "";
  for (const d of ["org", "account", "security", "config"]) {
    ok(new RegExp("\\b" + d + "\\b").test(depsArg), `entDeps 里没有 ${d}，企业包只能反过来 require 开源版的内部文件`);
  }

  // ---- 两个口子，以及它们跟登录闸的先后 ----
  // 这一条是真踩出来的：起初只留了一个口子、挂在 authGuard 后面，结果 SSO 回调
  // （SAML 的 ACS、OIDC 的 redirect_uri）被自己人挡在门外——那一跳按定义就还没登录，
  // 身份正是它要带回来的东西。但也不能把整个企业包挪到闸前，那等于审计外送、
  // 白标设置全都免登录。所以必须是两个口子，且先后固定。
  const iPub = srv.indexOf("enterprise.mountPublic(app");
  const iGuard = srv.indexOf("app.use(account.authGuard)");
  const iMount = srv.indexOf("enterprise.mount(app");
  ok(iPub > 0, "没有 mountPublic：SSO 回调无处可挂，IdP 打回来的那一跳会被登录闸挡住，SSO 走不通");
  ok(iMount > 0, "没有 mount：企业包绝大部分路由无处可挂");
  ok(iGuard > 0, "找不到登录闸");
  ok(iPub < iGuard, "mountPublic 跑到登录闸后面去了：SSO 回调会被自己人挡在门外");
  ok(iGuard < iMount, "mount 跑到登录闸前面去了：审计外送、白标设置这些全都免登录了，这是个洞");

  // mount 不许被 try 包住：要不要「加载失败就别让服务起来」是企业包的判断
  // （SSO 没挂上就不该悄悄退回密码登录）。包了 try，它连 fail-closed 的权利都没有。
  ok(!/try\s*\{[^}]*enterprise\.mount(Public)?\(/.test(srv),
     "enterprise.mount 被 try 包住了：企业包想 fail-closed 都做不到，只能被迫带病运行");

  // ---- 开源版不许被阉割（文档里那条「绝对不要做」）----
  const uiFiles = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, f.name);
      if (f.isDirectory()) walk(fp);
      else if (/\.(js|html|css)$/.test(f.name)) uiFiles.push(fp);
    }
  })(path.join(ROOT, "public"));

  // 只认「拿功能换钱」那类话术。单说「商业授权」不算——关于页本来就该写清授权，
  // 那是**说明**不是**拦路**，写它是对的，不写才是问题。
  const GATE = /升级解锁|升级到(企业|专业|付费)版|(企业|专业|付费|高级)版才(能|有|可)|需要(企业|专业|付费)版|付费解锁|开通后可用|upgrade to (pro|enterprise|premium)|premium only|enterprise only/i;
  const gated = [];
  for (const fp of uiFiles) {
    const hit = (fs.readFileSync(fp, "utf8").match(GATE) || [])[0];
    if (hit) gated.push(`${path.relative(ROOT, fp)}（「${hit}」）`);
  }
  ok(gated.length === 0,
     `界面里出现了付费墙的话术：${gated.join("、")}——开源版不许被阉割，见 docs/开源与商业版边界.md 第 4 节末尾那条「绝对不要做」`);
  // 反向对照：上面那条恒过就等于没测。确认这把尺子真的量得出东西来
  ok(GATE.test("这个功能需要企业版") && GATE.test("upgrade to Pro") && !GATE.test("需要单独购买商业授权"),
     "付费墙话术的判据本身不对：要么抓不到真的，要么把关于页那句正当的授权说明也当成了付费墙");

  // 也别在代码里留功能开关：一旦有人读到 if (license.pro) 这种，项目的定性就变了
  ok(!/\b(isPro|isEnterprise|hasLicense|licenseTier|proOnly|entOnly)\b/.test(srv),
     "server.js 里出现了按授权分档的开关，开源版不该有这种东西");

  // 文档和代码得对得上：文档写了私有仓库的名字，代码里包的名字要是同一个东西
  const boundary = read("docs/开源与商业版边界.md");
  ok(/openworkbuddy-enterprise/.test(boundary),
     "边界文档没写私有仓库叫什么，将来没人知道这个口子对着谁");
  ok(/@openworkbuddy\/enterprise/.test(boundary),
     "边界文档里的示例代码跟 server.js 里真正的包名对不上，照着文档做会挂");
}

// ===================================================================
// 【9】--build：真起一个容器（可选，慢）
// ===================================================================
if (BUILD) {
  console.log("\n【9】真 build、真跑、真注册 —— 这段慢，几分钟");
  awaitables.forEach((fn) => { void fn(); }); // --build 时也别把上面那几条 await 断言漏掉
  const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  const TAG = "openworkbuddy:deploytest";
  const NAME = "owb-deploytest";
  // 数据目录放家目录下，不放 os.tmpdir()。macOS 上的 Docker（colima / Docker Desktop）
  // 是跑在虚拟机里的，只有少数几个宿主机目录被共享进去；/var/folders/... 那种系统临时目录
  // 不在其中——`-v` 上去不会报错，它会在虚拟机里悄悄建一个同名目录，于是容器写得欢，
  // 宿主机这边一个文件都看不见。实测过一次，别再踩。
  const HOME = fs.mkdtempSync(path.join(os.homedir(), ".owb-deploytest-"));
  const PORT = 3899;

  const cleanup = () => { try { sh("docker", ["rm", "-f", NAME], { stdio: "ignore" }); } catch {} };
  cleanup();

  try {
    const t0 = Date.now();
    const buildLog = sh("docker", ["build", "-t", TAG, "."], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    console.log(`  · 构建耗时 ${Math.round((Date.now() - t0) / 1000)}s`);

    // 镜像里到底有没有那几个不该有的东西——这才是真断言，前面的正则只是预防
    const lsIn = (p) => {
      const r = spawnSync("docker", ["run", "--rm", "--entrypoint", "sh", TAG, "-c", `test -e ${p} && echo YES || echo NO`], { encoding: "utf8" });
      return (r.stdout || "").trim();
    };
    ok(lsIn("/app/config.json") === "NO", "镜像里没有 config.json（你的 API Key 没被烤进只读层）");
    ok(lsIn("/app/data") === "NO", "镜像里没有 data/（账号和会话历史没进去）");
    ok(lsIn("/app/workspace") === "NO", "镜像里没有 workspace/（成果文件没进去）");
    ok(lsIn("/app/dist") === "NO", "镜像里没有 dist/（1.2G 的安装包没进去）");
    ok(lsIn("/app/server.js") === "YES", "反向对照：server.js 在（不是把什么都排除了）");
    ok(lsIn("/app/skills") === "YES", "反向对照：内置技能在");
    ok(lsIn("/app/engines") === "YES", "反向对照：engines/ 在（v0.1.1 就是漏了它才装完打不开）");

    const size = +sh("docker", ["image", "inspect", TAG, "--format", "{{.Size}}"]).trim();
    console.log(`  · 镜像 ${(size / 1e9).toFixed(2)} GB`);
    ok(size < 2.4e9, `镜像小于 2.4 GB（没有 .dockerignore 时光上下文就 2.4 GB）`, { gb: +(size / 1e9).toFixed(2) });

    // 真跑起来
    sh("docker", ["run", "-d", "--name", NAME, "-p", `127.0.0.1:${PORT}:3800`,
       "-e", "OPENWORKBUDDY_HOME=/data", "-v", `${HOME}:/data`, TAG]);

    const wait = async () => {
      for (let i = 0; i < 60; i++) {
        const st = spawnSync("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", NAME], { encoding: "utf8" }).stdout.trim();
        if (st === "healthy") return true;
        if (st === "unhealthy") return false;
        await new Promise((r) => setTimeout(r, 3000));
      }
      return false;
    };

    return wait().then(async (healthy) => {
      ok(healthy, "容器自己报 healthy（Dockerfile 里那条 HEALTHCHECK 真能用）");
      if (!healthy) console.log(sh("docker", ["logs", "--tail", "60", NAME]));

      const base = `http://127.0.0.1:${PORT}`;
      const j = async (p, init) => { const r = await fetch(base + p, init); return { s: r.status, b: await r.text(), h: r.headers }; };

      const st = await j("/api/auth/state");
      ok(st.s === 200, "GET /api/auth/state 通", { status: st.s });
      let state = {}; try { state = JSON.parse(st.b); } catch {}
      ok(state.needSetup === true || state.hasUsers === false || /setup|register/i.test(st.b),
         "空实例明说「还没有账号」，第一个注册的就是管理员", state);

      // 真注册一个管理员，看它是不是真成了管理员
      const reg = await j("/api/auth/register", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "bosstest", password: "Dk-Test-9f2a!x" }),
      });
      ok(reg.s === 200, "第一个账号注册得下去", { status: reg.s, body: reg.b.slice(0, 200) });
      const cookie = (reg.h.get("set-cookie") || "").split(";")[0];
      ok(!!cookie, "拿到登录 cookie");

      const me = await j("/api/auth/me", { headers: { cookie } });
      ok(/"role"\s*:\s*"admin"/.test(me.b), "第一个注册的确实是 admin", me.b.slice(0, 200));

      const admin = await j("/api/admin/overview", { headers: { cookie } });
      ok(admin.s === 200, "企业管理后台的接口在容器里也通", { status: admin.s });

      const page = await j("/admin.html");
      ok(page.s === 200 && /ENTERPRISE|企业/.test(page.b), "/admin.html 这张壳子取得到");

      // 第二个人不许自己注册（默认关闭自助注册）
      const reg2 = await j("/api/auth/register", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "stranger", password: "Dk-Test-9f2a!x" }),
      });
      ok(reg2.s !== 200, "管理员注册完，陌生人不能自己再注册（默认关自助注册）", { status: reg2.s });

      // --- 容器里那份：数据到底落在 /data 没有 ---
      const inside = (cmd) => (spawnSync("docker", ["exec", NAME, "sh", "-c", cmd], { encoding: "utf8" }).stdout || "").trim();
      const skillsIn = +inside("ls -1 /data/skills 2>/dev/null | wc -l") || 0;
      ok(skillsIn > 0, `/data/skills 下有 ${skillsIn} 个内置技能（容器不是个空壳——skills.js 只认数据目录，不铺过去这儿就是空的）`);
      ok(inside("test -f /data/config.json && echo Y") === "Y", "config.json 生成在 /data，不在镜像里");
      ok(inside("test -f /data/data/users.json && echo Y") === "Y", "账号落在 /data");
      ok(inside("test -e /app/config.json && echo Y || echo N") === "N", "反向对照：代码目录 /app 底下没有 config.json（没写错地方）");

      // --- 宿主机那份：这个 -v 到底是不是真的绑到了宿主机 ---
      // macOS 上的 Docker 跑在虚拟机里，只有被共享的宿主机目录才是真 bind mount。
      // 先用一个哨兵文件问清楚，问不到就说清楚是环境的事，不假装通过、也不冤枉产品。
      inside("echo probe > /data/.mountprobe");
      const bound = fs.existsSync(path.join(HOME, ".mountprobe"));
      if (bound) {
        const skillCount = fs.existsSync(path.join(HOME, "skills"))
          ? fs.readdirSync(path.join(HOME, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).length : 0;
        ok(skillCount === skillsIn && skillCount > 0, `宿主机 ${HOME.replace(os.homedir(), "~")} 里也看得到这 ${skillCount} 个技能`, { host: skillCount, container: skillsIn });
        ok(fs.existsSync(path.join(HOME, "config.json")), "宿主机上看得到 config.json（备份就是打包这个目录）");
        ok(fs.existsSync(path.join(HOME, "data", "users.json")), "宿主机上看得到账号文件");
      } else {
        console.log("  ⏭️  宿主机侧的三条跳过：这台机器的 Docker 跑在虚拟机里，测试用的目录没被共享进去");
        console.log("      （容器里那几条已经验过了；Linux 服务器上是真 bind mount，不存在这个问题）");
      }

      // 容器重建，数据还在——这是「容器随便删」这句话的凭据
      sh("docker", ["rm", "-f", NAME]);
      sh("docker", ["run", "-d", "--name", NAME, "-p", `127.0.0.1:${PORT}:3800`,
         "-e", "OPENWORKBUDDY_HOME=/data", "-v", `${HOME}:/data`, TAG]);
      const healthy2 = await wait();
      ok(healthy2, "删掉容器重建，还能起来");
      const me2 = await j("/api/auth/me", { headers: { cookie } });
      ok(/bosstest/.test(me2.b), "重建之后原来的登录还认（数据在卷里，不在容器里）", me2.b.slice(0, 120));

      cleanup();
      fs.rmSync(HOME, { recursive: true, force: true });
      done();
    });
  } catch (e) {
    ok(false, "build/run 阶段抛异常：" + (e.message || e).toString().slice(0, 400));
    cleanup();
  }
}

function done() {
  console.log(`\n${fail ? "✗" : "✅"} Docker 部署：${pass} 项通过${fail ? `，${fail} 项挂` : ""}${BUILD ? "" : "（静态部分；真 build 用 --build）"}`);
  process.exit(fail ? 1 : 0);
}
if (!BUILD) {
  (async () => {
    for (const fn of awaitables) await fn();
    done();
  })();
}
