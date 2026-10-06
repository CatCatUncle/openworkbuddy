// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * AI 跑的命令和脚本（run_shell / run_node / 后台命令）在 macOS 上套一层 sandbox-exec。
 *
 * 为什么要这一层：文件工具有黑名单、命令有审批，可一条命令能换出无数种写法，
 * 靠看命令原文判断它会不会去读 config.json 是判不完的。sandbox-exec 由系统内核按真实路径拦，
 * 不管命令怎么写，读 Key 和账户数据、改应用自己的文件、连 OpenWorkBuddy 自己的端口，都只会拿到 EPERM。
 *
 * 只做黑名单（allow default + 若干 deny）：工作区、装依赖、联网、git 照常。代价是每次起进程多约 7ms。
 *
 * 写法上的几个硬前提（踩过才知道）：
 * - 路径一律先 realpath（/tmp 实际是 /private/tmp）；Seatbelt 按真实路径比，不 realpath 等于没拦。
 * - 空串、相对路径、根目录不许进 profile：它们照样能编译，但什么也拦不住。wrap 里直接 throw，
 *   调用方不许接住后改成不套沙箱跑。
 * - 端口写 "*:端口"，不写 "localhost:端口"（后者漏 IPv4 映射的 IPv6 地址）。
 * - 路径都走 -D 参数传，profile 正文里不拼路径：中文、空格、引号都不用转义。
 * - Seatbelt 是最后命中的规则说了算，下面 profileText 里的顺序不能随便挪。
 *
 * 它只管这一棵进程树，不是全部防线：OWB 自己的接口照样要鉴权，Key 照样不放进任何进程的启动环境（见 child-env.js）。
 * 沙箱不能套娃：自带沙箱的程序（codex 的工具命令、Chromium 的渲染进程）在里面起不来，所以外部引擎先不包。
 * 只在 macOS 上有。别的系统档位再怎么设都是不套。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const DEFAULT_BIN = "/usr/bin/sandbox-exec";
let SANDBOX_EXEC = DEFAULT_BIN;
const MDNS = "/private/var/run/mDNSResponder";
const MODES = ["auto", "required", "off"];

/** realpath；路径还不存在时把存在的那段 realpath 掉再拼回去 @param {string} p @returns {string} */
function real(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    const d = path.dirname(abs);
    return d === abs ? abs : path.join(real(d), path.basename(abs));
  }
}

/** p 的所有祖先（不含 p 自己，不含 "/"） @param {string} p */
function ancestors(p) {
  const out = [];
  for (let c = path.dirname(p); c !== path.dirname(c); c = path.dirname(c)) out.push(c);
  return out;
}

/** @param {string} prefix @param {number} n @param {(p: string) => string} f */
const many = (prefix, n, f) => Array.from({ length: n }, (_, i) => f(`(param "${prefix}${i}")`)).join(" ");

/** 沙箱外的程序以后会自己执行的文件：登录项、shell 启动文件、git/npm 全局配置。写进去就等于在沙箱外跑 */
const PERSIST_SUBPATHS = ["/Library/LaunchAgents", "/.ssh", "/.config/git", "/.oh-my-zsh/custom"];
const PERSIST_FILES = ["/.zshrc", "/.zshenv", "/.zprofile", "/.zlogin", "/.zlogout", "/.bashrc", "/.bash_profile", "/.bash_login", "/.profile", "/.gitconfig", "/.npmrc", "/.curlrc", "/.wgetrc"];

/**
 * profile 正文。只有「几项」会改变正文，路径全在参数里。
 * @param {{ anc: number, writable: number, hide?: number, unix?: number, ports?: number, home?: boolean, hardened?: boolean }} n
 */
