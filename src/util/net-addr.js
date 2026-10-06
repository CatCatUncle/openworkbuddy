// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 一个地址落在哪：公网，还是本机、内网、链路本地、云服务器元数据。纯函数，不查 DNS、不碰网络。
 *
 * 为什么要管：AI 的联网工具（fetch_url、chrome_cdp、录屏、远程连接器）以前只看域名黑白名单，
 * 本机和内网的服务一个不拦——OpenWorkBuddy 自己的接口、中转站、本机别的模型网关、云服务器的元数据接口
 * （里面就是这台机器的云账号凭证），AI 都能直接打。打通了，模型白名单和企业限额就形同虚设。
 *
 * 两处用它：
 *   - core/safety/net-guard.js：联网前那道闸，DNS 解析出来的每个 IP 都拿这里判；
 *   - platform/render/web-window.js：渲染网页的隐藏窗口里，页面自己跳转、加载子资源时按字面地址拦。
 * 放在最底层，是因为渲染窗口那一层够不着 core。
 *
 * 认的写法：WHATWG URL 解析会把 2130706433、0x7f.1、0177.0.0.1、127.1 都规范成 127.0.0.1，
 * 所以主机名一律先过一遍 URL 解析再判；IPv6 里嵌着 IPv4 的（::ffff:、64:ff9b::、2002::）按里面那个 IPv4 判。
 * 198.18.0.0/15 不算：代理软件的 fake-ip 模式把公网域名都解析到这一段，拦了等于整台机器上不了网。
 */
const net = require("net");

/** 整段都算「这台机器自己」的两类：连过去就是本机上监听的服务 */
const SELF_KINDS = new Set(["loopback", "unspecified"]);

/** [网段, 前缀长度, kind, 给人看的名字]。从上往下第一条命中的算，具体的写在前面 */
const V4 = [
  ["169.254.169.254", 32, "metadata", "云服务器元数据"], // AWS / GCP / Azure / 腾讯云 / 华为云……都在这儿
  ["100.100.100.200", 32, "metadata", "云服务器元数据"], // 阿里云
  ["0.0.0.0", 8, "unspecified", "本机"],
  ["127.0.0.0", 8, "loopback", "本机"],
  ["10.0.0.0", 8, "private", "内网"],
  ["172.16.0.0", 12, "private", "内网"],
  ["192.168.0.0", 16, "private", "内网"],
  ["100.64.0.0", 10, "private", "内网"], // 运营商级 NAT、组网工具的虚拟网段
  ["169.254.0.0", 16, "link-local", "链路本地"],
  ["192.0.0.0", 24, "reserved", "保留"],
  ["224.0.0.0", 4, "multicast", "组播"],
  ["240.0.0.0", 4, "reserved", "保留"], // 含 255.255.255.255 广播
];

/** @param {string} ip */
function v4Int(ip) {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
const V4_RULES = V4.map(([base, bits, kind, label]) => {
  const len = Number(bits);
  const mask = len === 0 ? 0 : (~0 << (32 - len)) >>> 0;
  return { net: (v4Int(String(base)) & mask) >>> 0, mask, kind: String(kind), label: String(label) };
});

/**
 * @typedef {{ kind: string, label: string }} AddrClass
 */

/** @param {string} ip @returns {AddrClass | null} */
function classifyV4(ip) {
  const n = v4Int(ip);
  for (const r of V4_RULES) if (((n & r.mask) >>> 0) === r.net) return { kind: r.kind, label: r.label };
  return null;
}

/**
 * IPv6 拆成 8 个 16 位整数。认 :: 缩写和末尾的点分 IPv4；作用域（%en0）去掉。
 * @param {string} ip @returns {number[] | null}
 */
function v6Words(ip) {
  let s = String(ip || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!net.isIPv6(s)) return null;
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const b = m[2].split(".").map(Number);
    s = m[1] + ((b[0] << 8) | b[1]).toString(16) + ":" + ((b[2] << 8) | b[3]).toString(16);
  }
  const parts = s.split("::");
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length > 1 ? (parts[1] ? parts[1].split(":") : []) : null;
  const words = tail === null ? head : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  if (words.length !== 8) return null;
  return words.map((w) => parseInt(w, 16));
}

