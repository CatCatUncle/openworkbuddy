// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * macOS 系统沙箱（src/platform/sandbox.js）+ run_shell / run_node / 后台命令的接线。
 *
 * 跑法：node test/sandbox.js
 * 全离线：临时数据根、临时 HOME，机密文件里只有占位文字；网络只连本进程在 127.0.0.1 上起的服务。
 * 不是 macOS（或没有 /usr/bin/sandbox-exec）时只跑纯函数那几段。
 * 绝不跑 open / osascript：沙箱万一没立起来，会真在桌面上拉起程序。
 *
 *   【1】纯函数：参数守门（空串、相对路径、根目录、坏端口都 throw）、realpath、档位换算
 *   【2】真套沙箱：机密读写全拒、应用目录只读、工作区照常、自己的端口连不上别的端口照常、
 *        unix socket 只放白名单、主目录自启动文件不许写、信号发不出这棵树、进程组照样收
 *   【3】预检：立起来了才算数；sandbox-exec 找不到时 auto 照跑、required 不跑
 *   【4】接线：run_shell / run_node / 后台命令真走沙箱；关掉就不套；设置页存得进、界面找得到、英文有译文
 *   【5】文件工具和命令闸的固定黑名单：用户把黑名单清空了，Key、账号、账本照样碰不到
 */
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { mod } = require("./lib/mod");
const OWN = require("./lib/own-home")("sandbox");

const FAKE_HOME = path.join(OWN, "home");
fs.mkdirSync(FAKE_HOME, { recursive: true });
process.env.HOME = FAKE_HOME;

const SB = require(mod("sandbox"));

