// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * Linux 系统沙箱（src/platform/sandbox.js 下半截）+ 「成员必须进沙箱」那条线。
 *
 * 跑法：node test/sandbox-linux.js
 * 全是纯函数和接线，任何系统上都能跑；真挂载要 Linux + bubblewrap，这台没有就只跑到这儿。
 * 真容器里的验证（默认 Docker 拒绝执行、放开后 Python 拼路径读不到 Key）记在 docs/安全.md。
 *
 * 为什么单写一份：2026-11 用测试 Key 本地复现：多人服务器上成员一句
 *   python3 -c "print(open('…/'+'config'+'.json').read())"
 * 就能绕过文件黑名单读到 Key——黑名单看的是命令原文，拼一下字符串就过去了。
 * Mac 上内核拦得住，Linux 上当时什么都没套。这里钉住两件事：盖 Key 的规则盖得住，隔离不起来就不跑。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { mod } = require("./lib/mod");
const OWN = require("./lib/own-home")("sandbox-linux");

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } };

const sandbox = require(mod("sandbox"));
const security = require(mod("security"));
const tools = require(mod("tools"));
const { memberMustSandbox } = tools._internals;

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owb-sbl-")));
const data = path.join(root, "home"), app = path.join(root, "app"), ws = path.join(data, "workspace", "org1");
for (const d of [data, app, ws, path.join(data, "data"), path.join(data, "backups"), path.join(data, "plugins"), path.join(data, "other")]) fs.mkdirSync(d, { recursive: true });
for (const f of ["config.json", "config.json.bak", "secrets.env"]) fs.writeFileSync(path.join(data, f), "SECRET");

console.log("【1】挂载顺序就是规则");
const A = sandbox.bwrapArgs({ data, app, writable: [ws], hide: [path.join(data, "other")] });
const at = (flag, p) => { for (let i = 0; i < A.length; i++) if (A[i] === flag && A[i + (flag === "--tmpfs" ? 1 : 2)] === p) return i; return -1; };
const wsAt = at("--bind", ws);
ok(wsAt > 0, "工作区放开了");
ok(at("--tmpfs", path.join(data, "data")) > wsAt, "★data/ 盖在放开工作区之后★ 工作区配进数据根也盖不过它");
ok(at("--tmpfs", path.join(data, "backups")) > wsAt, "backups/ 同上");
for (const f of ["config.json", "config.json.bak", "secrets.env"]) ok(at("--ro-bind", path.join(data, f)) > wsAt, `${f} 换成空设备`);
ok(at("--tmpfs", path.join(data, "other")) > 0, "别家的工作区盖掉");
ok(A.includes("--unshare-pid"), "独立 PID 命名空间：/proc 里读不到服务进程的环境");
ok(A.includes("--die-with-parent"), "服务退出时沙箱里的命令跟着走");
ok(at("--ro-bind", app) > 0, "应用目录只读");
ok(at("--ro-bind", path.join(data, "plugins")) > 0, "plugins/ 只读：服务端会把它当代码加载");

console.log("【2】路径不合法就抛，不许退回不套");
for (const bad of ["", "relative/x", "/"]) {
  let threw = false;
  try { sandbox.bwrapArgs({ data: bad, app, writable: [ws] }); } catch { threw = true; }
  ok(threw, `数据根写成「${bad}」直接抛`);
}

console.log("【3】预检：没装就如实说，不假装立起来了");
sandbox._setBwrap("");
sandbox.preflightLinux({ data, app, writable: [ws] }).then((r) => {
  ok(!r.ok && /bubblewrap/.test(r.reason), "没装 bubblewrap：ok=false，原因说得清");
  sandbox._setBwrap(null);

  console.log("【4】谁必须进沙箱");
  security.setMultiUser(() => true);
  security.setPlatformAdmin((u) => u === "admin");
  {
    ok(memberMustSandbox("alice", {}) === true, "成员：必须");
    ok(memberMustSandbox({ username: "alice" }, { sandbox: "off" }) === true, "★设置写 off 也不算数★ 那是属主给自己定的");
    ok(memberMustSandbox("alice", { sandbox: "auto" }) === true, "设置写 auto 也不算数");
    ok(memberMustSandbox("admin", {}) === false, "平台管理员：照原档位，Key 本来就是他的");
    ok(memberMustSandbox("alice", { allow_member_unsandboxed: true }) === false, "只有写明 allow_member_unsandboxed 才放开");
    ok(memberMustSandbox("", {}) === true, "服务端摸不到账号：按成员算，判错了只是不跑");
    process.env.OWB_ENTRY = "cli";
    ok(memberMustSandbox("", {}) === false, "本机终端：跑在系统用户自己的权限下");
    delete process.env.OWB_ENTRY;
    security.setMultiUser(() => false);
    ok(memberMustSandbox("alice", {}) === false, "一个人用：不走这条线，档位照设置");
  }

  console.log("【5】部署文件");
  const repo = path.join(__dirname, "..");
  ok(/bubblewrap/.test(fs.readFileSync(path.join(repo, "Dockerfile"), "utf8")), "镜像里装了 bubblewrap");
  const compose = fs.readFileSync(path.join(repo, "docker-compose.yml"), "utf8");
  ok(/SYS_ADMIN/.test(compose) && /seccomp=unconfined/.test(compose) && /apparmor=unconfined/.test(compose), "compose 放开了三项，少一项都立不起来");

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\nLinux 沙箱：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
});