/** @param {number} hi @param {number} lo */
const v4Of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** @param {string} ip @returns {AddrClass | null} */
function classifyV6(ip) {
  const w = v6Words(ip);
  if (!w) return null;
  const zeros = (a, b) => w.slice(a, b).every((x) => x === 0);
  if (zeros(0, 8)) return { kind: "unspecified", label: "本机" };
  if (zeros(0, 7) && w[7] === 1) return { kind: "loopback", label: "本机" };
  // 嵌着 IPv4 的几种：映射（::ffff:a.b.c.d）、兼容（::a.b.c.d）、NAT64 公用前缀、6to4。按里面那个 IPv4 判
  if (zeros(0, 5) && (w[5] === 0xffff || w[5] === 0)) return classifyV4(v4Of(w[6], w[7]));
  if (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6)) return classifyV4(v4Of(w[6], w[7]));
  if (w[0] === 0x2002) return classifyV4(v4Of(w[1], w[2]));
  if (w[0] === 0xfd00 && w[1] === 0x0ec2 && zeros(2, 7) && w[7] === 0x254) return { kind: "metadata", label: "云服务器元数据" };
  if ((w[0] & 0xfe00) === 0xfc00) return { kind: "private", label: "内网" }; // fc00::/7
  if ((w[0] & 0xffc0) === 0xfe80) return { kind: "link-local", label: "链路本地" }; // fe80::/10
  if ((w[0] & 0xffc0) === 0xfec0) return { kind: "private", label: "内网" }; // fec0::/10，早废了，还有老设备在用
  if ((w[0] & 0xff00) === 0xff00) return { kind: "multicast", label: "组播" };
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return { kind: "private", label: "内网" }; // 64:ff9b:1::/48 本地 NAT64
  return null;
}

/**
 * 一个 IP 属于哪类；公网（或者看不懂）回 null。
 * @param {string} ip @returns {AddrClass | null}
 */
function classifyIp(ip) {
  const s = String(ip || "").replace(/^\[|\]$/g, "");
  const v = net.isIP(s.replace(/%.*$/, ""));
  if (v === 4) return classifyV4(s);
  if (v === 6) return classifyV6(s);
  return null;
}

/**
 * 主机名规范化：小写、去方括号、去末尾的点；数字形式的 IPv4（整数、八进制、十六进制、缩写）
 * 交给 URL 解析器规范成点分四段——跟浏览器、Node 发请求时认的是同一个地址。
 * @param {string} host @returns {string}
 */
function normHost(host) {
  let s = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!s) return "";
  if (net.isIPv6(s.replace(/%.*$/, ""))) return s;
  try { s = new URL(`http://${s}/`).hostname; } catch { /* 解析不了就按原样比，判不出来的不会被当成公网放过：调用方会去查 DNS */ }
  return s.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

/** localhost 和它底下的名字：按 RFC 6761 一律是本机，不该问 DNS @param {string} host */
const isLocalName = (host) => {
  const h = normHost(host);
  return h === "localhost" || h.endsWith(".localhost");
};

/** 主机名本身就是 IP 时回规范化后的 IP，否则回空串 @param {string} host */
function literalOf(host) {
  const h = normHost(host);
  return net.isIP(h.replace(/%.*$/, "")) ? h : "";
}

/**
 * 不查 DNS 能判出来的：localhost 类名字、字面 IP。域名回 null（得解析了再判）。
 * @param {string} host @returns {AddrClass | null}
 */
function classifyHost(host) {
  if (isLocalName(host)) return { kind: "loopback", label: "本机" };
  const lit = literalOf(host);
  return lit ? classifyIp(lit) : null;
}

/**
 * 属主加白的一条：`host:port`，端口可以写 *（这台主机的所有端口）。IPv6 写成 [::1]:8080。
 * 带了 http:// 或路径的顺手去掉；主机写 * 的不收——那等于把整道闸关了，要关去关安全网关。
 * @param {string} raw @returns {{ host: string, port: number | "*" } | null}
 */
function parseAllow(raw) {
  let s = String(raw || "").trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#\s]/)[0];
  if (!s) return null;
  const m = /^\[([^\]]+)\]:(\d{1,5}|\*)$/.exec(s) || /^([^:[\]]+):(\d{1,5}|\*)$/.exec(s);
  if (!m) return null;
  const host = normHost(m[1]);
  if (!host || host === "*" || /[*\s]/.test(host)) return null;
  if (m[1].includes(":") && !net.isIPv6(host.replace(/%.*$/, ""))) return null;
  const port = m[2] === "*" ? "*" : Number(m[2]);
  if (port !== "*" && !(port >= 1 && port <= 65535)) return null;
  return { host, port };
}

/** 写回配置的样子：主机规范化，IPv6 带方括号 @param {{ host: string, port: number | "*" }} a */
const allowText = (a) => `${a.host.includes(":") ? `[${a.host}]` : a.host}:${a.port}`;

