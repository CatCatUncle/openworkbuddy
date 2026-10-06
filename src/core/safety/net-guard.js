// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * AI 联网工具的总闸：fetch_url、chrome_cdp 打开网页、录屏、加远程连接器，都先过这里。
 *
 * 管三件事，按顺序：
 *   1. 安全中心的域名黑白名单（security.checkUrl，老规则原样）；
 *   2. 地址：先解析 DNS，A/AAAA 全部拿来判（util/net-addr.js）。落在本机、内网、链路本地、云元数据上的，
 *      安全网关开着就拦，属主可以按 host:port 加白（config.security.url_allow_local）；
 *   3. OpenWorkBuddy 自己的端口（主服务，中转站也挂在上面）：永远拦，加白不放，关了安全网关也拦。
 *      AI 一旦能打这个口，模型白名单和企业限额都管不住它。
 *
 * 发请求用 guardedFetch：连的就是判过的那几个 IP（DNS 换了答案也换不了连接目标），
 * 跳转每一跳重新判。只判一次、发请求时再让系统重新解析一遍，就给了「第一次答公网、第二次答 127.0.0.1」的空子。
 *
 * 管不到的（照实写）：AI 能跑命令时直接 curl 本机——那是沙箱的事；浏览器渲染的页面按字面地址拦，
 * 域名解析到内网的子资源拦不到（web-window.js 那一层没有 DNS 结果）。
 */
const dns = require("dns");
const net = require("net");
const os = require("os");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { Readable, pipeline } = require("stream");
const A = require("../../util/net-addr");
const security = require("./security");

/** 平台属主才改得动的那张卡，被拦时告诉人去哪儿放行 */
const WHERE = "设置 → 安全 → 沙箱安全 · 网络";
/** OWB 默认端口：命令行版跑任务时，桌面版多半正开在这个口上，本进程不知道也得拦 */
const DEFAULT_PORT = 3800;

/** @type {Map<number, string>} 端口 → 是什么 */
const own = new Map();
/** 本进程起的服务登记进来（server.js 绑上端口以后） @param {number} port @param {string} [what] */
function registerOwnPort(port, what = "") {
  const p = Number(port);
  if (p >= 1 && p <= 65535) own.set(p, what || "OpenWorkBuddy");
}
/** 环境变量 PORT 也算：命令行版和服务端常从同一个 shell 起，端口是同一个 */
function ownPorts() {
  const env = Number(process.env.PORT);
  return [...new Set([DEFAULT_PORT, ...(env >= 1 && env <= 65535 ? [env] : []), ...own.keys()])];
}

/** @typedef {{ address: string, family: number }} Addr */
/** @type {(host: string) => Promise<Addr[]>} */
const sysLookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true });
let lookupImpl = sysLookup;
/** 测试换成桩，别打真 DNS；传空恢复系统解析 @param {((host: string) => Promise<Addr[]>) | null} fn */
function setLookup(fn) { lookupImpl = fn || sysLookup; }

/** 本机网卡上的地址：连这些也是连这台机器 */
function selfIps() {
  const out = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) out.push(String(a.address).replace(/%.*$/, ""));
  } catch { /* 读不到就只认回环 */ }
  return out;
}

/** @param {string} host @param {number} ms @returns {Promise<Addr[]>} */
async function resolve(host, ms = 10000) {
  /** @type {NodeJS.Timeout | undefined} */
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error("解析超时")), ms); });
  try {
    const r = await Promise.race([lookupImpl(host), timeout]);
    return (r || []).filter((a) => a && net.isIP(String(a.address))).map((a) => ({ address: String(a.address), family: net.isIP(String(a.address)) }));
  } finally { clearTimeout(t); }
}

/**
 * @typedef {{ allowed: boolean, reason?: string, own?: boolean, host?: string, port?: number, addrs?: Addr[] }} Verdict
 * @typedef {{ bgPorts?: (() => Promise<Set<number>>) | null }} CheckOpts
 */

