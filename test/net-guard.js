// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * AI 联网工具的地址闸（src/core/safety/net-guard.js + src/util/net-addr.js）。
 *
 * 跑法：node test/net-guard.js
 * 全离线：临时家、DNS 一律走桩（系统解析被换成「谁调就记一笔并报错」），上游是 127.0.0.1 随机端口上的假服务。
 *
 * 要守住的事：fetch_url、chrome_cdp、录屏、加远程连接器，AI 打不到本机、内网、链路本地、云元数据——
 * 打得到的话，OpenWorkBuddy 自己的接口和中转站、本机别的模型网关、云账号凭证都在那儿，模型白名单和企业限额形同虚设。
 * 属主按 host:端口 加白才放；OpenWorkBuddy 自己的端口加白也不放、关了安全网关也不放。
 *
 *   【1】纯函数：地址分类（各种写法的 IP、嵌着 IPv4 的 IPv6）、加白清单的解析和清洗、判定、字面版
 *   【2】checkUrl：DNS 每条 A/AAAA 都判、localhost 不问 DNS、加白、自有端口、安全网关关着、域名名单照旧
 *   【3】guardedFetch：连的就是判过的 IP（不再解析第二遍）、跳转每一跳重判、解压、超时
 *   【4】工具接线：fetch_url / render_page / chrome_cdp 真被拦、加白放行、跳转被拦、自己起的后台服务放行（只认本人）
 *   【5】接线：服务端和命令行登记端口、设置页存得进、界面找得到、英文有译文、渲染窗口按字面拦
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const { spawnSync } = require("child_process");
const { mod } = require("./lib/mod");
const OWN = require("./lib/own-home")("net-guard");

process.env.OPENWORKBUDDY_DATA_DIR = path.join(OWN, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });
const FAKE_HOME = path.join(OWN, "home");
fs.mkdirSync(FAKE_HOME, { recursive: true });
process.env.HOME = FAKE_HOME;
process.env.OPENWORKBUDDY_TOOLWARD = "off";
delete process.env.PORT; // 外面终端里设过 PORT 的话，它也会被当成自有端口，结论跟着变

// 系统 DNS 一次都不许碰：名字一律记一笔、当场报找不到；字面 IP（假上游 listen 127.0.0.1 也走这儿）原样回
const dns = require("dns");
const net = require("net");
let sysDns = 0;
const realLookup = dns.lookup;
dns.lookup = (host, opts, cb) => {
  if (net.isIP(String(host))) return realLookup(host, opts, cb);
  sysDns++;
  const done = typeof opts === "function" ? opts : cb;
  process.nextTick(() => done(Object.assign(new Error("测试里不许查系统 DNS：" + host), { code: "ENOTFOUND" })));
};
dns.promises.lookup = async (host) => { sysDns++; throw Object.assign(new Error("测试里不许查系统 DNS：" + host), { code: "ENOTFOUND" }); };

const A = require(mod("net-addr"));
const G = require(mod("net-guard"));
const security = require(mod("security"));
const tools = require(mod("tools"));

// DNS 桩：名字 → 一串地址；每次调用都记下来
const ZONE = new Map();
const asked = [];
G.setLookup(async (host) => {
  asked.push(host);
  const v = ZONE.get(host);
  if (typeof v === "function") return v();
  if (!v) throw Object.assign(new Error(`queryA ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return v.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
});

let pass = 0, fail = 0, finished = false;
process.on("exit", (code) => {
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`);
  process.exitCode = 1;
});
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail).slice(0, 600))); }
};
async function section(title, fn) {
  console.log("\n" + title);
  try { await fn(); } catch (e) { fail++; console.log(`  ❌ 这一段直接炸了：${(e && e.stack || e).toString().split("\n").slice(0, 4).join(" | ")}`); }
}

