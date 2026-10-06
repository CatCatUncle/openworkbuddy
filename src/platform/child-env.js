// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 子进程只拿最小环境变量。
 *
 * 以前 run_shell / run_node / 后台命令 / MCP / 外部引擎起子进程，都是 `{ ...process.env, ... }` 整份往下传。
 * 用户自己 shell 里 export 过的 OPENAI_API_KEY、ANTHROPIC_API_KEY，Docker 里给渠道配的
 * OPENWORKBUDDY_KEY_<渠道id>，AI 一条 printenv 就全看见了——看见了就能绕过模型白名单和企业限额，
 * 拿这把 Key 直连厂商，账上一笔都不记。
 *
 * 现在反过来：先按白名单挑（系统运行、找命令、联网、定位技能必需的那些），
 * 再拿「名字像 Key」的正则兜一道底——白名单前缀里混进来的、属主清单里写了的，只要像 Key 都先拦下。
 *
 * 属主可以在 设置 → 安全中心 配一份「允许透传的变量名」清单（config.security.env_passthrough）：
 *   · 普通名字（JAVA_HOME、HF_ENDPOINT 这种）写了就给。
 *   · 像 Key 的名字只有在这台机器只有一个账号时才给——那时候跑命令的就是属主自己。
 *     账号一多，成员的任务也在这台机器上跑，写进清单也不给：企业部署不许走「环境变量 Key」这条路，
 *     要用 Key 去 设置 → 模型 里配，那条路有白名单、有计量。
 *
 * 清单和「几个账号」都在上层（config、账号库），这一层够不着：server.js / cli.js 起来时用 setPolicy 注册一次，
 * 每次起子进程现问。没注册过（单测、独立脚本）= 清单为空、Key 一律不给——忘了接线时是收紧，不是放开。
 *
 * 管不到的（照实写）：AI 直接读 config.json、读别的进程的环境——那是文件黑名单和沙箱（K2）的事。
 */

/** 系统运行、找命令、联网、定位工具链要用的。全大写比（Windows 上环境变量名不分大小写，Path 和 PATH 是同一个） */
const BASE = new Set([
  // 通用
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TMPDIR", "TMP", "TEMP", "TZ",
  "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "NO_COLOR", "FORCE_COLOR",
  // macOS：没有它 pbcopy / pbpaste 按 MacRoman 读写，中文成乱码
  "__CF_USER_TEXT_ENCODING",
  // Windows：少了 SystemRoot / ComSpec / PATHEXT，连 cmd 和 node 的网络模块都起不来
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "USERNAME", "USERDOMAIN", "COMPUTERNAME",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
  "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432", "PUBLIC", "ALLUSERSPROFILE",
  "HOMEDRIVE", "HOMEPATH", "OS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "NUMBER_OF_PROCESSORS", "PSMODULEPATH",
  // 联网：代理和公司内网的根证书。少了它们，引擎 CLI 和装依赖在国内、在公司网里直接连不上
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  // 工具链定位：只是目录，不是凭证
  "NODE_PATH", "JAVA_HOME", "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME", "PYENV_ROOT", "NVM_DIR", "PNPM_HOME",
  "VIRTUAL_ENV", "CONDA_PREFIX", "PYTHONPATH", "PYTHONHOME", "PYTHONUTF8", "PYTHONIOENCODING",
]);
/**
 * 整族放行的前缀。OPENWORKBUDDY_*：技能和引擎桥靠 OPENWORKBUDDY_HOME、OPENWORKBUDDY_BRIDGE_* 找数据根；
 * npm_config_*：装依赖护栏（deps-guard）和镜像源设置都在这一族里。族里像 Key 的照样被 KEY_LIKE 拦
 */
const BASE_PREFIX = /^(LC_|XDG_|OPENWORKBUDDY_|NPM_CONFIG_)/i;
/** 只在一个账号时给：ssh-agent 的套接字能拿属主的 ssh 身份去推代码，成员的任务不该摸到 */
const SOLO_ONLY = new Set(["SSH_AUTH_SOCK"]);
/**
 * 名字像 Key。比设计稿那条（_API_KEY / _SECRET / _TOKEN / _PASSWORD 结尾）放宽了一圈：
 * OPENAI_KEY、AWS_SECRET_ACCESS_KEY、npm_config__authToken 这些常见写法也算
 */