/**
 * 这个地址让不让 AI 的工具去连。放行时带上判过的 IP（addrs），发请求就连这几个。
 * @param {any} sec config.security
 * @param {string} url
 * @param {CheckOpts} [opts] bgPorts：这个人自己 background 起的命令正在监听的本机端口（只在要拦本机地址时才问）
 * @returns {Promise<Verdict>}
 */
async function checkUrl(sec, url, { bgPorts } = {}) {
  sec = sec || {};
  /** @type {URL} */
  let u;
  try { u = new URL(String(url)); } catch { return { allowed: false, reason: "URL 无法解析" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { allowed: false, reason: `只能访问 http/https 地址（${u.protocol}）` };
  const dom = security.checkUrl(sec, u.href);
  if (!dom.allowed) return { allowed: false, reason: `${dom.reason}（${WHERE}）` };
  const host = A.normHost(u.hostname);
  const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  const hp = `${host.includes(":") ? `[${host}]` : host}:${port}`;
  /** @type {Addr[]} */
  let addrs;
  const lit = A.literalOf(host);
  if (lit) addrs = [{ address: lit, family: net.isIP(lit.replace(/%.*$/, "")) }];
  // localhost 不问 DNS（hosts 文件可能被改过），两个回环都给：开发服务器有的只绑 ::1
  else if (A.isLocalName(host)) addrs = [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }];
  else {
    try { addrs = await resolve(host); } catch (e) { return { allowed: false, reason: `${host} 解析不出地址（${(e && e.message) || e}），没发请求` }; }
    if (!addrs.length) return { allowed: false, reason: `${host} 解析不出地址，没发请求` };
  }
  const rule = {
    allow: Array.isArray(sec.url_allow_local) ? sec.url_allow_local : [],
    own: ownPorts(),
    local: sec.gateway !== false,
    selfIps: selfIps(),
  };
  const dest = { host, port, ips: addrs.map((a) => a.address) };
  let bad = A.judge(dest, rule);
  if (bad && !bad.own && A.SELF_KINDS.has(bad.kind) && bgPorts) {
    let ports = null;
    try { ports = await bgPorts(); } catch { /* 认不出来就照常拦 */ }
    if (ports && ports.size) bad = A.judge(dest, { ...rule, bgPorts: ports });
  }
  if (!bad) return { allowed: true, host, port, addrs };
  if (bad.own) return { allowed: false, own: true, reason: `${hp} 是 OpenWorkBuddy 自己的服务端口，AI 工具一律不能访问`, host, port };
  // 多人共用时这张卡只有平台属主看得见：成员照着去找是找不到的，得让他知道该找谁
  const who = security.isMultiUser() ? "请平台属主" : "";
  return { allowed: false, reason: `${hp} 是${bad.label}地址，AI 默认不能访问。要放行，${who}在 ${WHERE} 的「本机/内网放行」加一行 ${hp}`, host, port };
}

/**
 * 只连判过的那几个 IP：给 http(s).request 的 lookup。TLS 照旧按原主机名校验证书。
 * @param {Addr[]} addrs
 */
function pinnedLookup(addrs) {
  /** @param {string} _host @param {any} opts @param {Function} cb */
  return (_host, opts, cb) => {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    const fam = opts && (opts.family === 4 || opts.family === 6) ? opts.family : 0;
    const list = fam ? addrs.filter((a) => a.family === fam) : addrs;
    const use = list.length ? list : addrs;
    if (opts && opts.all) return cb(null, use);
    cb(null, use[0].address, use[0].family);
  };
}

/**
 * @param {string} url @param {Addr[]} addrs
 * @param {{ headers?: Record<string, string>, signal?: AbortSignal }} o
 * @returns {Promise<http.IncomingMessage>}
 */
function requestOnce(url, addrs, { headers = {}, signal }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(u, {
      method: "GET",
      headers: { "Accept-Encoding": "gzip, deflate, br", ...headers },
      lookup: /** @type {any} */ (pinnedLookup(addrs)),
      agent: false,
      signal,
    }, resolve);
    req.on("error", (e) => reject(signal && signal.aborted && signal.reason ? signal.reason : e));
    req.end();
  });
}