function profileText({ anc, writable, hide = 0, unix = 0, ports = 0, home = false, hardened = true }) {
  const L = [
    "(version 1)",
    "(allow default)",
    '(define DATA (param "DATA"))',
    '(define APP (param "APP"))',
    "(define (in-data rel) (string-append DATA rel))",
    ";; 应用目录 + 服务端会当代码加载的 plugins/：只读",
    '(deny file-write* (subpath APP) (subpath (in-data "/plugins")))',
  ];
  if (hide) L.push(";; 别家组织的工作区、属主的工作区：读写都拒", `(deny file-read* file-write* ${many("H", hide, (p) => `(subpath ${p})`)})`);
  // 开发态数据根就是应用目录，工作区在里面：上面那条只读把它也盖住了，这里放回来
  if (writable) L.push(";; 这一趟的工作区", `(allow file-read* file-write* ${many("W", writable, (p) => `(subpath ${p})`)})`);
  L.push(
    ";; Key、账号、额度、备份：读写都拒。排在放开之后，谁也盖不过它",
    "(deny file-read* file-write*",
    '  (prefix (in-data "/config.json"))',
    '  (subpath (in-data "/data"))',
    '  (subpath (in-data "/backups"))',
    '  (prefix (in-data "/secrets")))',
    ";; 数据根、应用目录和它们的上级不许改名、删掉（改个名上面的规则就落空了）",
    `(deny file-write* (literal DATA) (literal APP) ${many("ANC", anc, (p) => `(literal ${p})`)})`,
  );
  if (home) {
    L.push(
      ";; 用户主目录里沙箱外会自动执行的文件：不许写",
      '(define UHOME (param "UHOME"))',
      `(deny file-write* ${PERSIST_SUBPATHS.map((p) => `(subpath (string-append UHOME "${p}"))`).join(" ")} ${PERSIST_FILES.map((p) => `(literal (string-append UHOME "${p}"))`).join(" ")})`,
    );
  }
  if (ports) L.push(";; OpenWorkBuddy 自己的端口", `(deny network-outbound ${many("P", ports, (p) => `(remote ip (string-append "*:" ${p}))`)})`);
  L.push(
    ";; open / osascript 拉起的程序由系统生出来，不在沙箱里",
    "(deny lsopen)",
    '(deny mach-lookup (global-name "com.apple.coreservices.appleevents"))',
    ";; 信号只发给自己这棵进程树",
    "(deny signal)",
    "(allow signal (target same-sandbox))",
  );
  if (hardened) {
    L.push(
      ";; 沙箱外的服务（docker、tmux、ssh-agent…）会替它干活：unix socket 只放 DNS 和白名单",
      "(deny network-outbound (remote unix-socket))",
      `(allow network-outbound (remote unix-socket (path-literal "${MDNS}")) ${many("U", unix, (p) => `(remote unix-socket (path-literal ${p}))`)})`,
    );
  }
  return L.join("\n") + "\n";
}

/**
 * 先验原始输入再 realpath：空串、相对路径经 path.resolve 会悄悄变成本进程的 cwd，规则就落到别处去了。
 * @param {unknown} p @param {string} name
 */
function absReal(p, name) {
  if (typeof p !== "string" || !p || !path.isAbsolute(p) || p.includes("\0")) throw new Error(`沙箱参数 ${name} 必须是绝对路径：${JSON.stringify(p)}`);
  const r = real(p);
  if (r === "/") throw new Error(`沙箱参数 ${name} 不能是根目录：${JSON.stringify(p)}`);
  return r;
}

/** a 是 b 自己或在 b 底下（两边都已 realpath） @param {string} a @param {string} b */
const isUnder = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);

/** 一趟命令最多藏这么多处，再多 profile 就太长了：宁可报错不套，也不悄悄少藏 */
const HIDE_MAX = 1000;

/**
 * 要藏的目录里有工作区的上级时，不能整个藏：Seatbelt 下上级读不了，cd 进工作区、取当前目录都会失败。
 * 换成把它底下通往工作区那一支以外的东西逐个藏起来，一层层往下拆到工作区为止。
 * 落在工作区里面的不用藏（后面放开工作区那条会盖过它）。这一层的新目录下一次起命令时会重新列到。
 * @param {string[]} hide @param {string} keep
 */
