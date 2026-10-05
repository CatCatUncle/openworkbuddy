// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 商业授权（license.js + admin.js 那四条路由 + scripts/issue-license.js）的测试。
 *
 * 跑法：node test/license.js
 * 用临时 OPENWORKBUDDY_HOME / DATA_DIR，绝不碰真账号；签名钥匙全是运行时现造的，
 * 作者那把私钥不在仓库里，这里也用不着它。
 *
 * 这块东西只记账不拦路，所以它坏掉的样子不是报错，是**该出声的时候不出声**：
 *   - 验签松了：随手改个席位数的码照样「已授权」，付费这件事就成了摆设；
 *   - 验签紧了：付过钱的人填进去说「签名对不上」，这比没有授权模块更糟；
 *   - 迹象判错：一个人接了飞书就被当团队追着要声明，或者五十个账号的公司一声不吭；
 *   - 待办的先后排错：授权码到期了，首页却在说「多了一个飞书」。
 * 每一条正向断言后面都跟一个反向对照：只证明「该挂的挂了」不够，还得证明「不该挂的没挂」。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { mod } = require("./lib/mod");

// 必须先于任何 require：org.js / vkeys.js 在加载的那一刻就把数据目录定死了
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-license-"));
process.env.OPENWORKBUDDY_HOME = HOME;
process.env.OPENWORKBUDDY_DATA_DIR = path.join(HOME, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });

const ROOT = path.join(__dirname, "..");
const express = require(path.join(ROOT, "node_modules/express"));
const license = require(mod("license")); // 不带 .js 在 macOS 上会读到 LICENSE，见【12】
const { sign } = require(path.join(ROOT, "scripts/issue-license"));
const account = require(mod("account"));
const org = require(mod("org"));
const vkeys = require(mod("vkeys"));
const admin = require(mod("admin"));
const tools = require(mod("tools"));
const srcLib = require("./lib/src");

tools.setWorkspaceDir(path.join(HOME, "workspace"));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else {
    fail++;
    const tail = extra === undefined ? "" : "  ← " + String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 400);
    console.log("  ✗ " + name + tail);
  }
}
function eq(got, want, name) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same, name, same ? undefined : { got, want });
}
/** 跑一下，把抛出来的话拿回来；没抛就是空字符串 */
const why = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };

// ---------- 钥匙与时间：全是现造的 ----------
const kp = crypto.generateKeyPairSync("ed25519");
const other = crypto.generateKeyPairSync("ed25519"); // 冒充者：自己造一把也签得出格式一模一样的码
const spki = (k) => k.export({ type: "spki", format: "der" }).toString("base64");
const PUB = spki(kp.publicKey);
const OTHER_PUB = spki(other.publicKey);
const TEST_KEYS = { keys: [PUB] };
const BUILTIN = license.PUBLIC_KEYS.slice();

// 用本地时间造「今天」：到期按本地日期算，拿 UTC 造会在东八区早上跨一天。
// 路由那一节走的是真的「现在」，所以基准码的到期日放到 2099 年，别让这份测试哪天自己到期
const T0 = new Date(2026, 8, 28, 12, 0, 0);
const at = (days) => new Date(T0.getTime() + days * 86400000);

const BASE = { id: "OWB-TEST-001", to: "测试用有限公司", scope: "internal", seats: 10, iat: "2026-09-01", exp: "2099-12-31", note: "只在测试里存在" };
const code = (patch, key = kp.privateKey) => sign({ ...BASE, ...patch }, key);
const CODE = code({});

const LIC = path.join(process.env.OPENWORKBUDDY_DATA_DIR, "license.json");
/** 直接摆一份 license.json：有的情况（验不过的码）走 setCode 根本存不进去 */
function putState(st) { fs.writeFileSync(LIC, JSON.stringify(st)); }
function clearState() { for (const f of [LIC, LIC + ".bak"]) { try { fs.rmSync(f); } catch {} } }
const readState = () => { try { return JSON.parse(fs.readFileSync(LIC, "utf8")); } catch { return {}; } };
const auditOf = (action) => org.listAudit(org.DEFAULT_ORG, { action }).audit;
const BOSS = { username: "laoban" };

/** 测试钥匙临时进内置名单。只在需要「填得进去」的那几节里开着，最后一定拿掉 */
function trustTestKey() { if (!license.PUBLIC_KEYS.includes(PUB)) license.PUBLIC_KEYS.push(PUB); }
function untrustTestKey() {
  const i = license.PUBLIC_KEYS.indexOf(PUB);
  if (i >= 0) license.PUBLIC_KEYS.splice(i, 1);
}

// ---------- 最小应用：中间件顺序照抄 server.js ----------
const cfg = { im: {} }; // 路由每次现读，改它就等于在设置页里存了一次
admin.setDeployment({ shell: false, host: "0.0.0.0" }); // 服务器形态：对局域网开放，平台那道闸开着
const app = express();
app.use(express.json());
app.use(account.createRouter({}));
app.use(account.authGuard);
app.use(admin.tenantScope({ withWorkspace: tools.withWorkspace, withPolicy: tools.withPolicy, getWorkspaceDir: tools.getWorkspaceDir }));
app.use(admin.platformGuard);
app.use(admin.createAdminRouter({ readConfig: () => cfg }));
const server = app.listen(0);
const listening = new Promise((r) => server.on("listening", r));

function call(method, url, { body, cookie } = {}) {
  const port = server.address().port;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: url,
        headers: { ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
                   ...(cookie ? { cookie } : {}) } },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(buf); } catch {}
          const sc = res.headers["set-cookie"];
          resolve({ status: res.statusCode, json, cookie: sc ? String(sc[0]).split(";")[0] : null });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
async function login(username, password) {
  const r = await call("POST", "/api/auth/login", { body: { username, password } });
  if (!r.cookie) throw new Error(`登录失败 ${username}: ${JSON.stringify(r.json)}`);
  return r.cookie;
}