/**
 * 设置页存进来的加白清单：看不懂的、重复的丢掉，最多 50 条。
 * @param {unknown} list @returns {string[]}
 */
function cleanAllow(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const a = parseAllow(String(raw));
    if (!a) continue;
    const t = allowText(a);
    if (!out.includes(t)) out.push(t);
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * 这个目的地是不是被某条加白放行了。端口要对上；主机按名字比，或者按解析出来的 IP 比。
 * 写的是 localhost / 127.0.0.1 / ::1 这种本机地址的，连的又是本机：算同一台（开发服务器绑在哪个上各家不一样）。
 * @param {string[]} list @param {{ host: string, port: number, ips: string[] }} dest
 */
function allowed(list, dest) {
  const selfDest = dest.ips.some((ip) => { const c = classifyIp(ip); return !!c && SELF_KINDS.has(c.kind); }) || isLocalName(dest.host);
  for (const raw of list || []) {
    const a = parseAllow(String(raw));
    if (!a || (a.port !== "*" && a.port !== dest.port)) continue;
    if (a.host === dest.host || dest.ips.includes(a.host)) return true;
    const c = classifyHost(a.host);
    if (selfDest && c && SELF_KINDS.has(c.kind)) return true;
  }
  return false;
}

/**
 * 这一趟连接放不放。null = 放行；否则回拦下的原因。
 *
 *   - 连的是这台机器（回环、0.0.0.0、本机网卡上的地址）上 OpenWorkBuddy 自己的端口：永远拦，加白也不放，
 *     安全网关关了也拦——那是主服务和中转站，AI 打通了就能绕开模型白名单和限额。
 *   - 安全网关开着（local=true）时，任何一个 IP 落在本机 / 内网 / 链路本地 / 元数据上就拦，
 *     除非属主按 host:port 加白了，或者是这个人自己 background 起的命令正在监听的本机端口（bgPorts）。
 *
 * @param {{ host: string, port: number, ips: string[] }} dest  host 已规范化；ips 是这趟要连的全部 IP
 * @param {{ allow?: string[], own?: number[], local?: boolean, selfIps?: string[], bgPorts?: Set<number> | null }} rule
 * @returns {null | (AddrClass & { own?: boolean })}
 */
function judge(dest, rule) {
  const classes = dest.ips.map(classifyIp);
  const nameCls = classifyHost(dest.host);
  if (nameCls) classes.push(nameCls);
  const selfIps = (rule.selfIps || []).map((s) => s.toLowerCase());
  const toSelf = classes.some((c) => !!c && SELF_KINDS.has(c.kind)) || dest.ips.some((ip) => selfIps.includes(ip.toLowerCase().replace(/%.*$/, "")));
  if (toSelf && (rule.own || []).includes(dest.port)) return { kind: "own", label: "OpenWorkBuddy 自己的服务", own: true };
  if (!rule.local) return null;
  const bad = classes.find((c) => !!c);
  if (!bad) return null;
  if (allowed(rule.allow || [], dest)) return null;
  // 只认回环：内网别的机器上的同号端口不是它起的
  if (rule.bgPorts && rule.bgPorts.has(dest.port) && classes.every((c) => !c || SELF_KINDS.has(c.kind))) return null;
  return bad;
}

/**
 * 不查 DNS、只看字面的那一版：网址里写的是 IP 或 localhost 才判，域名一律当没事（返回 null）。
 * 给拿不到解析结果、又必须同步答复的地方用（渲染窗口的 webRequest、录屏换页回调）。
 * @param {string} url
 * @param {{ allow?: string[], own?: number[], local?: boolean, bg?: number[], selfIps?: string[] }} rule
 * @returns {{ kind: string, label: string, own?: boolean } | null}
 */
function judgeLiteralUrl(url, rule) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (!/^(https?|wss?):$/.test(u.protocol)) return null;
  const host = normHost(u.hostname);
  const lit = literalOf(host);
  if (!lit && !isLocalName(host)) return null;
  const port = Number(u.port) || (/^(https|wss):$/.test(u.protocol) ? 443 : 80);
  return judge({ host, port, ips: lit ? [lit] : ["127.0.0.1", "::1"] }, {
    allow: rule.allow || [], own: rule.own || [], local: rule.local !== false, bgPorts: new Set(rule.bg || []), selfIps: rule.selfIps || [],
  });
}

module.exports = { classifyIp, classifyHost, normHost, literalOf, isLocalName, parseAllow, cleanAllow, allowed, judge, judgeLiteralUrl, SELF_KINDS, v6Words };