function hideAround(hide, keep) {
  const K = real(keep);
  /** @type {string[]} */
  const out = [];
  /** @param {string} h */
  const walk = (h) => {
    if (isUnder(h, K)) return;
    if (!isUnder(K, h)) { out.push(h); return; }
    let names = [];
    try { names = fs.readdirSync(h); } catch {}
    const next = K.slice(h.length).split(path.sep).filter(Boolean)[0];
    for (const n of names) if (n !== next) out.push(path.join(h, n));
    walk(path.join(h, next));
  };
  for (const h of hide) walk(real(h));
  const uniq = [...new Set(out)];
  if (uniq.length > HIDE_MAX) throw new Error(`要藏的目录太多（${uniq.length} 处），沙箱没法写`);
  return uniq;
}

/**
 * @typedef {{ data: string, app: string, home?: string|null, ports?: number[], writable?: string[], hide?: string[], unixAllow?: string[], hardened?: boolean }} WrapOpts
 */

/**
 * 把一次 spawn 包进沙箱。返回的 bin/args 直接喂给 spawn；cwd/env/detached/stdio 原样不变
 * （sandbox-exec 是 exec 过去的，不多一层进程，按进程组收照常）。
 * @param {string} bin @param {string[]} args @param {WrapOpts} o
 * @returns {{ bin: string, args: string[], profile: string, defs: string[] }}
 */
function wrap(bin, args, { data, app, home = null, ports = [], writable = [], hide = [], unixAllow = [], hardened = true }) {
  const D = absReal(data, "DATA");
  const A = absReal(app, "APP");
  const W = writable.map((p) => absReal(p, "writable"));
  const H = hide.map((p) => absReal(p, "hide"));
  const U = unixAllow.map((p) => absReal(p, "unixAllow"));
  const UH = home != null ? absReal(home, "home") : null;
  for (const p of ports) if (!(Number.isInteger(p) && p > 0 && p < 65536)) throw new Error(`沙箱参数 端口 不对：${p}`);
  const P = [...new Set(ports)];
  const anc = [...new Set([...ancestors(D), ...ancestors(A), ...H, ...H.flatMap(ancestors)])];
  const profile = profileText({ anc: anc.length, writable: W.length, hide: H.length, unix: U.length, ports: P.length, home: UH != null, hardened });
  const defs = [
    `DATA=${D}`,
    `APP=${A}`,
    ...anc.map((p, i) => `ANC${i}=${p}`),
    ...W.map((p, i) => `W${i}=${p}`),
    ...H.map((p, i) => `H${i}=${p}`),
    ...U.map((p, i) => `U${i}=${p}`),
    ...(UH != null ? [`UHOME=${UH}`] : []),
    ...P.map((p, i) => `P${i}=${p}`),
  ];
  return { bin: SANDBOX_EXEC, args: ["-p", profile, ...defs.flatMap((d) => ["-D", d]), bin, ...args], profile, defs };
}

/** 这台机器能不能套 @param {string} [platform] */
function supported(platform = process.platform) {
  return platform === "darwin" && fs.existsSync(SANDBOX_EXEC);
}

/**
 * 设置里的档位 → 实际档位。没设过（"default"）：多人部署按 required，一个人的桌面按 auto。
 * @param {unknown} v @param {boolean} multi
 * @returns {"auto"|"required"|"off"}
 */
function effectiveMode(v, multi) {
  const s = String(v || "").trim();
  if (s === "auto" || s === "required" || s === "off") return s;
  return multi ? "required" : "auto";
}

/**
 * 跑一个包好的命令，收退出码和 stderr 头一行。只给预检用，输出不留
 * @param {{ bin: string, args: string[] }} w @returns {Promise<{ code: number|null, err: string, spawnError?: string }>}
 */