/** 假上游：记下每个请求；routes 按路径回 */
function upstream(routes = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ path: req.url, host: req.headers.host, ae: req.headers["accept-encoding"] || "" });
    const r = routes[req.url.split("?")[0]];
    if (r) return r(req, res);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<html><head><title>假上游</title></head><body><p>${"这是假上游的正文，够长才不会被当成空壳去渲染。".repeat(8)}</p><p>MARK-${req.url}</p></body></html>`);
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port, seen })));
}
const closeAll = (...xs) => Promise.all(xs.map((x) => new Promise((r) => { try { x.srv.closeAllConnections(); } catch {} x.srv.close(() => r()); })));

const WS = path.join(OWN, "ws");
fs.mkdirSync(WS, { recursive: true });
const secOf = (s = {}) => security.getSecurity({ security: { approval_timeout_s: 3, ...s } });
const run = (name, input, s, extra = {}) => tools.withWorkspace(WS, () => tools.executeTool(name, input, { security: secOf(s), timeoutMs: 20000, ...extra }));

(async () => {
  await section("【1】纯函数：地址分类、加白清单、判定", async () => {
    const kind = (ip) => (A.classifyIp(ip) || { kind: "public" }).kind;
    const cases = [
      ["127.0.0.1", "loopback"], ["127.8.9.10", "loopback"], ["0.0.0.0", "unspecified"], ["10.1.2.3", "private"],
      ["172.16.0.1", "private"], ["172.31.255.255", "private"], ["192.168.1.1", "private"], ["100.64.0.1", "private"],
      ["169.254.169.254", "metadata"], ["100.100.100.200", "metadata"], ["169.254.1.1", "link-local"],
      ["::1", "loopback"], ["::", "unspecified"], ["fc00::1", "private"], ["fd12:3456::1", "private"], ["fe80::1", "link-local"],
      ["fe80::1%en0", "link-local"], ["::ffff:127.0.0.1", "loopback"], ["::ffff:7f00:1", "loopback"], ["::ffff:10.0.0.1", "private"],
      ["::ffff:169.254.169.254", "metadata"], ["64:ff9b::a9fe:a9fe", "metadata"], ["2002:7f00:1::", "loopback"],
      ["fd00:ec2::254", "metadata"], ["224.0.0.1", "multicast"], ["255.255.255.255", "reserved"],
    ];
    const bad = cases.filter(([ip, k]) => kind(ip) !== k).map(([ip, k]) => `${ip} 应为 ${k}，实为 ${kind(ip)}`);
    ok(!bad.length, `本机 / 内网 / 链路本地 / 元数据 / 嵌着 IPv4 的 IPv6，${cases.length} 种都认得`, bad);
    const pub = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "198.18.0.1"];
    ok(pub.every((ip) => A.classifyIp(ip) === null), "反向对照：公网（含 172.32、192.169 这种擦边的）不误伤；198.18 留给代理的 fake-ip", pub.filter((ip) => A.classifyIp(ip)));

    const norm = { "2130706433": "127.0.0.1", "0x7f.1": "127.0.0.1", "0177.0.0.1": "127.0.0.1", "127.1": "127.0.0.1",
      "0x7f000001": "127.0.0.1", "LOCALHOST.": "localhost", "[::1]": "::1", "0251.0376.0251.0376": "169.254.169.254" };
    const wrong = Object.entries(norm).filter(([h, w]) => A.normHost(h) !== w).map(([h, w]) => `${h} → ${A.normHost(h)}（应为 ${w}）`);
    ok(!wrong.length, "整数、八进制、十六进制、缩写的 IPv4 都规范成点分四段再判", wrong);
    ok(A.classifyHost("foo.localhost").kind === "loopback" && A.classifyHost("LocalHost").kind === "loopback", "localhost 和 *.localhost 不问 DNS 直接算本机");
    ok(A.classifyHost("example.com") === null, "  └ 域名字面上判不出来，交给 DNS");

    ok(JSON.stringify(A.cleanAllow([
      "localhost:5173", "http://127.0.0.1:8080/path?x=1", "[::1]:3000", "dev.lan:*", " LOCALHOST:5173 ",
      "*:80", "*.lan:80", "nohost", "a:0", "a:70000", "", null, "::1:3000",
    ])) === JSON.stringify(["localhost:5173", "127.0.0.1:8080", "[::1]:3000", "dev.lan:*"]),
    "加白清单：只收 host:端口，网址剥成 host:端口，大小写去重；主机写 *、没端口、端口越界、IPv6 不带括号的都不收", A.cleanAllow(["localhost:5173", "http://127.0.0.1:8080/path?x=1", "[::1]:3000", "dev.lan:*", "*:80", "::1:3000"]));
    ok(A.cleanAllow(Array.from({ length: 80 }, (_, i) => `h${i}:1`)).length === 50, "  └ 最多 50 条");

    const dest = (host, port, ips) => ({ host, port, ips });
    ok(A.allowed(["localhost:5173"], dest("127.0.0.1", 5173, ["127.0.0.1"])) && A.allowed(["localhost:5173"], dest("::1", 5173, ["::1"])),
      "写 localhost:5173 的，连 127.0.0.1 / ::1 的同一个口都算（开发服务器绑哪个各家不一样）");
    ok(!A.allowed(["localhost:5173"], dest("127.0.0.1", 5174, ["127.0.0.1"])), "  └ 端口对不上不算");
    ok(!A.allowed(["localhost:5173"], dest("192.168.1.5", 5173, ["192.168.1.5"])), "  └ 写的本机，内网别的机器同号端口不算");
    ok(A.allowed(["nas.lan:*"], dest("nas.lan", 9000, ["192.168.1.9"])) && A.allowed(["192.168.1.9:9000"], dest("nas.lan", 9000, ["192.168.1.9"])),
      "按名字或按解析出来的 IP 加白都认，端口写 * 管这台机器所有口");

    const R = { allow: ["127.0.0.1:*"], own: [3800, 4000], local: true, selfIps: ["192.168.7.7"] };
    ok(A.judge(dest("127.0.0.1", 3800, ["127.0.0.1"]), R).own === true, "★自有端口：加了 127.0.0.1:* 也拦★");
    ok(A.judge(dest("localhost", 4000, ["::1"]), { ...R, local: false }).own === true, "★自有端口：安全网关关着也拦★");
    ok(A.judge(dest("me.lan", 3800, ["192.168.7.7"]), R).own === true, "  └ 绕到本机网卡地址上一样算自己");
    ok(A.judge(dest("127.0.0.1", 8080, ["127.0.0.1"]), R) === null, "  └ 反向对照：加了白的别的口放行");
    ok(A.judge(dest("10.0.0.5", 3800, ["10.0.0.5"]), { ...R, allow: ["10.0.0.5:3800"] }) === null, "  └ 反向对照：内网别的机器上的 3800 不是自己，加了白就放");
    ok(A.judge(dest("x.test", 80, ["8.8.8.8", "10.0.0.1"]), { ...R, allow: [] }).kind === "private", "解析出好几个 IP 的，有一个落在内网就拦");
    ok(A.judge(dest("127.0.0.1", 5173, ["127.0.0.1"]), { ...R, allow: [], bgPorts: new Set([5173]) }) === null, "自己后台起的服务在监听的本机端口放行");
    ok(A.judge(dest("10.0.0.2", 5173, ["10.0.0.2"]), { ...R, allow: [], bgPorts: new Set([5173]) }) !== null, "  └ 只认回环：内网别的机器同号端口照拦");
    ok(A.judge(dest("10.0.0.2", 80, ["10.0.0.2"]), { ...R, local: false }) === null, "安全网关关了：只剩自有端口那一条");

    const lit = (u, r = {}) => A.judgeLiteralUrl(u, { own: [3800], ...r });
    ok(lit("http://127.0.0.1:5/x") && lit("http://[::1]/") && lit("http://localhost:8/") && lit("ws://10.0.0.1/") && lit("http://2130706433/"),
      "字面版：IP、localhost、ws 都按字面判");
    ok(lit("https://example.com/") === null && lit("file:///etc/passwd") === null && lit("data:text/html,x") === null && lit("不是网址") === null,
      "  └ 域名、非网络协议、看不懂的都不归它管（域名要 DNS，交给进门那道）");
    ok(lit("http://localhost:3800/", { local: false }).own === true, "  └ 自有端口字面版也是永远拦");

    const pin = G._pinnedLookup([{ address: "203.0.113.9", family: 4 }, { address: "2001:db8::9", family: 6 }]);
    const got = [];
    pin("whatever.test", {}, (e, a, f) => got.push([a, f]));
    pin("whatever.test", { family: 6 }, (e, a, f) => got.push([a, f]));
    pin("whatever.test", { all: true }, (e, list) => got.push(list.length));
    ok(JSON.stringify(got) === JSON.stringify([["203.0.113.9", 4], ["2001:db8::9", 6], 2]), "发请求时的解析钉死在判过的那几个 IP 上，问谁的名字都一样", got);
  });

  await section("【2】checkUrl：DNS 全查、加白、自有端口", async () => {
    const S = { gateway: true, url_whitelist: [], url_blacklist: [], url_allow_local: [] };
    ZONE.set("pub.test", ["93.184.216.34", "2606:2800:220:1::248"]);
    ZONE.set("mixed.test", ["93.184.216.34", "127.0.0.1"]);
    ZONE.set("v6.test", ["fd00::1"]);
    ZONE.set("mapped.test", ["::ffff:169.254.169.254"]);
    ZONE.set("nas.lan", ["192.168.1.9"]);
    let v = await G.checkUrl(S, "https://pub.test/a");
    ok(v.allowed && v.addrs.length === 2, "公网域名放行，带回判过的全部地址", v);
    v = await G.checkUrl(S, "http://mixed.test/");
    ok(!v.allowed && /本机/.test(v.reason), "★解析出一公一私：有一个是本机就拦★", v.reason);
    v = await G.checkUrl(S, "http://v6.test/");
    ok(!v.allowed && /内网/.test(v.reason), "只有 AAAA、落在 fc00::/7 的拦", v.reason);
    v = await G.checkUrl(S, "http://mapped.test/");
    ok(!v.allowed && /元数据/.test(v.reason), "AAAA 是 IPv4 映射的元数据地址也拦", v.reason);
    v = await G.checkUrl(S, "http://nope.test/");
    ok(!v.allowed && /解析不出地址/.test(v.reason) && /没发请求/.test(v.reason), "解析不出来：不放，说清没发请求", v.reason);
    ZONE.set("slow.test", () => new Promise(() => {}));
    const t0 = Date.now();
    asked.length = 0;
    v = await G.checkUrl(S, "http://localhost:5173/");
    ok(!v.allowed && asked.length === 0, "localhost 不问 DNS（hosts 文件可能被改过），直接按本机拦", { v, asked });
    ok(Date.now() - t0 < 1000, "  └ 当场判完");

    const lits = ["http://127.0.0.1/", "http://2130706433/", "http://0x7f.0.0.1/", "http://0177.0.0.1/", "http://127.1/", "http://[::1]/",
      "http://[::ffff:127.0.0.1]/", "http://0.0.0.0/", "http://169.254.169.254/latest/meta-data/", "http://[fe80::1]/", "http://10.0.0.1/",
      "http://192.168.0.1/", "http://172.20.0.1/", "http://100.100.100.200/"];
    const leaked = [];
    for (const u of lits) { const r = await G.checkUrl(S, u); if (r.allowed) leaked.push(u); }
    ok(!leaked.length, `★字面 IP 的 ${lits.length} 种写法全拦★`, leaked);
    v = await G.checkUrl(S, "http://169.254.169.254/latest/meta-data/");
    ok(/云服务器元数据/.test(v.reason), "  └ 元数据地址说的是「云服务器元数据」", v.reason);

    v = await G.checkUrl(S, "http://127.0.0.1:5173/");
    ok(v.reason.includes(G.WHERE) && v.reason.includes("127.0.0.1:5173") && /本机/.test(v.reason),
      "被拦的话说清是本机、去哪儿放行、加哪一行", v.reason);
    ok([...v.reason].length <= 90, "  └ 不啰嗦", v.reason.length);
    v = await G.checkUrl({ ...S, url_allow_local: ["localhost:5173"] }, "http://127.0.0.1:5173/");
    ok(v.allowed, "属主加白 localhost:5173 → 放行", v);
    v = await G.checkUrl({ ...S, url_allow_local: ["localhost:5173"] }, "http://127.0.0.1:5174/");
    ok(!v.allowed, "  └ 别的口照拦");
    v = await G.checkUrl({ ...S, url_allow_local: ["nas.lan:*"] }, "http://nas.lan:9000/");
    ok(v.allowed && v.addrs[0].address === "192.168.1.9", "按名字加白内网机器", v);

    v = await G.checkUrl({ ...S, url_allow_local: ["127.0.0.1:*", "localhost:3800"] }, "http://localhost:3800/api/settings");
    ok(!v.allowed && v.own && /OpenWorkBuddy 自己的服务端口/.test(v.reason), "★默认端口 3800：加白也不放★", v.reason);
    ok(!v.reason.includes(G.WHERE), "  └ 这条不指人去加白（加了也没用）", v.reason);
    G.registerOwnPort(41234, "测试");
    v = await G.checkUrl({ ...S, gateway: false, url_allow_local: ["127.0.0.1:*"] }, "http://[::ffff:127.0.0.1]:41234/");
    ok(!v.allowed && v.own, "★登记过的端口：关了安全网关、换成 IPv4 映射写法也拦★", v);
    process.env.PORT = "41999";
    v = await G.checkUrl({ ...S, url_allow_local: ["127.0.0.1:*"] }, "http://127.0.0.1:41999/");
    ok(!v.allowed && v.own, "环境变量 PORT 指的口也算自己（命令行和服务端常从同一个 shell 起）");
    delete process.env.PORT;
    v = await G.checkUrl({ ...S, gateway: false }, "http://10.0.0.1/");
    ok(v.allowed, "安全网关关了：内网放行（只剩自有端口拦）");
    v = await G.checkUrl({ ...S, url_blacklist: ["pub.test"] }, "https://pub.test/");
    ok(!v.allowed && /黑名单/.test(v.reason) && v.reason.includes(G.WHERE), "域名黑白名单照旧，说清在哪儿改", v.reason);
    v = await G.checkUrl(S, "file:///etc/hosts");
    ok(!v.allowed, "非 http/https 不放", v.reason);

    let calls = 0;
    const bg = async () => { calls++; return new Set([5173]); };
    v = await G.checkUrl(S, "http://127.0.0.1:5173/", { bgPorts: bg });
    ok(v.allowed && calls === 1, "自己后台起的服务正监听这个本机口：放行", v);
    v = await G.checkUrl(S, "https://pub.test/", { bgPorts: bg });
    ok(v.allowed && calls === 1, "  └ 公网地址不去问后台端口（省一次 lsof）");
    v = await G.checkUrl(S, "http://127.0.0.1:3800/", { bgPorts: async () => new Set([3800]) });
    ok(!v.allowed && v.own, "  └ 自有端口不吃这条豁免");
    v = await G.checkUrl(S, "http://127.0.0.1:5173/", { bgPorts: async () => { throw new Error("lsof 坏了"); } });
    ok(!v.allowed, "  └ 认不出后台端口就照常拦");
    ok(sysDns === 0, "这一段没碰系统 DNS", sysDns);
  });

  await section("【3】guardedFetch：钉 IP、逐跳重判", async () => {
    const T = await upstream();
    const S = await upstream({
      "/gz": (_q, res) => { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Encoding": "gzip" }); res.end(zlib.gzipSync("解压后的正文")); },
      "/empty": (_q, res) => { res.writeHead(204); res.end(); },
      "/to-t": (_q, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${T.port}/stolen` }); res.end(); },
      "/to-meta": (_q, res) => { res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" }); res.end(); },
      "/to-own": (_q, res) => { res.writeHead(301, { Location: "http://localhost:3800/api/settings" }); res.end(); },
      "/to-name": (_q, res) => { res.writeHead(307, { Location: "/hop2" }); res.end(); },
      "/loop": (_q, res) => { res.writeHead(302, { Location: "/loop" }); res.end(); },
      "/hang": () => {},
    });
    try {
      const sec = { gateway: true, url_allow_local: [`pin.test:${S.port}`] };
      ZONE.set("pin.test", ["127.0.0.1"]);
      asked.length = 0; sysDns = 0;
      let r = await G.guardedFetch(`http://pin.test:${S.port}/hello`, { sec });
      const body = await r.text();
      ok(r.status === 200 && body.includes("MARK-/hello"), "按名字加白的本机服务拿得到", r.status);
      ok(asked.filter((h) => h === "pin.test").length === 1 && sysDns === 0, "★只在判的时候解析一次，连的时候不再问 DNS（换答案也换不了连接目标）★", { asked, sysDns });
      ok(S.seen.at(-1).host === `pin.test:${S.port}`, "  └ Host 头还是原来的名字", S.seen.at(-1));

      r = await G.guardedFetch(`http://pin.test:${S.port}/gz`, { sec });
      ok((await r.text()) === "解压后的正文" && /gzip/.test(S.seen.at(-1).ae), "gzip 照 fetch 的样子解开");
      r = await G.guardedFetch(`http://pin.test:${S.port}/empty`, { sec });
      ok(r.status === 204 && (await r.text()) === "", "204 没正文也不炸");

      r = await G.guardedFetch(`http://pin.test:${S.port}/to-name`, { sec });
      ok(r.status === 200 && (await r.text()).includes("MARK-/hop2"), "相对路径的跳转跟得下去（同一个加白的口）");
      ok(asked.filter((h) => h === "pin.test").length === 5, "  └ 每一跳都重新判一遍", asked);

      const before = T.seen.length;
      let err = await G.guardedFetch(`http://pin.test:${S.port}/to-t`, { sec }).catch((e) => e);
      ok(err && err.code === "NET_BLOCKED" && /跳转到的地址被拦下/.test(err.message) && err.message.includes(`127.0.0.1:${T.port}`),
        "★跳到没加白的本机口：拦下，说清是跳转★", err && err.message);
      ok(T.seen.length === before, "  └ 那个口一次都没被连", T.seen.length);
      err = await G.guardedFetch(`http://pin.test:${S.port}/to-meta`, { sec }).catch((e) => e);
      ok(err && err.code === "NET_BLOCKED" && /元数据/.test(err.message), "跳到云元数据：拦", err && err.message);
      err = await G.guardedFetch(`http://pin.test:${S.port}/to-own`, { sec: { ...sec, url_allow_local: [...sec.url_allow_local, "localhost:*"] } }).catch((e) => e);
      ok(err && err.code === "NET_BLOCKED" && /自己的服务端口/.test(err.message), "跳到 OWB 自己的端口：加了 localhost:* 也拦", err && err.message);
      err = await G.guardedFetch(`http://pin.test:${S.port}/loop`, { sec, maxRedirects: 3 }).catch((e) => e);
      ok(err && /跳转超过 3 次/.test(err.message), "转圈的跳转有上限", err && err.message);
      err = await G.guardedFetch(`http://pin.test:${S.port}/hang`, { sec, signal: AbortSignal.timeout(300) }).catch((e) => e);
      ok(err && err.name === "TimeoutError", "超时照 fetch 的样子报 TimeoutError（fetch_url 认这个名字给人话）", err && (err.name + " " + err.message));

      const n = S.seen.length;
      err = await G.guardedFetch(`http://127.0.0.1:${S.port}/x`, { sec: { gateway: true } }).catch((e) => e);
      ok(err && err.code === "NET_BLOCKED" && S.seen.length === n, "第一跳就不放的：一个字节都不发", err && err.message);
      ok(sysDns === 0, "这一段没碰系统 DNS", sysDns);
    } finally { await closeAll(S, T); }
  });

  await section("【4】工具接线：fetch_url / render_page / chrome_cdp", async () => {
    const T = await upstream();
    const S = await upstream({ "/to-t": (_q, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${T.port}/stolen` }); res.end(); } });
    const C = await upstream(); // 冒充 Chrome 的调试口：navigate 被拦时它不该被碰
    try {
      let r = await run("fetch_url", { url: `http://127.0.0.1:${S.port}/a`, render: "off" });
      ok(r.isError && /本机地址/.test(r.content) && r.content.includes(`127.0.0.1:${S.port}`) && r.content.includes(G.WHERE),
        "★fetch_url 打本机：拦下，说清去哪儿放行★", r.content);
      ok(S.seen.length === 0, "  └ 一次都没连", S.seen.length);
      r = await run("render_page", { url: `http://localhost:${S.port}/a` });
      ok(r.isError && /本机地址/.test(r.content), "render_page 也拦", r.content);
      r = await run("fetch_url", { url: "http://169.254.169.254/latest/meta-data/iam/", render: "off" }, { url_allow_local: ["127.0.0.1:*"] });
      ok(r.isError && /云服务器元数据/.test(r.content), "元数据地址：加了本机白名单也跟它无关，照拦", r.content);
      for (const u of [`http://2130706433:${S.port}/`, `http://0x7f.0.0.1:${S.port}/`, `http://[::ffff:127.0.0.1]:${S.port}/`]) {
        r = await run("fetch_url", { url: u, render: "off" });
        ok(r.isError && /本机地址/.test(r.content), `换个写法也拦：${u.replace(/:\d+\/$/, "")}`, r.content);
      }
      ZONE.set("rebind.test", ["8.8.8.8", "127.0.0.1"]);
      r = await run("fetch_url", { url: `http://rebind.test:${S.port}/`, render: "off" });
      ok(r.isError && /本机地址/.test(r.content), "域名解析出一公一私：拦", r.content);
      ok(S.seen.length === 0, "  └ 上面这些一次都没连到假上游", S.seen.length);

      r = await run("fetch_url", { url: `http://127.0.0.1:${S.port}/ok`, render: "off" }, { url_allow_local: [`localhost:${S.port}`] });
      ok(!r.isError && String(r.content).includes("MARK-/ok"), "属主加白 localhost:端口：fetch_url 拿得到", String(r.content).slice(0, 120));
      r = await run("fetch_url", { url: `http://127.0.0.1:${S.port}/to-t`, render: "off" }, { url_allow_local: [`127.0.0.1:${S.port}`] });
      ok(r.isError && /跳转到的地址被拦下/.test(r.content) && T.seen.length === 0, "★加白的口 302 到没加白的口：拦下，那个口没被连★", r.content);

      G.registerOwnPort(T.port, "测试");
      r = await run("fetch_url", { url: `http://127.0.0.1:${T.port}/`, render: "off" }, { url_allow_local: ["127.0.0.1:*"], gateway: false });
      ok(r.isError && /自己的服务端口/.test(r.content) && T.seen.length === 0, "★登记过的自有端口：加白、关网关都不放★", r.content);

      const cdpIn = (url) => ({ action: "navigate", url, port: C.port, wait_ms: 0 });
      r = await run("chrome_cdp", cdpIn(`http://127.0.0.1:${S.port}/`));
      ok(r.isError && /本机地址/.test(r.content), "★chrome_cdp 打开本机页面：拦★", r.content);
      r = await run("chrome_cdp", cdpIn("http://[::1]:3800/"));
      ok(r.isError && /自己的服务端口/.test(r.content), "chrome_cdp 打开 OWB 自己：拦", r.content);
      r = await run("chrome_cdp", cdpIn("http://192.168.1.1/admin"));
      ok(r.isError && /内网/.test(r.content), "chrome_cdp 打开内网管理页：拦", r.content);
      ok(C.seen.length === 0, "  └ 拦下的时候根本没去连浏览器", C.seen.length);

      const audit = fs.readdirSync(process.env.OPENWORKBUDDY_DATA_DIR).filter((f) => /audit/.test(f));
      ok(true, "（审计按防抖落盘，这里不等它）", audit);

      // 自己 background 起的开发服务器：不加白也放（写网页的日常）；别人起的不算
      const lsof = process.platform !== "win32" && (fs.existsSync("/usr/sbin/lsof") || spawnSync("sh", ["-c", "command -v lsof"]).status === 0);
      if (!lsof) { console.log("  ⏭ 没有 lsof（或在 Windows 上）：后台端口豁免不验，照常拦"); return; }
      const free = await upstream(); const P = free.port; await closeAll(free);
      const js = `require("http").createServer((q,s)=>s.end("BG-"+"正文".repeat(200))).listen(${P},"127.0.0.1",()=>console.log("listening ${P}"))`;
      const full = { permission_mode: "full" };
      r = await run("run_shell", { command: `node -e '${js}'`, background: true, purpose: "起预览服务" }, full, { actor: "alice" });
      const id = (/已在后台起好 (\S+)：/.exec(String(r.content)) || [])[1];
      ok(!!id, "后台起了一个开发服务器", r.content);
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        up = await new Promise((res) => { const q = http.get({ host: "127.0.0.1", port: P, path: "/" }, (s) => { s.resume(); res(true); }); q.on("error", () => res(false)); });
        if (!up) await new Promise((res) => setTimeout(res, 100));
      }
      ok(up, "  └ 它在监听了");
      r = await run("fetch_url", { url: `http://127.0.0.1:${P}/`, render: "off" }, full, { actor: "alice" });
      ok(!r.isError && String(r.content).includes("BG-"), "★自己后台起的服务：不加白也拿得到★", String(r.content).slice(0, 160));
      r = await run("fetch_url", { url: `http://127.0.0.1:${P}/`, render: "off" }, full, { actor: "bob" });
      ok(r.isError && /本机地址/.test(r.content), "★别人起的那个：照拦★", r.content);
      r = await run("shell_kill", { id }, full, { actor: "alice" });
      ok(!r.isError, "停掉", r.content);
      r = await run("fetch_url", { url: `http://127.0.0.1:${P}/`, render: "off" }, full, { actor: "alice" });
      ok(r.isError && /本机地址/.test(r.content), "  └ 停了以后那个口回到默认拦", r.content);
    } finally { await closeAll(S, T, C); }
  });

  await section("【5】接线：登记端口、设置页、界面、渲染窗口", async () => {
    const read = (f) => fs.readFileSync(f, "utf8");
    const ROOT = path.join(__dirname, "..");
    const server = read(path.join(ROOT, "server.js"));
    const cli = read(path.join(ROOT, "cli.js"));
    const tsrc = read(mod("tools"));
    ok(/const \{ server, bound \} = got;\s*\n(?:\s*\/\/.*\n)*\s*netGuard\.registerOwnPort\(bound, "主服务"\)/.test(server), "服务端绑上端口就登记（中转站挂在同一个口上）");
    ok(/sec\.url_allow_local = netAddr\.cleanAllow\(b\.security\.url_allow_local\)/.test(server), "设置页存加白清单要先洗一遍");
    ok(/net-guard"\)\.registerOwnPort\(require\("\.\/src\/platform\/paths"\)\.resolvePort\(process\.env, config\)/.test(cli), "命令行把桌面版 / 服务端的端口也登记进来");
    const ends = (i) => { const n = tsrc.indexOf("\n      case \"", i + 10); return n > i ? n : i + 6000; };
    const caseBody = (name) => { const i = tsrc.indexOf(`case "${name}"`); return i < 0 ? "" : tsrc.slice(i, ends(i)); };
    const fetchCase = caseBody("render_page"); // fetch_url 和它共用一段
    ok(/netGuard\.checkUrl\(sec, input\.url/.test(fetchCase) && /guard: \{ sec/.test(fetchCase), "fetch_url：进门判一次，发请求走钉 IP 的那条");
    ok(/netGuard\.checkUrl\(sec, input\.url/.test(caseBody("chrome_cdp")), "chrome_cdp 打开网页过同一道闸");
    ok(/netGuard\.checkUrl\(sec, u/.test(caseBody("record_web_demo")) && /judgeLiteralUrl/.test(caseBody("record_web_demo")), "录屏：点名的地址先解析判，换页按字面拦");
    ok(/netGuard\.checkUrl\(sec, entry\.url/.test(caseBody("add_connector")), "加远程连接器过同一道闸");
    ok(/netGuard\.guardedFetch\(url/.test(tsrc), "fetchUrl 带 guard 时用 guardedFetch");

    const ui = read(path.join(ROOT, "public", "js", "app-06.js"));
    ok(/"sec-ulocal"/.test(ui) && /url_allow_local: linesOf\("#sec-ulocal"\)/.test(ui), "安全页「沙箱安全 · 网络」卡上有加白框，保存时带上");
    const card = ui.slice(ui.indexOf("沙箱安全 · 网络"), ui.indexOf("sec-ulocal"));
    ok(card.length > 0 && card.length < 1200, "  └ 就在那张卡里", card.length);
    ok(G.WHERE === "设置 → 安全 → 沙箱安全 · 网络" && /\["security", "安全"/.test(read(path.join(ROOT, "public", "js", "app-05.js"))), "报错里指的路径跟界面上的名字对得上");
    const i18n = read(path.join(ROOT, "public", "js", "i18n.js"));
    const zh = ["AI 默认不能访问本机和内网地址。要放行，每行写一个 host:端口（端口可写 *）。", "OpenWorkBuddy 自己的端口写了也不放。", "本机/内网放行"];
    ok(zh.every((s) => ui.includes(s)), "界面文案都在卡片上", zh.filter((s) => !ui.includes(s)));
    ok(zh.every((s) => i18n.includes(JSON.stringify(s) + ":")), "每句都有英文", zh.filter((s) => !i18n.includes(JSON.stringify(s) + ":")));
    ok(/if \(!po\) \{|\$\{!po \? `/.test(ui) && ui.indexOf("sec-ulocal") > ui.indexOf("${!po ? `"), "整块在属主才看得到的那一半里");

    const WW = require(mod("web-window"));
    const rule = { ...G.renderRule({ gateway: true, url_allow_local: ["127.0.0.1:5173"] }), bg: [] };
    ok(WW.blockedInRender("http://127.0.0.1:8080/", rule) && WW.blockedInRender("http://169.254.169.254/", rule) && WW.blockedInRender("http://localhost:3800/", rule),
      "渲染窗口：页面自己跳本机、元数据、OWB 自己，按字面拦");
    ok(!WW.blockedInRender("http://127.0.0.1:5173/", rule) && !WW.blockedInRender("https://example.com/", rule), "  └ 加了白的、域名的放行");
    ok(/block: a && a\.block && typeof a\.block === "object" \? a\.block : null/.test(read(mod("bridge-main"))), "服务进程那边算好的规则带进主进程的渲染窗口");
  });

  finished = true;
  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