let pass = 0, fail = 0, finished = false;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail).slice(0, 600))); }
};
const section = (t) => console.log("\n" + t);
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
// 没走到最后一行（中途抛了、事件循环空了）也算红：判定器自己会骗人
process.on("exit", () => {
  if (!finished) { console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`); process.exitCode = 1; }
  else if (fail) process.exitCode = 1;
});

const SECRET = "placeholder-secret-for-sandbox-test";

/** 异步跑（不能用 spawnSync：它会把本进程的事件循环冻住，下面那个端口服务就答不了话） */
function run(bin, args, { cwd, env, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const c = spawn(bin, args, { cwd, env: env || { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: FAKE_HOME }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch {} }, timeout);
    c.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
    c.on("error", (e) => { clearTimeout(t); resolve({ code: null, out, err: String(e.message) }); });
  });
}

/** 一个目录下所有文件的内容拼起来（找有没有漏出去的机密用） */
function walkText(dir) {
  let s = "";
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return s; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") s += walkText(p); }
    else if (e.isFile()) { try { s += fs.readFileSync(p, "utf8"); } catch {} }
  }
  return s;
}

/** 【5】这段不靠沙箱，哪个系统上都跑 */
async function coreBlacklist() {
  const T = require(mod("tools"));
  const sec = require(mod("security"));
  const { DATA_DIR } = require(mod("paths"));
  const base = { ...sec.DEFAULTS, permission_mode: "full", gateway: false };
  section("【5】固定黑名单（用户清空了自己的那份也在）");
  const SEC0 = { ...base, gateway: true, permission_mode: "auto", file_blacklist: [] };
  fs.mkdirSync(path.join(DATA_DIR, "data"), { recursive: true });
  for (const f of ["data/orgs.json", "data/vkeys.json", "data/audit.json", "config.json.bak"]) fs.writeFileSync(path.join(DATA_DIR, f), SECRET);
  for (const f of ["data/orgs.json", "data/vkeys.json", "data/audit.json", "config.json", "config.json.bak"]) {
    const rr = await T.executeTool("read_file", { path: path.join(DATA_DIR, f) }, { security: SEC0 });
    ok(rr.isError && !String(rr.content).includes(SECRET) && /黑名单/.test(rr.content), `read_file ${f}：拦`, String(rr.content).slice(0, 160));
  }
  const wr0 = await T.executeTool("write_file", { path: path.join(DATA_DIR, "data", "orgs.json"), content: "{}" }, { security: SEC0 });
  ok(wr0.isError && fs.readFileSync(path.join(DATA_DIR, "data", "orgs.json"), "utf8") === SECRET, "write_file 改 data/orgs.json：拦，文件原样", String(wr0.content).slice(0, 160));
  const cc = sec.checkCommand(SEC0, `cat "${path.join(DATA_DIR, "data", "orgs.json")}"`);
  ok(cc.action !== "allow", "命令里点名 data/orgs.json：不直接放", cc);
  const ca = sec.checkCommand(SEC0, `head "${path.join(DATA_DIR, "data", "audit-2026.jsonl")}"`);
  ok(ca.action !== "allow", "命令里点名 data/audit 开头的文件：不直接放", ca);
  const cu = sec.checkCommand(SEC0, "wc -l ./data/audit_2024.csv");
  ok(!/黑名单/.test(String(cu.reason || "")), "用户自己项目里的 data/audit_2024.csv：不算黑名单", cu);
  const ck = sec.checkCode(SEC0, `require("fs").readFileSync(${JSON.stringify(path.join(DATA_DIR, "data", "vkeys.json"))})`);
  ok(ck.action !== "allow", "run_node 代码里点名 data/vkeys.json：不直接放", ck);

}

(async () => {
  section("【1】纯函数");
  ok(throws(() => SB.wrap("/bin/true", [], { data: "", app: "/tmp" })), "数据根传空串：throw");
  ok(throws(() => SB.wrap("/bin/true", [], { data: "rel/dir", app: "/tmp" })), "数据根传相对路径：throw");
  ok(throws(() => SB.wrap("/bin/true", [], { data: "/", app: "/tmp" })), "数据根传根目录：throw");
  ok(throws(() => SB.wrap("/bin/true", [], { data: "/tmp/..", app: "/tmp" })), "数据根绕回根目录：throw");
  ok(throws(() => SB.wrap("/bin/true", [], { data: "/tmp", app: undefined })), "应用目录没传：throw");
  ok(throws(() => SB.wrap("/bin/true", [], { data: "/tmp", app: "/tmp", ports: [0] })), "端口 0：throw");
  ok(throws(() => SB.wrap("/bin/true", [], { data: "/tmp", app: "/tmp", ports: [1.5] })), "端口不是整数：throw");
  ok(throws(() => SB.wrap("/bin/true", [], { data: "/tmp", app: "/tmp", writable: [""] })), "可写区里混进空串：throw");
  const D0 = path.join(OWN, "d0");
  fs.mkdirSync(D0, { recursive: true });
  const w0 = SB.wrap("/bin/echo", ["hi"], { data: D0 + "/", app: D0 });
  const realD0 = fs.realpathSync.native(D0);
  ok(w0.defs.includes("DATA=" + realD0), "结尾带斜杠的数据根被规范化成真实路径", w0.defs.slice(0, 2));
  ok(realD0 !== D0 || !D0.startsWith("/var/"), "临时目录确实走了 realpath（/var → /private/var）", { D0, realD0 });
  ok(w0.args.slice(-2).join(" ") === "/bin/echo hi", "被包的命令原样接在最后");
  ok(!w0.profile.includes(realD0), "profile 正文里没有路径（全走参数）");
  ok(SB.effectiveMode("", false) === "auto" && SB.effectiveMode("default", false) === "auto", "没设过：一个人按 auto");
  ok(SB.effectiveMode("", true) === "required", "没设过：多人按 required");
  ok(SB.effectiveMode("off", true) === "off" && SB.effectiveMode("auto", true) === "auto", "设过就照设的");
  ok(SB.effectiveMode("乱写", false) === "auto", "乱写的值当没设过");

  // 藏目录：工作区的上级不能整个藏（藏了 cd 不进去），要拆成上级底下的兄弟
  const T0 = SB.real(path.join(OWN, "hide-tree"));
  for (const d of ["a/b/ws/inner", "a/x", "a/b/y", "c"]) fs.mkdirSync(path.join(T0, d), { recursive: true });
  fs.writeFileSync(path.join(T0, "a", "f.txt"), "");
  const keep = path.join(T0, "a", "b", "ws");
  const h1 = SB.hideAround([path.join(T0, "a"), path.join(T0, "c")], keep).sort();
  const want1 = ["a/b/y", "a/f.txt", "a/x", "c"].map((p) => path.join(T0, p)).sort();
  ok(JSON.stringify(h1) === JSON.stringify(want1), "上级拆成兄弟逐个藏，通往工作区那一支和工作区自己都不藏", h1);
  ok(!h1.some((p) => SB.isUnder(keep, p)), "藏的东西里没有工作区的上级");
  ok(SB.hideAround([path.join(keep, "inner"), keep], keep).length === 0, "落在工作区里面的、工作区自己：不藏");
  ok(SB.hideAround([path.join(T0, "c"), path.join(T0, "c")], keep).length === 1, "重复的只留一份");
  const wide = path.join(OWN, "wide", "p");
  // d0 是通往工作区那一支，不算；其余 1001 个正好超上限一个
  for (let i = 0; i <= 1001; i++) fs.mkdirSync(path.join(wide, "d" + i), { recursive: true });
  fs.mkdirSync(path.join(wide, "d0", "ws"), { recursive: true });
  ok(throws(() => SB.hideAround([wide], path.join(wide, "d0", "ws"))), "要藏的超过上限：throw（不悄悄少藏）");
  fs.rmSync(path.join(OWN, "wide"), { recursive: true, force: true });

  // Windows 那层另有一套（test/sandbox-win.js）：这里只验 macOS 的 sandbox-exec
  if (process.platform !== "darwin" || !SB.supported()) {
    console.log(`\n（这台机器${process.platform === "darwin" ? "没有 sandbox-exec" : "不是 macOS"}，【2】到【4】跳过）`);
    await coreBlacklist();
    finished = true;
    console.log(`\n${fail ? "有挂的" : "全部通过"}：${pass} 过 / ${fail} 挂`);
    return;
  }

  section("【2】真套沙箱");
  const DATA = path.join(OWN, "数据 根");      // 带空格和中文：路径走参数，不用转义
  const APP = path.join(OWN, "app");
  const WS = path.join(DATA, "workspace");
  for (const d of [path.join(DATA, "data"), path.join(DATA, "backups"), path.join(DATA, "plugins"), WS, APP, path.join(FAKE_HOME, "Library", "LaunchAgents")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(DATA, "config.json"), SECRET);
  fs.writeFileSync(path.join(DATA, "config.json.bak"), SECRET);
  fs.writeFileSync(path.join(DATA, "data", "orgs.json"), SECRET);
  fs.writeFileSync(path.join(DATA, "backups", "b1.json"), SECRET);
  fs.writeFileSync(path.join(DATA, "secrets.json"), SECRET);
  fs.writeFileSync(path.join(APP, "server.js"), "// app\n");
  fs.writeFileSync(path.join(WS, "note.txt"), "工作区里的东西");
  fs.symlinkSync(path.join(DATA, "config.json"), path.join(WS, "link-to-config"));

  // 本进程起一个服务当「OWB 自己的端口」，再起一个当「别的服务」
  const srv = (tag) => new Promise((resolve) => { const s = net.createServer((c) => c.end(tag)); s.listen(0, "127.0.0.1", () => resolve(s)); });
  const own = await srv("OWN-PORT-REACHED"), other = await srv("OTHER-PORT-REACHED");
  // unix socket：一个在白名单里，一个不在
  const sockIn = path.join(OWN, "in.sock"), sockOut = path.join(OWN, "out.sock");
  const usrv = (p, tag) => new Promise((resolve) => { const s = net.createServer((c) => c.end(tag)); s.listen(p, () => resolve(s)); });
  const uIn = await usrv(sockIn, "UNIX-IN"), uOut = await usrv(sockOut, "UNIX-OUT");

  const O = { data: DATA, app: APP, home: FAKE_HOME, ports: [own.address().port], writable: [WS], unixAllow: [sockIn] };
  const sb = (bin, args) => { const w = SB.wrap(bin, args, O); return run(w.bin, w.args, { cwd: WS }); };
  const sh = (cmd) => sb("/bin/sh", ["-c", cmd]);
  const denied = (r) => r.code !== 0 && !r.out.includes(SECRET) && /Operation not permitted/.test(r.err + r.out);

  ok(denied(await sh(`cat "${DATA}/config.json"`)), "读 config.json：拒");
  ok(denied(await sh(`cat "${DATA}/config.json.bak"`)), "读 config.json 的备份：拒");
  ok(denied(await sh(`cat "${DATA}/data/orgs.json"`)), "读 data/ 下的账户和额度：拒");
  ok(denied(await sh(`cat "${DATA}/backups/b1.json"`)), "读 backups/：拒");
  ok(denied(await sh(`cat "${DATA}/secrets.json"`)), "读 secrets*：拒");
  ok(denied(await sh(`cat ../config.json`)), "从工作区用相对路径读：拒");
  ok(denied(await sh(`cat link-to-config`)), "经工作区里的软链读：拒");
  const nodeRead = await sb(process.execPath, ["-e", `process.stdout.write(require("fs").readFileSync(${JSON.stringify(path.join(DATA, "config.json"))}, "utf8"))`]);
  ok(nodeRead.code !== 0 && !nodeRead.out.includes(SECRET), "node 脚本读：拒", nodeRead.err.slice(0, 200));
  ok(denied(await sh(`ls "${DATA}/data"`)), "列 data/ 目录：拒");
  ok(denied(await sh(`echo x > "${DATA}/data/orgs.json"`)) && fs.readFileSync(path.join(DATA, "data", "orgs.json"), "utf8") === SECRET, "改 data/ 下的文件：拒，文件原样");
  ok(denied(await sh(`echo x > "${APP}/server.js"`)) && fs.readFileSync(path.join(APP, "server.js"), "utf8") === "// app\n", "改应用目录：拒，文件原样");
  ok(denied(await sh(`echo x > "${DATA}/plugins/p.js"`)) && !fs.existsSync(path.join(DATA, "plugins", "p.js")), "往 plugins/ 写：拒");
  ok(denied(await sh(`mv "${DATA}" "${DATA}-moved"`)) && fs.existsSync(DATA), "给数据根改名：拒");
  ok(denied(await sh(`echo x >> "${FAKE_HOME}/.zshrc"`)) && !fs.existsSync(path.join(FAKE_HOME, ".zshrc")), "写主目录的 .zshrc：拒");
  ok(denied(await sh(`echo x > "${FAKE_HOME}/Library/LaunchAgents/a.plist"`)), "写登录项目录：拒");

  const wr = await sh(`cat note.txt && echo 新内容 > out.txt && mkdir -p sub && echo y > sub/y.txt && cat out.txt`);
  ok(wr.code === 0 && wr.out.includes("工作区里的东西") && wr.out.includes("新内容"), "工作区照常读写", wr);
  ok((await sh(`echo ok > "${FAKE_HOME}/plain.txt"`)).code === 0, "主目录里普通文件照常能写");
  ok((await sh(`echo ok > "${OWN}/beside-data.txt"`)).code === 0, "数据根的上级目录里照常能建文件（只拦改名删掉它自己）");
  ok((await sh(`cat "${APP}/server.js"`)).out.includes("// app"), "应用目录照常能读");
  const nodeOk = await sb(process.execPath, ["-e", "console.log(1+1)"]);
  ok(nodeOk.code === 0 && nodeOk.out.trim() === "2", "node 照常跑", nodeOk);

  const connect = (port) => `const s=require("net").connect(${port},process.argv[1]);s.on("data",d=>process.stdout.write(d));s.on("error",e=>{process.stdout.write("ERR "+e.code);process.exitCode=3})`;
  for (const host of ["127.0.0.1", "localhost", "::ffff:127.0.0.1"]) {
    const r = await sb(process.execPath, ["-e", connect(own.address().port), host]);
    ok(!r.out.includes("OWN-PORT-REACHED"), `连自己的端口（${host}）：拒`, r);
  }
  const ro = await sb(process.execPath, ["-e", connect(other.address().port), "127.0.0.1"]);
  ok(ro.out.includes("OTHER-PORT-REACHED"), "别的本机端口照常能连", ro);
  const ucon = (p) => `const s=require("net").connect(${JSON.stringify(p)});s.on("data",d=>process.stdout.write(d));s.on("error",e=>{process.stdout.write("ERR "+e.code);process.exitCode=3})`;
  const ui = await sb(process.execPath, ["-e", ucon(sockIn)]);
  ok(ui.out.includes("UNIX-IN"), "白名单里的 unix socket 能连", ui);
  const uo = await sb(process.execPath, ["-e", ucon(sockOut)]);
  ok(!uo.out.includes("UNIX-OUT"), "名单外的 unix socket：拒", uo);

  // 多组织：别家的工作区藏起来，自己的工作区照常进得去
  const TEN = path.join(OWN, "tenants");
  const WS2 = path.join(TEN, "t1", "ws");
  fs.mkdirSync(WS2, { recursive: true });
  fs.mkdirSync(path.join(TEN, "t2"), { recursive: true });
  fs.writeFileSync(path.join(TEN, "t2", "secret.txt"), SECRET);
  const O2 = { ...O, writable: [WS2], hide: SB.hideAround([TEN], WS2) };
  const w2 = SB.wrap("/bin/sh", ["-c", `cd "${WS2}" && /bin/pwd -P && echo 写得进 > mine.txt && cat mine.txt`], O2);
  const r2 = await run(w2.bin, w2.args, { cwd: OWN });
  ok(r2.code === 0 && r2.out.includes(SB.real(WS2)) && r2.out.includes("写得进"), "上级被拆开藏：cd 进自己的工作区、读写照常", r2);
  const w3 = SB.wrap("/bin/sh", ["-c", `cat "${path.join(TEN, "t2", "secret.txt")}"; ls "${TEN}"`], O2);
  const r3 = await run(w3.bin, w3.args, { cwd: WS2 });
  ok(!r3.out.includes(SECRET) && /Operation not permitted/.test(r3.err), "别家组织的文件：读不到", r3);

  // 沙箱外的进程：发不了信号
  const outside = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  const sig = await sh(`kill -0 ${outside.pid}`);
  ok(sig.code !== 0, "给沙箱外的进程发信号：拒", sig);
  try { process.kill(outside.pid, "SIGKILL"); } catch {}

  // 进程组照样整组收：sandbox-exec 是 exec 过去的，pid 就是命令本身
  const w = SB.wrap("/bin/sh", ["-c", "sleep 30 & sleep 30 & wait"], O);
  const grp = spawn(w.bin, w.args, { cwd: WS, detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
  await new Promise((r) => setTimeout(r, 400));
  const comm = await run("/bin/ps", ["-o", "comm=", "-p", String(grp.pid)]);
  ok(/(^|\/)sh\s*$/.test(comm.out.trim()), "子进程的 pid 就是被包的命令（没多一层）", comm.out);
  // macOS 的 ps 没有按进程组筛的开关：全列出来自己按 pgid 数
  const members = async () => (await run("/bin/ps", ["-A", "-o", "pid=,pgid="])).out.split("\n")
    .map((l) => l.trim().split(/\s+/)).filter((c) => c.length === 2 && c[1] === String(grp.pid)).length;
  ok((await members()) >= 3, "组里有 sh 和两个 sleep");
  process.kill(-grp.pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  ok((await members()) === 0, "按进程组一枪全收");

  section("【3】预检");
  const pf = await SB.preflight(O);
  ok(pf.ok === true, "临时数据根上预检通过", pf);
  ok(fs.existsSync(path.join(DATA, "data", "sandbox-canary")), "金丝雀文件建在 data/ 里");
  ok(SB.preflight(O) === SB.preflight(O), "同样的参数只预检一次（缓存）");
  fs.linkSync(path.join(DATA, "config.json"), path.join(OWN, "hard-link"));
  SB.resetPreflight();
  const pf2 = await SB.preflight(O);
  ok(pf2.ok && pf2.warn.includes("config.json"), "config.json 在别处有硬链接：提醒出来", pf2);
  fs.rmSync(path.join(OWN, "hard-link"));
  SB.resetPreflight();
  const pf3 = await SB.preflight({ ...O, data: "" });
  ok(pf3.ok === false && /绝对路径/.test(pf3.reason), "参数不对：预检不通过，原因照实说", pf3);

  for (const s of [own, other, uIn, uOut]) s.close();

  section("【4】接线");
  const T = require(mod("tools"));
  const sec = require(mod("security"));
  const { DATA_DIR } = require(mod("paths"));
  fs.writeFileSync(path.join(DATA_DIR, "config.json"), SECRET);
  const base = { ...sec.DEFAULTS, permission_mode: "full", gateway: false };
  const shell = (command, s) => T.executeTool("run_shell", { command }, { security: { ...base, ...s } });
  const node = (code, s) => T.executeTool("run_node", { code }, { security: { ...base, ...s } });
  const cfgPath = path.join(DATA_DIR, "config.json");
  let r = await shell(`cat "${cfgPath}"`, { sandbox: "auto" });
  ok(r.isError && !r.content.includes(SECRET) && /Operation not permitted/.test(r.content), "run_shell 读 config.json：被沙箱拒", r.content.slice(0, 300));
  r = await node(`console.log(require("fs").readFileSync(${JSON.stringify(cfgPath)}, "utf8"))`, { sandbox: "auto" });
  ok(r.isError && !r.content.includes(SECRET), "run_node 读 config.json：被沙箱拒", r.content.slice(0, 300));
  r = await shell("echo 正常命令", { sandbox: "auto" });
  ok(!r.isError && r.content.includes("正常命令"), "正常命令照常跑", r.content.slice(0, 300));
  r = await node("console.log(6*7)", { sandbox: "auto" });
  ok(!r.isError && r.content.includes("42"), "正常脚本照常跑", r.content.slice(0, 300));
  r = await shell(`cat "${cfgPath}" > leak.txt; echo done`, { sandbox: "auto" });
  const leak = path.join(DATA_DIR, "workspace");
  ok(!/placeholder-secret/.test(walkText(leak)), "重定向进工作区的文件里也没有机密", r.content.slice(0, 200));
  const bgOut = await T.executeTool("run_shell", { command: `cat "${cfgPath}"; echo bg-done`, background: true }, { security: { ...base, sandbox: "auto" }, sessionId: "sbx" });
  const id = (/(bg\d+)/.exec(bgOut.content) || [])[1];
  let seen = "";
  for (let i = 0; i < 50 && !/bg-done/.test(seen); i++) { await new Promise((res) => setTimeout(res, 100)); seen += (await T.executeTool("shell_output", { id }, { sessionId: "sbx" })).content; }
  ok(id && /bg-done/.test(seen) && !seen.includes(SECRET), "后台命令读 config.json：也被拒", seen.slice(0, 300));
  r = await shell(`cat "${cfgPath}"`, { sandbox: "off" });
  ok(r.content.includes(SECRET), "★对照★ 关掉沙箱：读得到（证明上面那几条是沙箱拦的）");
  ok((T.sandboxStatus() || {}).ok === false && /已关闭/.test(T.sandboxStatus().reason), "关掉时设置页看到「已关闭」", T.sandboxStatus());

  // sandbox-exec 找不到：auto 照跑，required 不跑
  SB._setBin(path.join(OWN, "no-such-sandbox-exec"));
  r = await shell("echo 照跑", { sandbox: "auto" });
  ok(!r.isError && r.content.includes("照跑"), "auto 档：沙箱立不起来照常跑", r.content.slice(0, 300));
  ok(T.sandboxStatus().ok === false && /找不到/.test(T.sandboxStatus().reason), "……原因记下来，设置页看得到", T.sandboxStatus());
  r = await shell("echo 不该跑", { sandbox: "required" });
  ok(r.isError && !r.content.includes("stdout") && /没有执行/.test(r.content), "required 档：立不起来就不跑", r.content.slice(0, 300));
  r = await node("console.log('不该跑')", { sandbox: "required" });
  ok(r.isError && /没有执行/.test(r.content), "required 档：run_node 也不跑", r.content.slice(0, 300));
  SB._setBin(null);

  const src = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const server = require("./lib/src").src("server");
  ok(/sandbox/.test(server) && /sandbox_status/.test(server), "设置接口带上沙箱档位和现状");
  const uiSrc = src("public/js/app-06.js");
  ok(uiSrc.includes('id="sec-sbx"') && /sandbox:\s*pane\.querySelector\("#sec-sbx"\)/.test(uiSrc), "设置页有档位下拉，保存时带上");
  const i18n = src("public/js/i18n.js");
  ok(i18n.includes('"系统沙箱"'), "英文有译文");


  await coreBlacklist();
  finished = true;
  console.log(`\n${fail ? "有挂的" : "全部通过"}：${pass} 过 / ${fail} 挂`);
})().catch((e) => { fail++; console.error(e); process.exitCode = 1; });