function probe(w) {
  return new Promise((resolve) => {
    let err = "";
    let c;
    try {
      c = spawn(w.bin, w.args, { stdio: ["ignore", "ignore", "pipe"], env: { PATH: "/usr/bin:/bin" }, windowsHide: true });
    } catch (e) {
      resolve({ code: null, err: "", spawnError: String((e && /** @type {any} */ (e).message) || e) });
      return;
    }
    const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch {} }, 5000);
    c.stderr.on("data", (d) => { if (err.length < 2000) err += d; });
    c.on("error", (e) => { clearTimeout(t); resolve({ code: null, err, spawnError: e.message }); });
    c.on("close", (code) => { clearTimeout(t); resolve({ code, err }); });
  });
}

const firstLine = (s) => String(s || "").trim().split("\n")[0].slice(0, 200);

/** @type {Map<string, Promise<{ ok: boolean, reason: string, warn: string[] }>>} */
const preflights = new Map();

/**
 * 预检：同一份 profile 先跑一个什么都不干的命令（必须成功），再去读数据目录里的金丝雀文件（必须被拒）。
 * 两条都对上才算立起来了——这样「沙箱没立起来」和「命令自己失败」才分得开。
 * 按 profile 正文 + 参数缓存，DATA/APP/端口一变就重做
 * @param {WrapOpts} o
 */
function preflight(o) {
  let w0, w1;
  const canary = path.join(o.data, "data", "sandbox-canary");
  try {
    w0 = wrap("/usr/bin/true", [], o);
    w1 = wrap("/bin/cat", [canary], o);
  } catch (e) {
    return Promise.resolve({ ok: false, reason: String((e && /** @type {any} */ (e).message) || e), warn: [] });
  }
  if (!fs.existsSync(SANDBOX_EXEC)) return Promise.resolve({ ok: false, reason: `找不到 ${SANDBOX_EXEC}`, warn: [] });
  const key = crypto.createHash("sha256").update(w0.profile + "\0" + w0.defs.join("\0")).digest("hex");
  const hit = preflights.get(key);
  if (hit) return hit;
  const p = (async () => {
    try {
      fs.mkdirSync(path.dirname(canary), { recursive: true });
      fs.writeFileSync(canary, "sandbox canary\n");
    } catch (e) {
      return { ok: false, reason: `写不了金丝雀文件 ${canary}：${/** @type {any} */ (e).code || e}`, warn: [] };
    }
    const a = await probe(w0);
    if (a.spawnError) return { ok: false, reason: `sandbox-exec 起不来：${a.spawnError}`, warn: [] };
    if (a.code !== 0) return { ok: false, reason: `空命令退出码 ${a.code}：${firstLine(a.err)}`, warn: [] };
    const b = await probe(w1);
    if (b.code === 0) return { ok: false, reason: "金丝雀文件读到了，规则没生效", warn: [] };
    if (!/Operation not permitted/.test(b.err)) return { ok: false, reason: `读金丝雀退出码 ${b.code}：${firstLine(b.err)}`, warn: [] };
    return { ok: true, reason: "", warn: linkWarnings(o.data) };
  })();
  preflights.set(key, p);
  return p;
}

/**
 * 机密文件的链接数多于 1 就提醒用户看一眼（只提醒，不拦）
 * @param {string} data
 */
function linkWarnings(data) {
  const out = [];
  const look = (f) => {
    try {
      const st = fs.lstatSync(f);
      if (st.isFile() && st.nlink > 1) out.push(path.relative(data, f));
    } catch {}
  };
  look(path.join(data, "config.json"));
  try {
    for (const e of fs.readdirSync(path.join(data, "data"), { withFileTypes: true })) if (e.isFile()) look(path.join(data, "data", e.name));
  } catch {}
  return out;
}

/** 测试用：清掉预检缓存 */
function resetPreflight() { preflights.clear(); }

/** 测试用：换一个 sandbox-exec 路径（传空复原），好模拟「这台机器上没有」 @param {string|null} p */
function _setBin(p) {
  SANDBOX_EXEC = p || DEFAULT_BIN;
  preflights.clear();
}

module.exports = {
  get SANDBOX_EXEC() { return SANDBOX_EXEC; },
  MODES, real, ancestors, isUnder, hideAround, profileText, absReal, wrap, supported, effectiveMode, preflight, resetPreflight, _setBin,
};
