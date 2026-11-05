// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * .git/config 和钩子 agent 改得到，应用自己调 git 时不能被它们带着执行命令。
 *
 *   node test/safe-git.js
 *
 * 每种写法都先用裸 git 跑一遍，确认这招真的会执行（对照组），再验加固后不执行。
 * 没有对照组的话，git 换了行为这里还是绿的。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { mod } = require("./lib/mod");
const HOME = require("./lib/own-home")("safe-git");
const safeGit = require(mod("safe-git"));

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };

if (process.platform === "win32") { console.log("跳过：这里用 sh 脚本当恶意命令"); process.exit(0); }
if (spawnSync("git", ["--version"]).status !== 0) { console.log("跳过：没装 git"); process.exit(0); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-safegit-"));
const marker = path.join(root, "被执行了");
const evil = path.join(root, "evil.sh");
fs.writeFileSync(evil, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 });

function repo(name) {
  const dir = path.join(root, name); fs.mkdirSync(dir);
  const sh = (...a) => spawnSync("git", a, { cwd: dir, stdio: "ignore" });
  sh("init", "-q", "-b", "main"); sh("config", "user.email", "t@t"); sh("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "一\n"); sh("add", "."); sh("commit", "-qm", "第一次");
  fs.writeFileSync(path.join(dir, "a.txt"), "二\n");
  return { dir, sh };
}
const fired = (dir, args, hardened) => {
  fs.rmSync(marker, { force: true });
  const hard = hardened ? safeGit.args(dir) : [];
  spawnSync("git", ["-C", dir, ...hard, ...args], { encoding: "utf8", timeout: 8000 });
  return fs.existsSync(marker);
};

console.log("【1】能执行命令的配置，加固后都不执行");
const cases = [
  ["core.fsmonitor", ["status", "--short"], ({ sh }) => sh("config", "core.fsmonitor", evil)],
  ["filter.clean", ["diff", "--no-ext-diff"], ({ dir, sh }) => { fs.writeFileSync(path.join(dir, ".gitattributes"), "*.txt filter=x\n"); sh("config", "filter.x.clean", evil); }],
  ["diff.external", ["diff"], ({ sh }) => sh("config", "diff.external", evil)],
  ["post-index-change 钩子", ["status", "--short"], ({ dir }) => { fs.writeFileSync(path.join(dir, ".git", "hooks", "post-index-change"), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 }); }],
];
for (const [name, args, plant] of cases) {
  const r = repo(name.replace(/\W/g, "_") + Math.random().toString(36).slice(2, 6)); plant(r);
  const control = fired(r.dir, args, false);
  // fsmonitor 这类要 index 变动才触发，第二次裸跑可能不再触发，所以先判加固、再判对照
  ok(!fired(r.dir, args, true), `${name}：加固后不执行`);
  ok(control, `${name}：对照组确实会执行`);
}

console.log("【2】加固不影响正常结果");
const plain = repo("plain");
const hard = safeGit.args(plain.dir);
const out = spawnSync("git", ["-C", plain.dir, ...hard, "status", "--short"], { encoding: "utf8" }).stdout;
ok(/a\.txt/.test(out), "status 还是看得到改动");
const diff = spawnSync("git", ["-C", plain.dir, ...hard, "diff", "--no-ext-diff"], { encoding: "utf8" }).stdout;
ok(/-一/.test(diff) && /\+二/.test(diff), "diff 内容照常");

console.log("【3】盖不掉的筛选器名字：不跑");
const odd = repo("odd");
odd.sh("config", "filter.a=b.clean", evil);
ok(safeGit.args(odd.dir) === null, "筛选器名字带 = 时返回 null");

console.log("【4】谁都不许裸调");
const src = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
ok(/safeGit\.args\(cwd\)/.test(src("src/agent/worktree.js")), "worktree.js 加固");
ok(/safeGit\.args\(cwd\)/.test(src("src/cli/review.js")), "review.js 加固");
ok(/sandboxedGit\(/.test(src("src/agent/agent.js")) && !/spawnSync/.test(src("src/agent/code-profile.js")), "每轮的 git 快照走沙箱");

(async () => {
  console.log("【5】core.worktree 指到 Key 目录：沙箱里读不到");
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const tools = require(mod("tools"));
  const sec = { sandbox: "required", mode: "full" };
  const probe = repo("probe");
  const normal = await tools.sandboxedGit(probe.dir, ["status", "--short"], { sec, actor: "owner", timeout: 8000 });
  if (normal.status !== 0 && /沙箱/.test(normal.stderr)) { console.log("  跳过：这台机器立不起系统沙箱：" + normal.stderr.slice(0, 80)); return; }
  ok(normal.status === 0 && /a\.txt/.test(normal.stdout), "沙箱里 git 能正常工作");
  const diff = await tools.sandboxedGit(probe.dir, ["diff", "--no-ext-diff", "--no-textconv"], { sec, actor: "owner", timeout: 8000 });
  ok(/\+二/.test(diff.stdout), "沙箱里 diff 内容照常");

  const SECRET = "sk-only-a-test-value";
  fs.writeFileSync(path.join(HOME, "config.json"), `{"api_key":"${SECRET}"}\n`);
  const trap = repo("trap");
  const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: trap.dir, input: "x\n", encoding: "utf8" }).stdout.trim();
  trap.sh("update-index", "--add", "--cacheinfo", `100644,${blob},config.json`);
  trap.sh("config", "core.worktree", HOME);
  const bare = spawnSync("git", ["-C", trap.dir, "diff", "--no-ext-diff"], { encoding: "utf8" }).stdout;
  ok(bare.includes(SECRET), "对照组：沙箱外的 git diff 确实读到了 Key 文件");
  const inBox = await tools.sandboxedGit(trap.dir, ["diff", "--no-ext-diff", "--no-textconv"], { sec, actor: "owner", timeout: 8000 });
  ok(!inBox.stdout.includes(SECRET) && !inBox.stderr.includes(SECRET), "沙箱里的 git diff 读不到");
})().catch((e) => { fail++; console.log("  ✗ 跑挂了：" + (e && e.stack || e)); }).finally(() => {
  fs.rmSync(root, { recursive: true, force: true });
  console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
  process.exit(fail ? 1 : 0);
});