const KEY_LIKE = /(^|_)(API_?KEY|KEY|AUTH)$|^OPENWORKBUDDY_KEY_|APIKEY|SECRET|TOKEN|PASSW|CREDENTIAL/i;
/** 变量名合不合法：字母数字下划线，不以数字开头。带括号的 Windows 系统变量已经在 BASE 里，不用往清单里写 */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_NAMES = 50;

/** @typedef {{ allow?: string[], keys?: boolean }} EnvPolicy */
/** @type {null | (() => EnvPolicy | null | undefined)} */
let policyOf = null;
/**
 * 上层注册「属主清单」和「Key 类能不能放」从哪儿读。每次起子进程现问，设置页改了不用重启。
 * @param {null | (() => EnvPolicy | null | undefined)} fn
 */
function setPolicy(fn) {
  policyOf = typeof fn === "function" ? fn : null;
}
/** @returns {EnvPolicy} 读不到、读挂了都当空策略（收紧） */
function currentPolicy() {
  try {
    const p = policyOf && policyOf();
    return p && typeof p === "object" ? p : {};
  } catch { return {}; }
}

/** @param {string} name */
function keyLike(name) {
  return KEY_LIKE.test(String(name || ""));
}

/**
 * 属主清单洗一遍：去空白、去重（不分大小写）、丢掉不合法的名字，最多 MAX_NAMES 条。
 * 设置页保存和每次起子进程都过它——config.json 是人手能改的，别信它
 * @param {unknown} list
 * @returns {string[]}
 */
function cleanNames(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const n = String(raw == null ? "" : raw).trim();
    if (!n || n.length > 100 || !NAME_RE.test(n) || seen.has(n.toUpperCase())) continue;
    seen.add(n.toUpperCase());
    out.push(n);
    if (out.length >= MAX_NAMES) break;
  }
  return out;
}

/**
 * 拼一份给子进程的环境。
 *
 * @param {Record<string, string | undefined> | null} [extra] 调用方自己要加的（PATH、OPENWORKBUDDY_HOME、MCP 服务自己配的 env）。
 *        这是本项目代码 / 属主配置给的，原样叠在最上面，不过滤
 * @param {object} [opts]
 * @param {Record<string, string | undefined>} [opts.base] 从哪份环境里挑，默认 process.env（测试传假的）
 * @param {string[]} [opts.allow] 属主清单；不传就问 setPolicy 注册的。MCP 传 [] —— 它只拿基础白名单和自己配的键
 * @param {boolean} [opts.keys] 像 Key 的名字写在清单里给不给；不传就问 setPolicy 注册的，再没有就是 false
 * @param {string} [opts.platform] 默认 process.platform；win32 上 extra 会顶掉大小写不同的同名变量
 * @returns {Record<string, string>}
 */
function buildChildEnv(extra, opts = {}) {
  const base = opts.base || process.env;
  const pol = (opts.allow === undefined || opts.keys === undefined) ? currentPolicy() : {};
  const allow = new Set(cleanNames(opts.allow !== undefined ? opts.allow : pol.allow).map((n) => n.toUpperCase()));
  const keysOk = (opts.keys !== undefined ? opts.keys : pol.keys) === true;
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (v == null) continue;
    const K = k.toUpperCase();
    const listed = allow.has(K);
    // 兜底那一道排在最前：白名单前缀里的、属主写进清单的，只要像 Key，就只认「清单里有 + 一个账号」
    if (keyLike(k)) { if (listed && keysOk) out[k] = v; continue; }
    if (BASE.has(K) || BASE_PREFIX.test(k) || listed || (keysOk && SOLO_ONLY.has(K))) out[k] = v;
  }
  const win = (opts.platform || process.platform) === "win32";
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined) continue;
    // Windows 上 Path 和 PATH 是同一个变量：两个都留着的话子进程拿到哪个看运气，调用方给的那份必须赢
    if (win) for (const old of Object.keys(out)) if (old !== k && old.toUpperCase() === k.toUpperCase()) delete out[old];
    out[k] = String(v);
  }
  return out;
}

module.exports = { buildChildEnv, setPolicy, cleanNames, keyLike, _internals: { BASE, BASE_PREFIX, KEY_LIKE, SOLO_ONLY } };