(async () => {
  await listening;

  // ================= 【1】验签：真码过得去，字段一个不差 =================
  console.log("\n【1】验签：用现造钥匙签的码，拿对应公钥验得过，字段一个个对上");
  let v = license.verify(CODE, { ...TEST_KEYS, now: T0 });
  ok(v.ok, "★现造钥匙签、现造公钥验：过★", v);
  const L = v.license || {};
  eq(L.licensee, "测试用有限公司", "to → licensee");
  eq(L.id, "OWB-TEST-001", "id 原样");
  eq([L.scope, L.scope_label], ["internal", "内部使用"], "scope 和它的人话名字");
  eq(L.seats, 10, "seats 是数字");
  eq([L.issued_at, L.expires_at], ["2026-09-01", "2099-12-31"], "iat → issued_at，exp → expires_at");
  eq(L.note, "只在测试里存在", "note 原样");
  eq(L.expired, false, "没到期");
  eq(license.verify(code({ scope: "service" }), TEST_KEYS).license.scope_label, "对外提供服务", "scope=service 的人话名字");
  eq(license.verify(code({ scope: "all" }), TEST_KEYS).license.scope_label, "不限商业用途", "scope=all 的人话名字");
  eq(license.verify(code({ scope: "weird" }), TEST_KEYS).license.scope_label, "weird", "认不出的 scope 原样显示，不编一个名字");
  eq(license.verify(code({ scope: "constructor" }), TEST_KEYS).license.scope_label, "constructor",
     "scope 恰好撞上对象自带的属性名：也照原样显示，不能冒出一个函数");
  eq(license.verify(code({ scope: undefined }), TEST_KEYS).license.scope, "internal", "没写 scope 按内部使用算");
  eq(license.verify(code({ seats: undefined }), TEST_KEYS).license.seats, 0, "没写 seats = 0 = 不限");
  eq(license.verify(code({ seats: -5 }), TEST_KEYS).license.seats, 0, "负数席位按 0 算，不会变成「超了」");
  eq(license.verify(code({ seats: 12.7 }), TEST_KEYS).license.seats, 12, "小数席位向下取整");
  eq(license.verify(code({ seats: "abc" }), TEST_KEYS).license.seats, 0, "席位写成字母按 0 算");
  v = license.verify(code({ exp: undefined }), { ...TEST_KEYS, now: T0 });
  eq([v.ok, v.license.expires_at, v.license.expired], [true, "", false], "没写 exp = 永久授权，永远不算过期");
  eq(license.verify(code({ iat: "2026/9/1" }), TEST_KEYS).license.issued_at, "", "日期格式不对就当没写，不把乱七八糟的东西摆上界面");

  // 邮件里转过一手，码常被折成几行、前后带空格
  const folded = "  " + CODE.match(/.{1,20}/g).join("\n\t ") + " \r\n";
  ok(license.verify(folded, TEST_KEYS).ok, "★夹着空格、换行、制表符的码照样验得过★");
  ok(license.verify(CODE.replace(/\./g, " . "), TEST_KEYS).ok, "点号两边带空格也行");
  ok(license.verify(CODE, { keys: [OTHER_PUB, PUB] }).ok, "名单里多把钥匙，哪一把认得就算过（换钥匙时旧码不作废）");

  // ================= 【2】验签：每一种坏码都报它自己的错 =================
  console.log("\n【2】坏码：改一个字节、换签名、别的钥匙、格式不对，各报各的错");
  const [pre, body, sig] = CODE.split(".");
  const SIG_BAD = "签名对不上";
  {
    // 改载荷里的一个字节：id 最后那个 1 改成 9，JSON 照样读得出来——拦住它的只能是签名
    const bytes = Buffer.from(body, "base64url");
    const i = bytes.indexOf(Buffer.from("001"));
    bytes[i + 2] = "9".charCodeAt(0);
    v = license.verify([pre, bytes.toString("base64url"), sig].join("."), TEST_KEYS);
    ok(!v.ok && v.error.includes(SIG_BAD), "★载荷改一个字节：签名对不上★", v);
    // 最常见的动机：把席位改大
    const bigger = Buffer.from(JSON.stringify({ ...BASE, seats: 9999 })).toString("base64url");
    v = license.verify([pre, bigger, sig].join("."), TEST_KEYS);
    ok(!v.ok && v.error.includes(SIG_BAD), "★把席位改成 9999、签名不动：签名对不上★", v);
  }
  {
    const sig2 = code({ id: "OWB-TEST-002" }).split(".")[2];
    v = license.verify([pre, body, sig2].join("."), TEST_KEYS);
    ok(!v.ok && v.error.includes(SIG_BAD), "★换成另一张真码的签名：签名对不上★", v);
    v = license.verify([pre, body, Buffer.alloc(64).toString("base64url")].join("."), TEST_KEYS);
    ok(!v.ok && v.error.includes(SIG_BAD), "签名全是 0：签名对不上", v);
    v = license.verify([pre, body, ""].join("."), TEST_KEYS);
    ok(!v.ok && v.error.includes(SIG_BAD), "签名那段是空的：签名对不上，不抛异常", v);
    v = license.verify(CODE.slice(0, -5), TEST_KEYS);
    ok(!v.ok && v.error.includes(SIG_BAD), "尾巴少复制了几个字：签名对不上", v);
  }
  v = license.verify(code({}, other.privateKey), TEST_KEYS);
  ok(!v.ok && v.error.includes(SIG_BAD), "★另一把钥匙签的码（格式全对）：签名对不上★", v);
  ok(license.verify(code({}, other.privateKey), { keys: [OTHER_PUB] }).ok, "反向对照：换成它自己的公钥就过——拦它的确实是钥匙，不是格式");

  const NOT_OURS = "这不是 OpenWorkBuddy 的授权码";
  eq(license.verify("OWB2." + body + "." + sig, TEST_KEYS).error, NOT_OURS, "前缀是 OWB2：不是我们的码");
  eq(license.verify("owb1." + body + "." + sig, TEST_KEYS).error, NOT_OURS, "前缀小写也不认");
  eq(license.verify(pre + "." + body, TEST_KEYS).error, NOT_OURS, "只有两段：不是我们的码");
  eq(license.verify(CODE + ".xyz", TEST_KEYS).error, NOT_OURS, "多出第四段：不是我们的码");
  eq(license.verify("随便粘了一句话", TEST_KEYS).error, NOT_OURS, "粘错东西了：不是我们的码");
  for (const empty of ["", "   \n\t ", null, undefined]) {
    eq(license.verify(empty, TEST_KEYS).error, "授权码是空的", `空的（${JSON.stringify(empty)}）：说是空的，不说「签名对不上」`);
  }
  eq(license.verify(code({ to: "" }), TEST_KEYS).error, "授权码里没写授权给谁", "★签名是真的但没写 to：不认★");
  eq(license.verify(code({ to: "   " }), TEST_KEYS).error, "授权码里没写授权给谁", "to 全是空格：一样不认");
  eq(license.verify(code({ to: undefined }), TEST_KEYS).error, "授权码里没写授权给谁", "压根没有 to 这个字段：一样不认");
  {
    // 签名是真的，载荷却不是 JSON / 是 null：得说读不出来，而不是崩
    const signRaw = (text) => {
      const b = "OWB1." + Buffer.from(text).toString("base64url");
      return b + "." + crypto.sign(null, Buffer.from(b), kp.privateKey).toString("base64url");
    };
    ok(/读不出内容/.test(license.verify(signRaw("不是 JSON"), TEST_KEYS).error || ""), "载荷不是 JSON：读不出内容");
    ok(/读不出内容/.test(license.verify(signRaw("null"), TEST_KEYS).error || ""), "载荷是 null：读不出内容，不抛异常");
  }

  // ================= 【3】仓库里那把公钥不认测试钥匙 =================
  console.log("\n【3】内置公钥：认不出测试现造的钥匙——证明测试钥匙不是作者那把");
  ok(BUILTIN.length >= 1, "内置名单里至少有一把公钥", BUILTIN);
  ok(!BUILTIN.includes(PUB) && !BUILTIN.includes(OTHER_PUB), "现造的公钥不在内置名单里");
  for (const k of BUILTIN) {
    let type = "";
    try { type = crypto.createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" }).asymmetricKeyType; } catch (e) { type = "读不出：" + e.message; }
    eq(type, "ed25519", `内置公钥 ${k.slice(0, 16)}… 是一把能用的 Ed25519 公钥（写坏一个字符，所有付费的码一起验不过）`);
  }
  v = license.verify(CODE, { now: T0 });
  ok(!v.ok && v.error.includes(SIG_BAD), "★不注入钥匙、用内置名单验测试码：签名对不上★", v);
  clearState();
  const before = auditOf("填授权码").length;
  ok(why(() => license.setCode(CODE, BOSS, {}, T0)).includes(SIG_BAD), "★setCode 填测试码：被内置名单拒掉★");
  ok(!fs.existsSync(LIC), "  ← 拒掉的码没落盘");
  eq(auditOf("填授权码").length, before, "  ← 也没进审计：没填进去的不算填过");

  // ================= 【4】到期 =================
  console.log("\n【4】到期：过期的码还是真码（ok），只是 expired；当天不算过期");
  v = license.verify(code({ exp: "2026-09-27" }), { ...TEST_KEYS, now: T0 });
  eq([v.ok, v.license.expired], [true, true], "★昨天到期：ok 还是 true，expired=true★");
  v = license.verify(code({ exp: "2026-09-28" }), { ...TEST_KEYS, now: new Date(2026, 8, 28, 23, 59, 59) });
  eq(v.license.expired, false, "★到期日当天（晚上 23:59）不算过期★");
  v = license.verify(code({ exp: "2026-09-28" }), { ...TEST_KEYS, now: new Date(2026, 8, 29, 0, 0, 1) });
  eq(v.license.expired, true, "反向对照：过了零点就算过期");
  eq(license.verify(code({ exp: "2026-09-29" }), { ...TEST_KEYS, now: T0 }).license.expired, false, "明天到期：没过期");

  // ================= 【5】团队迹象 =================
  console.log("\n【5】团队迹象：强的一条就算，弱的要凑两条");
  const keys = (facts) => license.signalsOf(facts).map((s) => s.key).join(",");
  // teamLike 不导出：status 在没有 license.json 时算出来的 team_like 就是它
  clearState();
  const team = (facts) => license.status(facts, T0).team_like;
  eq(keys({}), "", "什么都没有：没有迹象");
  eq([keys({ users: 2 }), team({ users: 2 })], ["", false], "★2 个账号：没有迹象（自己加一个测试号很正常）★");
  eq(keys({ users: 3 }), "accounts_3", "3 个账号：accounts_3");
  eq(keys({ users: 9 }), "accounts_3", "9 个账号：还在 3 那一档");
  eq(keys({ users: 10 }), "accounts_10", "10 个账号：accounts_10");
  eq(keys({ users: 49 }), "accounts_10", "49 个账号：还在 10 那一档");
  eq(keys({ users: 50 }), "accounts_50", "50 个账号：accounts_50");
  eq(keys({ users: 800 }), "accounts_50", "800 个账号：封顶 50 那一档");
  eq(license.signalsOf({ users: 12 })[0].label, "12 个账号", "标签写的是真实人数，不是档位");
  eq(team({ users: 3 }), true, "账号数是强迹象，一条就算");
  eq([keys({ orgs: 1 }), keys({ orgs: 2 }), team({ orgs: 2 })], ["", "orgs", true], "★开了第二个组织：强迹象★");
  eq([keys({ relay_keys: 0 }), keys({ relay_keys: 1 }), team({ relay_keys: 1 })], ["", "relay", true], "★发了中转 Key：强迹象★");
  ok(license.signalsOf({ users: 3, orgs: 2, relay_keys: 1 }).every((s) => s.strong), "这三种都标 strong");
  for (const [k, facts] of [["wecom", { wecom: true }], ["feishu", { feishu: true }], ["dingtalk", { dingtalk: true }], ["server", { host: "192.168.1.8" }]]) {
    const s = license.signalsOf(facts);
    eq([s.map((x) => x.key).join(), s.every((x) => !x.strong), team(facts)], [k, true, false], `★只有 ${k} 一条弱迹象：不算团队（一个人在手机上指挥自己的电脑，走的就是它们）★`);
  }
  eq(team({ feishu: true, dingtalk: true }), true, "★两条弱迹象（飞书 + 钉钉）：算团队★");
  eq(team({ wecom: true, host: "0.0.0.0" }), true, "企业微信 + 对外开放：算团队");
  for (const h of ["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1", "", "LOCALHOST", "127.0.0.2", "127.1.2.3", "::ffff:127.0.0.1"]) {
    eq(keys({ host: h }), "", `只听本机（${JSON.stringify(h)}）：不算对外开放`);
  }
  for (const h of ["0.0.0.0", "::", "128.0.0.1", "10.127.0.1", "::ffff:192.168.1.8", "localhost.example.com"]) {
    eq(keys({ host: h }), "server", `反向对照：${h} 不是回环，算对外开放`);
  }
  eq(team({ feishu: true, host: "127.0.0.1" }), false, "飞书 + 只听本机：只有一条弱迹象，不算团队");

  // gather：从这台机器上真去数
  console.log("\n【5b】gather：账号、组织、中转 Key 从真账本里数，IM 要配全才算");
  let f = license.gather({ config: {}, host: "" });
  eq([f.users, f.orgs, f.relay_keys, f.wecom, f.feishu, f.dingtalk, f.host], [0, 1, 0, false, false, false, ""], "空机器：0 账号、1 个默认组织、0 把 Key");
  eq(license.gather({ config: { im: { wecom_app: { corp_id: "ww1", secret: "s" } } } }).wecom, true, "企业微信应用配全了：算接了");
  eq(license.gather({ config: { im: { wecom_app: { corp_id: "ww1", secret: "" } } } }).wecom, false, "只填了 corp_id 没填 secret：不算（设置页的默认值就是一堆空串）");
  eq(license.gather({ config: { im: { wecom_bot_webhook: "https://example.invalid/hook" } } }).wecom, true, "企业微信群机器人也算");
  eq(license.gather({ config: { im: { feishu: { app_id: "cli_x", app_secret: "y" } } } }).feishu, true, "飞书 app_id + app_secret：算接了");
  eq(license.gather({ config: { im: { feishu: { app_id: "cli_x", app_secret: "" } } } }).feishu, false, "飞书只填一半：不算");
  eq(license.gather({ config: { im: { dingtalk_webhook: "https://example.invalid/robot" } } }).dingtalk, true, "钉钉 webhook：算接了");
  eq(license.gather({ host: " [::1] " }).host, "::1", "IPv6 的方括号和空格去掉，才对得上回环名单");
  eq(keys(license.gather({ host: "[::1]" })), "", "  ← 所以 [::1] 不算对外开放");
  const vk = vkeys.create({ name: "测试用", org: org.DEFAULT_ORG, by: "laoban" });
  eq(license.gather({}).relay_keys, 1, "发了一把中转 Key：数得到");
  vkeys.revoke(vk.key.id, "laoban");
  eq(license.gather({}).relay_keys, 0, "停用之后不算：停掉的 Key 不是有人在用的证据");
  vkeys.remove(vk.key.id);
  const vk2 = vkeys.create({ name: "分公司发的", org: "org_branch_test", by: "laoban" });
  eq(license.gather({}).relay_keys, 1, "★别的组织发的 Key 也数得到：整台机器在对外发，不只默认组织★");
  vkeys.remove(vk2.key.id);
  {
    // 数不出来时退回 0，页面照样出得来；但必须留一句，不然「没迹象」和「没数成」分不清
    const realSeat = account.seatCount;
    const warns = [];
    const realWarn = console.warn;
    account.seatCount = () => { throw new Error("users.json 读不出来"); };
    console.warn = (m) => warns.push(String(m));
    try { f = license.gather({}); } finally { account.seatCount = realSeat; console.warn = realWarn; }
    eq(f.users, 0, "账号数不出来：退回 0，不抛");
    ok(warns.some((w) => w.includes("账号") && w.includes("users.json 读不出来")), "★  ← 但日志里留了一句，写着哪一项、原话是什么★", warns);
  }

  // ================= 【6】status：每一条待办的原因和先后 =================
  console.log("\n【6】status：该挂待办时挂，原因说对，几种情况撞在一起时挑最要紧的那条");
  trustTestKey();
  try {
    clearState();
    let s = license.status({ users: 1 }, T0);
    eq([s.state, s.attention, s.why, s.license, s.declaration], ["unlicensed", false, "", null, null], "一个人用、什么都没填：不挂待办");
    eq(s.kinds.map((k) => k.id).join(), "personal,nonprofit,evaluation", "声明选项就这三个，没有「商业使用」（商业使用要填授权码）");
    ok(s.kinds.every((k) => k.label && k.hint), "每个选项都有人话名字和说明");
    s = license.status({ users: 5 }, T0);
    eq([s.attention, s.why], [true, "看起来是团队在用，还没人做过使用声明"], "★5 个账号、没声明：挂待办★");
    eq(s.users, 5, "账号数跟着一起回去，界面不用再问一趟");

    // 个人声明：迹象不变就一直不问
    license.declare("personal", BOSS, { users: 5 }, T0);
    s = license.status({ users: 5 }, T0);
    eq([s.state, s.attention, s.declaration.kind, s.declaration.label, s.declaration.by], ["declared", false, "personal", "个人自用", "laoban"], "★声明「个人自用」之后：待办撤掉★");
    eq([s.declaration.signals, s.declaration.seen], [["accounts_3"], ["5 个账号"]], "声明时看到的迹象一起记下（key 和人话各一份）");
    eq(license.status({ users: 5 }, at(400)).attention, false, "★个人声明不过期：一年多以后迹象没变，照样不问★");
    eq(license.status({ users: 9 }, T0).attention, false, "5 → 9 个账号：还在同一档，不再问");
    s = license.status({ users: 12 }, T0);
    eq([s.attention, s.why], [true, "声明之后多了：12 个账号"], "★3 → 12 个账号：档位 key 变了，再挂待办★");
    s = license.status({ users: 5, feishu: true }, T0);
    eq(s.why, "声明之后多了：接了飞书", "声明之后接了飞书：也是新迹象");
    eq(license.status({ users: 2 }, T0).attention, false, "账号减回 2 个：没有迹象，不问");

    // 评估试用：30 天。起点是本地的「今天」，界面上写的也是这个日子
    const EVAL_OVER = "公司评估试用从 2026-09-28 起已超过 30 天";
    license.declare("evaluation", BOSS, { users: 5 }, T0);
    eq(license.status({ users: 5 }, at(29)).attention, false, "评估试用第 29 天：不问");
    eq(license.status({ users: 5 }, at(30)).attention, false, "第 30 天整：还在期限里");
    s = license.status({ users: 5 }, at(31));
    eq([s.attention, s.why], [true, EVAL_OVER], "★评估试用第 31 天：再挂待办★");
    eq(license.status({ users: 12 }, at(31)).why, EVAL_OVER, "★超 30 天又多了新迹象：先说超期（优先级：评估超期 > 新迹象）★");
    eq(license.status({ users: 12 }, at(5)).why, "声明之后多了：12 个账号", "反向对照：没超期时才说新迹象");
    s = license.status({ users: 2 }, at(31));
    eq([s.attention, s.why], [true, EVAL_OVER],
       "★评估试用超 30 天、账号减到 2 个：照样挂——选了「公司评估试用」本身就是公司在用，删个号不该让期限消失★");
    eq(license.status({ users: 1 }, at(31)).attention, true, "  ← 一个账号也一样");

    // 满 30 天再点一次「公司评估试用」：不能从头算。后台那一页超期时就摆着「重新选」按钮
    console.log("\n【6a】评估试用的 30 天只从第一次声明算起，重选、换来换去都不续");
    eq(readState().eval_since, T0.toISOString(), "第一次声明评估：记下起点 eval_since");
    s = license.declare("evaluation", BOSS, { users: 5 }, at(31));
    eq([s.attention, s.why], [true, EVAL_OVER], "★第 31 天重新声明评估：待办照样挂着，不从头算★");
    eq(readState().declaration.at, at(31).toISOString(), "  ← 声明本身记的是这一次（谁、什么时候又点了一下，审计里也有）");
    eq(readState().eval_since, T0.toISOString(), "  ← 起点没动");
    eq(license.status({ users: 5 }, at(60)).why, EVAL_OVER, "  ← 到第 60 天也还挂着");
    license.declare("personal", BOSS, { users: 5 }, at(32));
    eq(license.status({ users: 5 }, at(32)).attention, false, "换成「个人自用」：个人声明不过期，不再追");
    s = license.declare("evaluation", BOSS, { users: 5 }, at(33));
    eq([s.attention, s.why], [true, EVAL_OVER], "★先换成别的、再换回评估：起点还是第一次那天★");
    clearState();
    license.declare("evaluation", BOSS, { users: 5 }, T0);
    license.declare("evaluation", BOSS, { users: 5 }, at(20));
    eq(license.status({ users: 5 }, at(31)).why, EVAL_OVER, "第 20 天重选一次：第 31 天照样到期（没到期时重选也不续）");
    // 升级前就选过评估的老文件：没有 eval_since。接着用那次声明的时间，不趁升级白送 30 天
    putState({ declaration: { kind: "evaluation", by: "x", at: T0.toISOString(), signals: [] } });
    eq(license.status({ users: 5 }, at(31)).why, EVAL_OVER, "老文件没有 eval_since：按声明时间算");
    s = license.declare("evaluation", BOSS, { users: 5 }, at(31));
    eq([s.why, readState().eval_since], [EVAL_OVER, T0.toISOString()], "★老文件第 31 天重选评估：起点取原来那次声明，不取现在★");
    // 一台机器只评估一次：填过码、码到期删掉之后，该续的是授权，不是再白试 30 天
    s = license.setCode(CODE, BOSS, { users: 5 }, at(31));
    eq([s.state, s.attention], ["licensed", false], "填上有效的码：评估超期那条待办撤掉");
    s = license.clearCode(BOSS, { users: 5 }, at(400));
    eq([s.state, s.why], ["declared", EVAL_OVER], "★删掉码、回到评估声明：照样说超期，不因为填过码就重新白试★");
    eq(license.declare("evaluation", BOSS, { users: 5 }, at(400)).why, EVAL_OVER, "  ← 再选一次评估也一样");

    // 开始时间读不出来、或比现在还晚：挂出来，各说各的实情。不然手改一下文件就是永不到期的试用
    console.log("\n【6b】评估的开始时间坏了：不能变成永不到期");
    const evalWhy = (st) => { putState(st); return license.status({ users: 1 }, T0).why; };
    const ev = (at) => ({ kind: "evaluation", by: "x", at, signals: [] });
    eq(evalWhy({ declaration: ev("garbage") }), "评估试用的开始时间读不出来", "★声明时间是乱码：挂待办★");
    eq(evalWhy({ declaration: ev(undefined) }), "评估试用的开始时间读不出来", "声明时间缺了：挂待办");
    eq(evalWhy({ declaration: ev(T0.toISOString()), eval_since: "garbage" }), "评估试用的开始时间读不出来", "eval_since 是乱码、声明时间好的：看 eval_since，照样挂");
    eq(evalWhy({ declaration: ev(at(365).toISOString()) }), "评估试用的开始时间比现在还晚", "★开始时间在一年以后（声明时时钟快了）：挂待办，不是等到明年才到期★");
    eq(evalWhy({ declaration: ev(T0.toISOString()), eval_since: at(365).toISOString() }), "评估试用的开始时间比现在还晚", "eval_since 在一年以后：一样");
    putState({ declaration: ev("garbage") });
    eq(license.status({ users: 1 }, T0).why_kind, "eval_bad_start", "起点读不出来：why_kind 单独一类（页面写「试用已结束」，不说「满 30 天」）");
    putState({ declaration: ev(at(365).toISOString()) });
    eq(license.status({ users: 1 }, T0).why_kind, "eval_bad_start", "起点比现在还晚：也归这一类");
    eq(evalWhy({ declaration: ev(new Date(T0.getTime() + 3600000).toISOString()) }), "",
       "反向对照：只快一个小时（对时往回拨了一下）不算，别一声明就报错");
    eq(evalWhy({ declaration: { ...ev("garbage"), kind: "personal" } }), "", "反向对照：个人声明没有期限，时间读不出来也不管");
    putState({ declaration: ev("garbage"), eval_since: "garbage" });
    s = license.declare("evaluation", BOSS, { users: 1 }, T0);
    eq([s.why, readState().eval_since], ["", T0.toISOString()], "起点坏了的再选一次评估：换成现在（改得坏它的人也改得掉它，没什么可守的）");
    clearState();

    // 手改过的声明：认不出来的 kind 当没声明
    putState({ declaration: { kind: "commercial", by: "x", at: T0.toISOString(), signals: [] } });
    s = license.status({ users: 5 }, T0);
    eq([s.state, s.declaration, s.why], ["unlicensed", null, "看起来是团队在用，还没人做过使用声明"], "文件里写着认不出的 kind：当没声明");
    for (const k of ["constructor", "__proto__", "toString"]) {
      putState({ declaration: { kind: k, by: "x", at: T0.toISOString(), signals: ["accounts_3"] } });
      s = license.status({ users: 5 }, T0);
      eq([s.state, s.attention], ["unlicensed", true], `★kind 写成对象自带的属性名（${k}）：也当没声明，不能把待办悄悄压下去★`);
    }

    // 授权码
    clearState();
    putState({ code: CODE });
    s = license.status({ users: 5 }, T0);
    eq([s.state, s.attention, s.license && s.license.licensee, s.code_error], ["licensed", false, "测试用有限公司", ""], "★填了有效授权码、5 个账号、10 席：不挂待办，也不追声明★");
    s = license.status({ users: 11 }, T0);
    eq([s.attention, s.why], [true, "授权 10 席，现在有 11 个账号"], "★11 个账号超了 10 席：挂待办★");
    eq(license.status({ users: 10 }, T0).attention, false, "刚好 10 个：不算超");
    putState({ code: code({ id: "OWB-TEST-UNL", seats: 0 }) });
    eq(license.status({ users: 5000 }, T0).attention, false, "0 席 = 不限：五千个账号也不挂");
    putState({ code: code({ id: "OWB-TEST-EXP", exp: "2026-09-01" }) });
    s = license.status({ users: 11 }, T0);
    eq([s.state, s.why, s.license.expired], ["expired", "商业授权 2026-09-01 已到期", true], "★授权码到期：state=expired，而且先说到期，不先说席位（优先级：过期 > 席位）★");
    putState({ code: code({ id: "OWB-TEST-SOON", exp: "2026-09-28" }) });
    eq(license.status({ users: 5 }, T0).state, "licensed", "到期日当天：还是 licensed");
    eq(license.status({ users: 5 }, at(1)).state, "expired", "第二天：expired（按天缓存的那份不能把昨天的结论带过来）");

    // 验不过的码：只能直接摆进文件，setCode 存不进去
    const forged = code({ id: "OWB-FORGED" }, other.privateKey);
    putState({ code: forged });
    s = license.status({ users: 5 }, T0);
    eq([s.state, s.license, s.why], ["unlicensed", null, "填着的授权码验不过了"], "★文件里的码验不过：挂待办，原因说是码验不过★");
    ok(s.code_error.includes(SIG_BAD), "code_error 带着验签那句原话", s.code_error);
    license.declare("personal", BOSS, { users: 5 }, T0); // declare 只动声明，码还在
    s = license.status({ users: 5 }, T0);
    eq([s.state, s.why], ["declared", "填着的授权码验不过了"], "★验不过的码 + 有声明：state=declared，待办照样说码的事（优先级：码验不过 > 声明）★");
    eq(readState().code, forged, "  ← declare 没把填着的码冲掉");

    // 一整条优先级链：从最高那条开始，一层层拿掉，看下一层是不是轮到了
    console.log("\n【6c】优先级一整条链：过期 > 席位 > 码验不过 > 团队无声明 > 评估超期 > 新迹象");
    const chain = [], kinds = [];
    const push = (st) => { chain.push(st.why); kinds.push(st.why_kind); };
    clearState();
    license.declare("evaluation", BOSS, { users: 5 }, T0); // 先留一份评估声明，后面几层要用
    const decl = readState().declaration;
    putState({ code: code({ id: "C1", exp: "2026-09-01", seats: 3 }), declaration: decl });
    push(license.status({ users: 12 }, at(40)));
    putState({ code: code({ id: "C2", exp: "2030-01-01", seats: 3 }), declaration: decl });
    push(license.status({ users: 12 }, at(40)));
    putState({ code: forged });
    push(license.status({ users: 12 }, at(40)));
    putState({});
    push(license.status({ users: 12 }, at(40)));
    putState({ declaration: decl });
    push(license.status({ users: 12 }, at(40)));
    push(license.status({ users: 12 }, at(10)));
    push(license.status({ users: 5 }, at(10)));
    eq(chain, [
      "商业授权 2026-09-01 已到期",
      "授权 3 席，现在有 12 个账号",
      "填着的授权码验不过了",
      "看起来是团队在用，还没人做过使用声明",
      EVAL_OVER,
      "声明之后多了：12 个账号",
      "",
    ], "★每拿掉一层，下一层的原因就冒出来，最后一层什么都不说★");
    // 页面按 why_kind 决定摆不摆「重新选」：类别得跟原话一层层对上，不能让页面从原话里猜
    eq(kinds, ["expired", "seats", "bad_code", "undeclared", "eval_expired", "fresh_signals", ""],
       "★每一层的 why_kind 跟原话对得上，没待办时是空的★");

    // 坏掉的 license.json：不能让管理后台整页起不来
    clearState(); // 连 .bak 一起清：有 .bak 的话 store 会拿它顶上，测的就不是「坏了按空的算」
    fs.writeFileSync(LIC, "{ 这不是 json");
    let threw = why(() => { s = license.status({ users: 1 }, T0); });
    eq([threw, s && s.state], ["", "unlicensed"], "license.json 坏了：按空的算，不抛");
    // JSON 是合法的，形状不对：null 以前让 status / publicStatus / declare 全抛 TypeError，
    // [] 更隐蔽——声明挂在数组上，存盘时丢掉，点几次只多出几条审计
    for (const bad of ["null", "[]", "5", '"文字"', "true"]) {
      clearState();
      fs.writeFileSync(LIC, bad);
      s = null;
      threw = why(() => { s = license.status({ users: 1 }, T0); });
      eq([threw, s && s.state], ["", "unlicensed"], `★license.json 是 ${bad}：status 按空的算，不抛★`);
      eq(why(() => license.publicStatus(T0)), "", `  ← publicStatus 也不抛（登录页每次都问）`);
      threw = why(() => { s = license.declare("personal", BOSS, { users: 1 }, T0); });
      eq([threw, s && s.state, readState().declaration && readState().declaration.kind], ["", "declared", "personal"], "  ← 还能声明，而且真存下来了");
    }
    // 声明里的字段被改成别的类型：界面拿 seen.map、status 拿 new Set(signals)，都不能炸
    putState({ declaration: { kind: "personal", by: 7, at: T0.toISOString(), signals: 5, seen: "五个账号" } });
    threw = why(() => { s = license.status({ users: 5 }, T0); });
    eq([threw, s && s.why], ["", "声明之后多了：5 个账号"], "★signals 写成数字：不抛，按没记过迹象算★");
    eq([s.declaration.signals, s.declaration.seen, s.declaration.by], [[], [], "7"], "  ← 回给界面的都是该有的类型");
    putState({ declaration: "personal" });
    eq(why(() => { s = license.status({ users: 5 }, T0); }) + "|" + s.state, "|unlicensed", "声明整个是一个字符串：当没声明");
    clearState();

    // ================= 【7】声明 / 填码 / 删码进操作审计 =================
    console.log("\n【7】声明、填码、删码：每一下都进操作审计");
    let n0 = auditOf("使用声明").length;
    license.declare("nonprofit", { username: "xiaozhang" }, { users: 4, feishu: true }, T0);
    let a = auditOf("使用声明");
    eq(a.length, n0 + 1, "★声明一次，审计多一条「使用声明」★");
    eq([a[0].actor, a[0].target], ["xiaozhang", "非营利机构"], "谁声明的、选的哪一项");
    ok(a[0].detail.includes("4 个账号") && a[0].detail.includes("接了飞书"), "当时看到的迹象写进详情", a[0].detail);
    license.declare("personal", { username: "xiaozhang" }, { users: 1 }, T0);
    eq(auditOf("使用声明")[0].detail, "当时没看到团队迹象", "没迹象时也写一句，不留空");
    for (const bad of ["commercial", "", "PERSONAL", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      n0 = auditOf("使用声明").length;
      ok(why(() => license.declare(bad, BOSS, {}, T0)).includes("没有这一项声明"), `★非法 kind（${JSON.stringify(bad)}）：抛「没有这一项声明」★`);
      eq(auditOf("使用声明").length, n0, "  ← 也没留审计");
    }
    eq(readState().declaration.kind, "personal", "非法 kind 没把原来的声明冲掉");

    n0 = auditOf("填授权码").length;
    s = license.setCode("\n" + CODE.match(/.{1,30}/g).join("\n") + "\n", BOSS, { users: 5 }, T0);
    eq(s.state, "licensed", "★setCode 之后 status 就是 licensed★");
    a = auditOf("填授权码");
    eq(a.length, n0 + 1, "★填码进审计「填授权码」★");
    eq([a[0].actor, a[0].target], ["laoban", "测试用有限公司"], "谁填的、授权给谁");
    ok(a[0].detail.includes("OWB-TEST-001") && a[0].detail.includes("内部使用") && a[0].detail.includes("至 2099-12-31"), "详情里有编号、范围、到期日", a[0].detail);
    eq(readState().code, CODE, "落盘的码去掉了空白（折过行的原样存，下次读回来就对不上缓存）");
    eq([readState().code_by, readState().code_at], ["laoban", T0.toISOString()], "谁、什么时候填的也记下");
    ok(why(() => license.setCode(forged, BOSS, {}, T0)).includes(SIG_BAD), "★再填一张验不过的：抛错★");
    eq(readState().code, CODE, "  ← 原来那张有效的没被冲掉");
    eq(auditOf("填授权码").length, n0 + 1, "  ← 没填进去的不进审计");
    eq(why(() => license.setCode("", BOSS, {}, T0)), "授权码是空的", "填空的：说是空的");

    n0 = auditOf("删授权码").length;
    s = license.clearCode(BOSS, { users: 5 }, T0);
    eq([s.state, s.license], ["declared", null], "删码之后：回到声明状态");
    a = auditOf("删授权码");
    eq([a.length, a[0] && a[0].target], [n0 + 1, "测试用有限公司"], "★删码进审计「删授权码」，写着删的是谁的★");
    ok(!("code" in readState()) && !("code_by" in readState()), "码和填码人一起删掉");
    license.clearCode(BOSS, {}, T0);
    eq(auditOf("删授权码").length, n0 + 1, "没码的时候再删一次：不多记一条");
    putState({ code: forged });
    license.clearCode(BOSS, {}, T0);
    eq(auditOf("删授权码")[0].target, "（验不过的码）", "删一张验不过的码：审计里写明是验不过的");

    // ================= 【8】publicStatus：登录页只露那一点 =================
    console.log("\n【8】publicStatus：只露授权给谁，声明和迹象不出管理后台");
    clearState();
    eq(license.publicStatus(T0), { licensed: false, licensee: "" }, "没填码：licensed=false");
    license.declare("evaluation", BOSS, { users: 5, feishu: true }, T0);
    license.setCode(CODE, BOSS, {}, T0);
    let p = license.publicStatus(T0);
    eq(Object.keys(p).sort(), ["expired", "expires_at", "licensed", "licensee", "scope_label"], "★字段就这五个：没有声明、迹象、席位、编号、备注★");
    eq([p.licensed, p.expired, p.licensee, p.scope_label, p.expires_at], [true, false, "测试用有限公司", "内部使用", "2099-12-31"], "值对得上");
    ok(!JSON.stringify(p).includes("飞书") && !JSON.stringify(p).includes("评估"), "整份里搜不到声明和迹象的字");
    putState({ code: code({ id: "OWB-PUB-EXP", exp: "2026-09-01" }) });
    p = license.publicStatus(T0);
    eq([p.licensed, p.expired, p.licensee], [false, true, "测试用有限公司"], "到期了：licensed=false，expired=true，名字还在");
    putState({ code: forged });
    eq(license.publicStatus(T0), { licensed: false, licensee: "" }, "码验不过：跟没填一样，不把验不过的原因摆到登录页");
    clearState();

    // ================= 【9】路由：谁看得见、谁改得动 =================
    console.log("\n【9】路由：只有平台管理员看得见、改得动");
    let r = await call("POST", "/api/auth/register", { body: { username: "laoban", password: "pw-laoban-123" } });
    eq([r.status, r.json && r.json.user && r.json.user.role], [200, "owner"], "第一个注册的是平台超管");
    const boss = r.cookie;
    org.updateOrg(org.DEFAULT_ORG, { seats: 30 }, "laoban"); // 免费版 3 席不够这份测试用
    r = await call("POST", "/api/admin/members", { cookie: boss, body: { username: "xiaoli", role: "member" } });
    const member = await login("xiaoli", r.json.password);
    r = await call("POST", "/api/admin/members", { cookie: boss, body: { username: "kuaiji", role: "auditor" } });
    const auditor = await login("kuaiji", r.json.password);
    const fen = org.createOrg({ name: "深圳分公司", plan: "team", seats: 20, actor: "laoban" });
    r = await call("POST", "/api/auth/register", { body: { username: "fenboss", password: "pw-fen-1234", invite: org.createInvite(fen.id, { role: "admin", max_uses: 1, days: 7, actor: "laoban" }).code } });
    eq(r.json.user.role, "owner", "分公司第一个人是分公司的超管（不是平台管理员）");
    const fenboss = r.cookie;

    eq((await call("GET", "/api/admin/license")).status, 401, "没登录：401");
    eq((await call("GET", "/api/admin/license", { cookie: member })).status, 403, "★普通成员看不了★");
    eq((await call("GET", "/api/admin/license", { cookie: fenboss })).status, 403, "★别的组织的超管看不了——他们是这台服务器的租户，不是持证人★");
    // 审计员：platformOnly 认的是默认组织的**管理员**（能写的那几档），审计员进得了后台，进不了这一页。
    // 这跟价目表、付费 API 额度那几页是同一道闸（admin.js「看和改都只给平台管理员」）
    eq((await call("GET", "/api/admin/license", { cookie: auditor })).status, 403, "默认组织的审计员也看不了（跟价目表同一道闸）");
    r = await call("GET", "/api/admin/license", { cookie: boss });
    eq(r.status, 200, "★平台超管看得见★");
    const sk = ((r.json || {}).signals || []).map((s) => s.key);
    eq(sk, ["accounts_3", "orgs", "server"], "迹象是现数的：4 个账号、2 个组织、绑在 0.0.0.0", sk);
    eq([r.json.team_like, r.json.why], [true, "看起来是团队在用，还没人做过使用声明"], "所以挂着待办");

    cfg.im.feishu = { app_id: "cli_x", app_secret: "y" };
    r = await call("GET", "/api/admin/license", { cookie: boss });
    ok(r.json.signals.some((s) => s.key === "feishu"), "★设置里接了飞书，下一次 GET 就看得到（配置是现读的，不是开机那份快照）★");
    delete cfg.im.feishu;

    for (const [who, ck] of [["成员", member], ["审计员", auditor], ["别的组织的超管", fenboss]]) {
      eq((await call("POST", "/api/admin/license/declare", { cookie: ck, body: { kind: "personal" } })).status, 403, `★${who}做不了声明★`);
      eq((await call("POST", "/api/admin/license/code", { cookie: ck, body: { code: CODE } })).status, 403, `${who}填不了码`);
      eq((await call("DELETE", "/api/admin/license/code", { cookie: ck })).status, 403, `${who}删不了码`);
    }
    ok(!fs.existsSync(LIC), "  ← 上面九下一下都没落盘");

    r = await call("POST", "/api/admin/license/declare", { cookie: boss, body: { kind: "evaluation" } });
    eq([r.status, r.json.state, r.json.declaration && r.json.declaration.by], [200, "declared", "laoban"], "★平台超管声明得了，返回新的整份状态★");
    eq(auditOf("使用声明")[0].actor, "laoban", "审计里记的是登录的那个人，不是请求体里写的名字");
    r = await call("POST", "/api/admin/license/declare", { cookie: boss, body: { kind: "__proto__" } });
    eq([r.status, r.json.error], [400, "没有这一项声明"], "★请求体里塞 __proto__：400，不会变成「已声明」★");
    r = await call("POST", "/api/admin/license/declare", { cookie: boss, body: {} });
    eq(r.status, 400, "没传 kind：400");

    r = await call("POST", "/api/admin/license/code", { cookie: boss, body: { code: code({ id: "X" }, other.privateKey) } });
    eq(r.status, 400, "填别的钥匙签的码：400");
    ok(String((r.json || {}).error).includes(SIG_BAD), "  ← 原话回给界面", r.json);
    r = await call("POST", "/api/admin/license/code", { cookie: boss, body: { code: CODE } });
    eq([r.status, r.json.state, r.json.license && r.json.license.licensee], [200, "licensed", "测试用有限公司"], "★填有效码：200，状态变 licensed★");
    r = await call("GET", "/api/auth/state");
    eq([r.status, r.json.license && r.json.license.licensee, r.json.license && r.json.license.licensed], [200, "测试用有限公司", true], "★没登录的登录页也看得到授权给了谁★");
    // 授权范围和到期日是合同条款：部署在公网上，谁打开登录页都看得见。登录页只用这三个
    eq(Object.keys(r.json.license).sort(), ["expired", "licensed", "licensee"], "★  ← 没登录只有三个字段：没有范围、到期日，更没有声明和迹象★");
    r = await call("GET", "/api/auth/state", { cookie: member });
    eq(Object.keys(r.json.license).sort(), ["expired", "expires_at", "licensed", "licensee", "scope_label"], "登录之后（「关于」页要）多了范围和到期日，一共五个");
    eq([r.json.license.scope_label, r.json.license.expires_at], ["内部使用", "2099-12-31"], "  ← 值对得上");
    r = await call("DELETE", "/api/admin/license/code", { cookie: boss });
    eq([r.status, r.json.state], [200, "declared"], "删码：200，回到声明状态");
    eq(auditOf("删授权码")[0].actor, "laoban", "删码的人进审计");

    // 席位按「占席位的账号」数：离职走的是停用、不删账号。按总数数的话，
    // 买了 10 席、在职 10 个、走了 2 个，首页就对着付过钱的人说「超了」
    console.log("\n【9b】账号数跟成员页的席位一个口径：停用的不算，等审核的算");
    const bossUser = account._internals.loadUsers().users.find((u) => u.username === "laoban");
    const used = () => account.memberStats(org.DEFAULT_ORG).used + account.memberStats(fen.id).used;
    let n9 = license.gather({}).users;
    eq(n9, used(), "从真账本数出来的账号数 = 各组织成员页「占席位」加起来");
    r = await call("POST", "/api/admin/members", { cookie: boss, body: { username: "lizhi", role: "member" } });
    eq(license.gather({}).users, n9 + 1, "新加一个成员：多数一个");
    account.setMember(bossUser, "lizhi", { status: "disabled" });
    eq(license.gather({}).users, n9, "★停用（离职）之后：不再算进账号数★");
    eq(account.userCount(), n9 + 1, "  ← 账号本身还在（userCount 照样数得到），只是不占席位");
    account.setMember(bossUser, "lizhi", { status: "pending" });
    eq(license.gather({}).users, n9 + 1, "等审核的算：随时会被点头放进来");
    eq(license.gather({}).users, used(), "  ← 每一步都跟成员页的口径一致");
    account.setMember(bossUser, "lizhi", { status: "disabled" });
    r = await call("GET", "/api/admin/license", { cookie: boss });
    eq(r.json.users, n9, "后台授权页拿到的账号数也是这个口径");
  } finally {
    untrustTestKey();
  }
  eq(license.PUBLIC_KEYS, BUILTIN, "测试钥匙从内置名单里拿掉了，名单跟开始时一模一样");

  // ================= 【10】签发脚本：作者那一头 =================
  console.log("\n【10】scripts/issue-license.js：钥匙放临时目录，签出来的码 license.js 认得");
  const KEY = path.join(HOME, "signing", "key.pem");
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "issue-license.js"), ...args],
    { encoding: "utf8", env: { ...process.env, OWB_LICENSE_KEY: KEY }, timeout: 30000 });
  let c = cli("init");
  eq(c.status, 0, "init 成功", c.stderr);
  ok(fs.existsSync(KEY), "私钥写在 OWB_LICENSE_KEY 指的地方（不是作者的 ~/.config）");
  if (process.platform !== "win32") eq((fs.statSync(KEY).mode & 0o777).toString(8), "600", "私钥只有自己能读");
  const cliPub = cli("pubkey").stdout.trim();
  ok(cliPub && !BUILTIN.includes(cliPub), "pubkey 打得出来，而且不是仓库里那把", cliPub);
  eq(cli("init").status, 0, "再 init 一次：不覆盖（丢了私钥就再也签不出老版本认的码）");
  eq(cli("pubkey").stdout.trim(), cliPub, "  ← 公钥没变");

  c = cli("issue", "--to", "某某科技有限公司", "--scope", "service", "--seats", "25", "--until", "2027-01-31", "--id", "OWB-T-CLI");
  eq(c.status, 0, "issue 成功", c.stderr);
  v = license.verify(c.stdout.trim(), { keys: [cliPub], now: T0 });
  eq([v.ok, v.license && v.license.licensee, v.license && v.license.scope_label, v.license && v.license.seats, v.license && v.license.expires_at, v.license && v.license.id],
     [true, "某某科技有限公司", "对外提供服务", 25, "2027-01-31", "OWB-T-CLI"], "★脚本签的码，license.verify 用对应公钥验得过，字段对得上★");
  const ledger = fs.readFileSync(path.join(HOME, "signing", "issued-licenses.jsonl"), "utf8").trim().split("\n");
  eq([ledger.length, JSON.parse(ledger[0]).to], [1, "某某科技有限公司"], "签过的记进私钥旁边的台账");
  c = cli("verify", v.ok ? c.stdout.trim() : "x");
  ok(c.status !== 0 && c.stderr.includes(SIG_BAD), "★脚本的 verify 用的是仓库里的公钥：临时钥匙签的码验不过★", c.stderr);
  c = cli("issue", "--scope", "internal");
  ok(c.status !== 0 && c.stderr.includes("--to"), "没写 --to：不签", c.stderr);
  c = cli("issue", "--to", "某公司", "--scope", "saas");
  ok(c.status !== 0 && c.stderr.includes("--scope"), "认不出的 --scope：不签", c.stderr);
  // 值忘了写：以前 --days 后面空着会被当成 true，+true = 1，悄悄签出一张明天就到期的码
  for (const flag of ["--days", "--seats"]) {
    c = cli("issue", "--to", "某公司", flag);
    ok(c.status !== 0 && c.stderr.includes(flag), `★${flag} 后面忘了写数：不签，而不是按 1 算★`, { status: c.status, out: c.stdout.slice(0, 40), err: c.stderr });
    c = cli("issue", "--to", "某公司", flag, "--scope", "internal");
    ok(c.status !== 0 && c.stderr.includes(flag), `${flag} 后面紧跟着下一个参数：一样不签`, { status: c.status, err: c.stderr });
  }
  // 离线码签出去收不回来：打错一个字母、日期写错，都得停下来，不能签一张「差不多」的
  const refuse = [
    [["--util", "2027-01-31"], "--util", "★--until 打成 --util：不签（以前悄悄签出一张永久码）★"],
    [["--seat", "5"], "--seat", "--seats 打成 --seat：不签（以前是不限席位）"],
    [["--until", "2027-02-31"], "--until", "★--until 2027-02-31（不存在的日子）：不签★"],
    [["--until", "2027-13-01"], "--until", "--until 写了 13 月：不签"],
    [["--until", "2020-01-01"], "已经过去", "★--until 是过去的日子：不签（签出来就是过期码）★"],
    [["--days", "30", "--until", "2099-01-01"], "只能写一个", "--days 和 --until 一起给：不签，不让后一个悄悄生效"],
    [["--seats", "10", "--seats", "20"], "两遍", "同一个参数写两遍：不签"],
    [["--seats", "2.5"], "--seats", "--seats 2.5：不签（以前悄悄变成 2）"],
    [["--days", "0"], "--days", "--days 0：不签"],
    [["--seats="], "--seats", "--seats= 后面空着：不签"],
    [["--note", "很长", "的", "备注"], "多出来的参数", "备注有空格没加引号：不签（以前后半句直接丢了）"],
  ];
  for (const [extra, hint, name] of refuse) {
    c = cli("issue", "--to", "某公司", ...extra);
    ok(c.status !== 0 && c.stderr.includes(hint) && !c.stdout.trim(), name, { status: c.status, out: c.stdout.slice(0, 40), err: c.stderr });
  }
  c = cli("issue", "--to", "某公司", "--util", "2027-01-31");
  ok(c.stderr.includes("--until") && c.stderr.includes("--seats"), "  ← 报错里列出认得的参数，一眼看出是拼错了", c.stderr);
  eq(fs.readFileSync(path.join(HOME, "signing", "issued-licenses.jsonl"), "utf8").trim().split("\n").length, 1, "  ← 没签成的一张都不进台账");
  // 反向对照：写法对的都签得出来，--k=v 也认；今天到期也行（到期日当天还有效）
  const localToday = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  c = cli("issue", "--to=某公司", "--seats=3", "--until", localToday(), "--note", "带空格 的备注");
  v = license.verify(c.stdout.trim(), { keys: [cliPub] });
  eq([c.status, v.ok, v.license && v.license.seats, v.license && v.license.expires_at, v.license && v.license.note, v.license && v.license.expired],
     [0, true, 3, localToday(), "带空格 的备注", false], "★反向对照：--k=v、今天到期、带引号的备注都签得出来★");
  eq(fs.readFileSync(path.join(HOME, "signing", "issued-licenses.jsonl"), "utf8").trim().split("\n").length, 2, "  ← 签成的那张进了台账");

  // ================= 【11】对外认得出来 =================
  console.log("\n【11】响应头和页面 meta：认得出是 OpenWorkBuddy，不报版本号");
  // server.js 顶层就开始监听，不能在测试进程里 require；照 test/remote.js 那样钉源码
  const srcS = srcLib.src("server");
  ok(/app\.disable\("x-powered-by"\)/.test(srcS), "Express 自带的 X-Powered-By 关掉了");
  const pb = (/setHeader\("X-Powered-By", "([^"]*)"\)/.exec(srcS) || [])[1];
  eq(pb, "OpenWorkBuddy", "★X-Powered-By 就是 OpenWorkBuddy 这个名字★");
  ok(pb !== undefined && !/\d/.test(pb), "  ← 不带版本号（版本号只对挑漏洞的人有用）", pb);
  for (const page of ["index.html", "admin.html"]) {
    const html = fs.readFileSync(path.join(ROOT, "public", page), "utf8");
    ok(/<meta name="generator" content="OpenWorkBuddy">/.test(html), `${page} 有 generator meta，不带版本号`);
    const cp = (/<meta name="copyright" content="([^"]*)"/.exec(html) || [])[1] || "";
    ok(cp.includes("Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle)") && cp.includes("PolyForm Noncommercial 1.0.0"),
       `${page} 的 copyright meta 写着 Required Notice 和协议名`, cp);
  }

  // ================= 【12】require 撞名 =================
  // 仓库根上 license.js 和 LICENSE 并排放着。macOS / Windows 的文件系统不分大小写，
  // require("./license") 先按原样找文件，撞上的是 LICENSE（许可证全文），当 JS 一跑就是语法错：
  // admin.js 顶上那一行让整个服务起不来，account.js 那一处被 try 吞掉、登录页永远显示「未授权」。
  // Linux 分大小写，CI 的 ubuntu 那条腿永远看不出来——所以这里按「大小写不同的同名文件」现查，不靠跑一遍撞运气
  console.log("\n【12】require 不带扩展名时，不许在不分大小写的系统上撞到别的文件");
  const SKIP = new Set(["node_modules", ".git", "skills", "data", "workspace", "dist", "out", "logs", "coverage"]);
  const jsFiles = [];
  (function walk(dir, depth) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".js")) jsFiles.push(p);
    }
  })(ROOT, 0);
  const listing = new Map();
  const entriesOf = (dir) => {
    if (!listing.has(dir)) { try { listing.set(dir, fs.readdirSync(dir)); } catch { listing.set(dir, []); } }
    return listing.get(dir);
  };
  const clashes = [];
  for (const file of jsFiles) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/require\(\s*(["'])(\.{1,2}\/[^"']*)\1\s*\)/g)) {
      const spec = m[2];
      const base = path.basename(spec);
      if (path.extname(base)) continue;
      const dir = path.resolve(path.dirname(file), path.dirname(spec));
      const hit = entriesOf(dir).filter((e) => e !== base && e.toLowerCase() === base.toLowerCase());
      if (hit.length) clashes.push(`${path.relative(ROOT, file)}: require("${spec}") ↔ ${hit.join(", ")}`);
    }
  }
  ok(jsFiles.length > 50 && jsFiles.some((f) => f.endsWith(path.join("admin.js"))), "扫到了仓库里的 js（没扫到就等于没查）", jsFiles.length);
  eq(clashes, [], "★没有哪一处 require 在 macOS / Windows 上会读到大小写不同的另一个文件（比如 ./license → LICENSE）★");

  server.close();
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  if (fail === 0) fs.rmSync(HOME, { recursive: true, force: true });
  else console.log("留着现场：" + HOME);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  untrustTestKey();
  server.close();
  console.log("留着现场：" + HOME);
  process.exit(1);
});
