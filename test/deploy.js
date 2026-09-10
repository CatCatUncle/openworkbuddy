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
ok(/"\$\{WB_BIND:-127\.0\.0\.1\}/.test(COMPOSE), "端口默认只绑 127.0.0.1（这个 agent 手里有 shell，默认不对外）");

// Dockerfile 里不许留 VOLUME：留了每次重建容器都多一个匿名卷，攒着占磁盘
const DF = read("Dockerfile");
ok(!/^VOLUME/m.test(DF), "Dockerfile 里没有 VOLUME 声明（否则每次 recreate 都掉一个匿名卷）");
ok(/OPENWORKBUDDY_HOME=\/data/.test(DF), "Dockerfile 也设了 OPENWORKBUDDY_HOME（不用 compose、光 docker run 也对）");
ok(/COPY package\*\.json \.\/[\s\S]*RUN npm install[\s\S]*COPY \. \./.test(DF),
   "先拷 package.json 装依赖、再拷代码（改一行业务代码不用重装几百个包）");
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
ok(!/=[^\s#]{16,}/.test(ENVX), "deploy/env.example 里没有任何真值（全是空的或者显而易见的默认值）");
ok(/WB_HOME|WB_BIND|WB_PORT|WB_DOMAIN/.test(ENVX), "env.example 覆盖了 compose 用到的变量");
for (const v of ["WB_HOME", "WB_BIND", "WB_PORT", "WB_DOMAIN"])
  ok(new RegExp("^" + v + "=", "m").test(ENVX), `env.example 里有 ${v}`);

// deploy.sh 会在仓库目录里直接建 .env 和 wb-data/，而 wb-data/config.json 里就是 API Key。
// 这两条不在 .gitignore 里，用户一个 `git add -A` 就把自己的 Key 提上去了。
const GI = read(".gitignore").split("\n").map((l) => l.trim());
ok(GI.includes(".env"), ".env 在 .gitignore 里（deploy.sh 会在仓库里建它）");
ok(GI.includes("wb-data/") || GI.includes("wb-data"), "wb-data/ 在 .gitignore 里（里面的 config.json 就是你的 API Key）");
ok(GI.includes("config.json"), "反向对照：config.json 本来就在（不是刚被谁删了）");

// ===================================================================
// 【4】seedDataDir：数据目录 ≠ 代码目录时，内置技能得铺过去
// ===================================================================
console.log("\n【4】换了数据目录，内置技能还在不在");

ok(/^seedDataDir\(\);/m.test(serverSrc), "server.js 启动时真的调了 seedDataDir（不能是注释掉的那种——注释掉照样能匹配裸正则）（以前只有 electron-main 调，纯 node 起的容器技能是空的）");

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-seed-"));
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
// 【5】--build：真起一个容器（可选，慢）
// ===================================================================
if (BUILD) {
  console.log("\n【5】真 build、真跑、真注册 —— 这段慢，几分钟");
  const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  const TAG = "openworkbuddy:deploytest";
  const NAME = "owb-deploytest";
  // 数据目录放家目录下，不放 os.tmpdir()。macOS 上的 Docker（colima / Docker Desktop）
  // 是跑在虚拟机里的，只有少数几个宿主机目录被共享进去；/var/folders/... 那种系统临时目录
  // 不在其中——`-v` 上去不会报错，它会在虚拟机里悄悄建一个同名目录，于是容器写得欢，
  // 宿主机这边一个文件都看不见。实测过一次，别再踩。
  const HOME = fs.mkdtempSync(path.join(os.homedir(), ".wb-deploytest-"));
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
if (!BUILD) done();