/** 按 content-encoding 解压，跟 fetch 自己做的一样 @param {http.IncomingMessage} res */
function decoded(res) {
  const enc = String(res.headers["content-encoding"] || "").trim().toLowerCase();
  const z = /** @type {any} */ (zlib);
  const mk = enc === "gzip" || enc === "x-gzip" ? zlib.createGunzip
    : enc === "deflate" ? zlib.createInflate
      : enc === "br" ? zlib.createBrotliDecompress
        : enc === "zstd" && typeof z.createZstdDecompress === "function" ? z.createZstdDecompress : null;
  if (!mk) return res;
  const out = mk();
  pipeline(res, out, () => {});
  return out;
}

/** 包成 fetch 的 Response，调用方（tools.js fetchUrl）一行不用改 @param {http.IncomingMessage} res */
function toResponse(res) {
  const h = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    try {
      if (Array.isArray(v)) for (const x of v) h.append(k, x);
      else if (v !== undefined) h.set(k, String(v));
    } catch { /* 对方回了不合规的头：跳过这一个，不连累正文 */ }
  }
  const status = res.statusCode || 0;
  if (status < 200 || status > 599) { res.resume(); throw new Error(`对方回了看不懂的状态码 ${status}`); }
  const empty = [204, 205, 304].includes(status);
  if (empty) res.resume();
  const statusText = /^[\x20-\x7e]*$/.test(res.statusMessage || "") ? res.statusMessage || "" : "";
  return new Response(empty ? null : /** @type {any} */ (Readable.toWeb(decoded(res))), { status, statusText, headers: h });
}

/**
 * 过闸的 GET：每一跳先 checkUrl，连判过的 IP，跳转自己跟（最多 maxRedirects 跳）。
 * 被拦抛的错带 code=NET_BLOCKED，message 是给人看的原因。
 * @param {string} url
 * @param {{ sec?: any, bgPorts?: (() => Promise<Set<number>>) | null, headers?: Record<string, string>, signal?: AbortSignal, maxRedirects?: number }} [o]
 * @returns {Promise<Response>}
 */
async function guardedFetch(url, { sec, bgPorts, headers = {}, signal, maxRedirects = 5 } = {}) {
  let cur = String(url);
  for (let hop = 0; ; hop++) {
    const v = await checkUrl(sec, cur, { bgPorts });
    if (!v.allowed) {
      if (hop) security.audit("网络拦截", `跳转到 ${cur}`, "拦截");
      /** @type {any} */
      const e = new Error(hop ? `跳转到的地址被拦下：${v.reason}` : String(v.reason));
      e.code = "NET_BLOCKED";
      throw e;
    }
    const res = await requestOnce(cur, /** @type {Addr[]} */ (v.addrs), { headers, signal });
    const loc = res.headers.location;
    if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && loc) {
      res.resume();
      if (hop >= maxRedirects) throw new Error(`跳转超过 ${maxRedirects} 次，没跟下去`);
      cur = new URL(String(loc), cur).href;
      continue;
    }
    return toResponse(res);
  }
}

/**
 * 给渲染窗口（web-window.js，可能在另一个进程里）带过去的规则：纯数据，按字面地址判。
 * @param {any} sec
 */
function renderRule(sec) {
  sec = sec || {};
  return {
    allow: Array.isArray(sec.url_allow_local) ? sec.url_allow_local.slice(0, 50) : [],
    own: ownPorts(),
    local: sec.gateway !== false,
  };
}

module.exports = { checkUrl, guardedFetch, registerOwnPort, ownPorts, setLookup, renderRule, selfIps, WHERE, DEFAULT_PORT, _pinnedLookup: pinnedLookup };
