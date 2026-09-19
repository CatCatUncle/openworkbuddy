"use strict";
/**
 * 账号安全三件套：密码策略 / 二次验证（TOTP）/ 忘记密码自助。
 *
 * TOTP 的**算术**在 test/totp.js 里对着 RFC 标准向量验过了，这一份只管接线：
 * 存在哪、谁来执行、哪些路径能绕过去。算术对而接线错的 2FA 比没有更危险——
 * 界面上显示「已开启」，实际一个 000000 就能进。
 *
 * 时间这件事要说清楚：consumeTwoFactor 读的是真实 Date.now()，测试不 mock 它。
 * 要模拟「过了一会儿再登录」，就把盘上的 last_step 往回拨一格——
 * 这跟真实的时间流逝在逻辑上是同一件事，而且顺带把 last_step 真的落了盘这件事也验了。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "owb-2fa-"));
process.env.OPENWORKBUDDY_DATA_DIR = DIR;

const account = require(path.join(__dirname, "..", "account.js"));
const org = require(path.join(__dirname, "..", "org.js"));
const totp = require(path.join(__dirname, "..", "totp.js"));
const I = account._internals;

let fail = 0;
function ok(cond, msg, extra) {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg + (cond || extra === undefined ? "" : "  → " + extra));
  if (!cond) fail++;
}
/** 密码策略挡下来时说的那句话 */
function why(fn) {
  try { fn(); return ""; } catch (e) { return e.message; }
}
/** 把 last_step 往回拨，等价于「时间过去了一个窗口」 */
function rewindStep(username, by = 2) {
  const st = I.loadUsers();
  const u = st.users.find((x) => x.username === username);
  u.totp.last_step -= by;
  I.saveUsers(st);
}

console.log("① 密码策略：注册 / 自己改 / 管理员重置，三个入口一条规矩");
ok(/弱密码/.test(why(() => I.register("小赵", "123456"))), "挡掉 123456");
ok(/弱密码/.test(why(() => I.register("小赵", "woaini1314"))), "挡掉 woaini1314（中文用户高频）");
ok(/重复/.test(why(() => I.register("小赵", "aaaaaaaa"))), "挡掉 aaaaaaaa：长度够了也不行");
ok(/连续/.test(why(() => I.register("小赵", "abcdefgh"))), "挡掉 abcdefgh：连号同理");
ok(/连续/.test(why(() => I.register("小赵", "87654321"))), "倒着的连号也算");
ok(/用户名/.test(why(() => I.register("zhangsanfeng", "zhangsanfeng"))), "密码不能跟用户名一样");
ok(/空格/.test(why(() => I.register("小赵", " Zx9#mQ2v "))), "前后空格挡掉：用户看不见它，下次手敲就登不上");
ok(why(() => I.register("小赵", "Zx9#mQ2vLp")) === "", "正常密码放行");

const admin = I.loadUsers().users.find((u) => u.username === "小赵");
ok(admin && admin.role === "owner" && admin.owner, "第一个账号是超级管理员");

console.log("\n② 策略改严之后，系统自己发的随机密码也得跟着变");
org.updateOrg("default", { settings: { password_min: 16 } }, "小赵");
const gen = account.genPassword("default");
ok(gen.length >= 16, `genPassword 给的是 ${gen.length} 位`);
ok(!account.passwordProblem(gen, { org: "default" }), "★系统自己发的密码，自己过得了策略★");
const made = account.createMember(admin, { username: "小王", role: "member" });
ok(made.password.length >= 16, "管理员建号时发出去的那串也 ≥16 位（不然「添加成员」当场报错）");
const reset = account.resetPassword(admin, "小王");
ok(reset.length >= 16 && !account.passwordProblem(reset, { org: "default" }), "管理员重置发的那串同样合规");
ok(/16 位/.test(why(() => I.register("小孙", "Zx9#mQ2vLp"))), "改成 16 位之后，10 位的密码被挡");

console.log("\n③ 越界的值存不进去：界面显示的必须就是真正执行的");
org.updateOrg("default", { settings: { password_min: 3 } }, "小赵");
ok(org.settingsOf(org.getOrg("default")).password_min === 6, "password_min 填 3 → 存成 6（下限）");
org.updateOrg("default", { settings: { password_min: 999 } }, "小赵");
ok(org.settingsOf(org.getOrg("default")).password_min === 64, "填 999 → 存成 64（上限）");
org.updateOrg("default", { settings: { password_min: 6, password_strong: true } }, "小赵");
ok(/三类/.test(account.passwordProblem("qwrtypsdfg", {}) || ""), "开了复杂度：纯小写被挡");
ok(!account.passwordProblem("Qw9#tyPsdf", {}), "大小写+数字+符号 → 放行");
org.updateOrg("default", { settings: { password_strong: false } }, "小赵");

console.log("\n④ 绑定：必须真验过一次码才算开通");
const en = I.startEnroll("小赵", "测试公司");
ok(/^otpauth:\/\/totp\//.test(en.otpauth), "给的是 otpauth:// 链接");
ok(en.otpauth.includes("secret=" + en.secret), "★链接里的 secret 跟发出去的是同一个★（写错参数会变成 secret=undefined，二维码扫了也没用）");
ok(decodeURIComponent(en.otpauth).includes("测试公司:小赵"), "label 是 组织名:用户名，中文按 URI 转义");
ok(!account.twoFactorOn(I.loadUsers().users.find((u) => u.username === "小赵")), "扫了码还没验证 → 不算开通");
ok(/验证码不对/.test(why(() => I.enableTOTP("小赵", "000000"))), "错码开不通");
ok(/验证码不对/.test(why(() => I.enableTOTP("小赵", "abcdef"))), "非数字也开不通，且不抛别的异常");
const codes = I.enableTOTP("小赵", totp.code(en.secret));
ok(account.twoFactorOn(I.loadUsers().users.find((u) => u.username === "小赵")), "验对了才真开通");
ok(codes.length === 10 && codes.every((c) => /^[A-Z2-7]{4}(-[A-Z2-7]{4}){4}$/.test(c)), "10 个恢复码，4-4-4-4-4 分组（给人手抄的）", codes[0]);
const disk = I.loadUsers().users.find((u) => u.username === "小赵").totp;
ok(!disk.recovery.some((h) => codes.includes(h)), "★盘上存的是哈希，不是明文恢复码★");
ok(/已经开通过/.test(why(() => I.startEnroll("小赵", "测试公司"))), "开通之后不能直接再绑一次（要先关掉）");

console.log("\n⑤ 重放：同一个 30 秒窗口的码只认一次");
ok(I.consumeTwoFactor("小赵", totp.code(en.secret)) === null,
  "★绑定用掉的那个码，不能转头再拿来登录★（肩后看一眼、剪贴板里留一份，都是这么被用掉的）");
rewindStep("小赵");
const c1 = totp.code(en.secret);
ok(I.consumeTwoFactor("小赵", c1) === "totp", "过了一个窗口，新码能登");
ok(I.consumeTwoFactor("小赵", c1) === null, "★同一个码第二次被拒★");
ok(I.loadUsers().users.find((u) => u.username === "小赵").totp.last_step === Math.floor(Date.now() / 1000 / 30),
  "last_step 真的落了盘（只在内存里记的话，重启就能重放）");

console.log("\n⑥ 恢复码：用一次就没了");
ok(I.consumeTwoFactor("小赵", codes[3]) === "recovery", "恢复码能登");
ok(I.consumeTwoFactor("小赵", codes[3]) === null, "★同一个恢复码不能用第二次★");
ok(I.loadUsers().users.find((u) => u.username === "小赵").totp.recovery.length === 9, "盘上真的少了一个（不是标记一下）");
ok(I.consumeTwoFactor("小赵", codes[5].toLowerCase().replace(/-/g, "")) === "recovery", "小写、去掉横杠照样认：人是从纸上抄的");
ok(I.consumeTwoFactor("小赵", "ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ") === null, "编一个格式对的进不来");

console.log("\n⑦ 状态和用户信息里，一个字节的密钥都不许漏出去");
const me = I.loadUsers().users.find((u) => u.username === "小赵");
const stJson = JSON.stringify(account.twoFactorStatus(me));
ok(!stJson.includes(en.secret), "★twoFactorStatus 里没有 secret★");
ok(!stJson.includes("recovery_salt") && !/"recovery":\s*\[/.test(stJson), "★也没有恢复码哈希和盐★");
ok(JSON.parse(stJson).recovery_left === 8, "只给「还剩几个」这个数字（用掉 2 个，还剩 8）");
const puJson = JSON.stringify(account.publicUser(me));
ok(puJson.includes('"two_factor":true') && !puJson.includes(en.secret), "publicUser 只给布尔");
ok(!JSON.stringify(account.listMembers("default")).includes(en.secret), "★管理员看成员列表也看不到别人的密钥★");

console.log("\n⑧ 重新发恢复码：要先验一次码，旧的当场全废");
rewindStep("小赵");
ok(/验证码不对/.test(why(() => I.regenRecovery("小赵", "000000"))), "错码发不了新的");
const fresh = I.regenRecovery("小赵", totp.code(en.secret));
ok(fresh.length === 10 && !fresh.includes(codes[7]), "发了 10 个全新的");
ok(I.consumeTwoFactor("小赵", codes[7]) === null, "★旧的恢复码当场作废★");

console.log("\n⑨ 关掉：本人关要验码，管理员重置不用");
rewindStep("小赵");
ok(/验证码不对/.test(why(() => account.disableTOTP("小赵", { code: "000000" }))), "错码关不掉");
ok(account.twoFactorOn(I.loadUsers().users.find((u) => u.username === "小赵")), "关失败之后还是开着的");

I.startEnroll("小王", "测试公司");
const wangSecret = I.loadUsers().users.find((u) => u.username === "小王").totp.secret;
I.enableTOTP("小王", totp.code(wangSecret));
ok(account.twoFactorOn(I.loadUsers().users.find((u) => u.username === "小王")), "小王先绑上");
ok(account.disableTOTP("小王", { byAdmin: true, actor: "小赵" }) === true, "管理员重置不用码，返回「本来是开着的」");
ok(!I.loadUsers().users.find((u) => u.username === "小王").totp,
  "★整个字段删掉，不留 enabled:false 的空壳★（留着的话下次重开会接着用同一个密钥）");
ok(JSON.stringify(org.listAudit("default", { limit: 50 })).includes("重置成员二次验证"), "重置这件事进了审计日志");

rewindStep("小赵");
ok(account.disableTOTP("小赵", { code: totp.code(en.secret) }) === true, "验对了能关");
ok(!account.twoFactorOn(I.loadUsers().users.find((u) => u.username === "小赵")), "关掉了");
ok(I.consumeTwoFactor("小赵", totp.code(en.secret)) === null, "关掉之后，原来的密钥算出来的码也不认了");

console.log("\n⑩ 强制二次验证：开关真的会拦人");
ok(account.twoFactorStatus(I.loadUsers().users.find((u) => u.username === "小赵")).required === false, "默认不强制");
org.updateOrg("default", { settings: { require_2fa: true } }, "小赵");
ok(account.twoFactorStatus(I.loadUsers().users.find((u) => u.username === "小赵")).required === true, "开关拨得动");
org.updateOrg("default", { settings: { require_2fa: false } }, "小赵");

// ================= 接上线：真路由 + 真 cookie =================
// 上面验的都是函数，这一段验的是**网页那条路真的走得通**。分两件事：
//   · 登录卡片靠 `need_2fa` 这一位才敢把码框摆出来（前端自己猜不得：一上来就画码框，
//     等于拿账号名去问服务器「这人开没开二次验证」）；
//   · 「强制二次验证」开着的时候，authGuard 会把这个人挡在所有 /api/* 外面——
//     那就必须留着绑定用的那几条缝，否则程序要求他绑，又没给他任何一个能绑的地方。
//     这两边的判断条件是**同一个**，一旦飘开，要么门形同虚设，要么人永远出不来。
const express = require("express");
const http = require("http");
const app = express();
app.use(express.json());
app.use(account.createRouter({}));
app.use(account.authGuard);
app.get("/api/whoami", (req, res) => res.json({ user: req.user.username })); // 随便一个「门里面」的接口
const server = http.createServer(app);
function hit(method, url, { body, cookie } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: "127.0.0.1", port: server.address().port, method, path: url,
      headers: {
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        const setCookie = (res.headers["set-cookie"] || [])[0] || "";
        resolve({ status: res.statusCode, headers: res.headers, json, cookie: (/openworkbuddy_token=([^;]*)/.exec(setCookie) || [])[1] });
      });
    });
    r.on("error", () => resolve({ status: 0 }));
    if (data) r.write(data);
    r.end();
  });
}
const ck = (t) => "openworkbuddy_token=" + t;
const PW = "Zx9#mQ2vLp";

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  console.log("\n⑪ 登录的第二步：密码对了还差一个码，界面得知道差在哪");
  org.updateOrg("default", { seats: 20 }); // 免费版默认 3 个席位，这一段还要再进三个人
  I.register("小孙", PW);
  const sun = I.startEnroll("小孙", "测试公司");
  const sunCodes = I.enableTOTP("小孙", totp.code(sun.secret));

  let r = await hit("POST", "/api/auth/login", { body: { username: "小孙", password: PW } });
  ok(r.status === 401 && r.json && r.json.need_2fa === true,
    "★密码对但没给码：401 + need_2fa★ 登录卡就是靠这一位才敢把码框摆出来", r.json);
  ok(!r.cookie, "这一趟一个 cookie 都不发（密码对了还不算登录成功）");

  rewindStep("小孙");
  r = await hit("POST", "/api/auth/login", { body: { username: "小孙", password: PW, code: "000000" } });
  ok(r.status === 401 && r.json.need_2fa === true, "码填错了还是 need_2fa：界面留在同一步，不退回密码那一屏");

  rewindStep("小孙");
  r = await hit("POST", "/api/auth/login", { body: { username: "小孙", password: PW, code: totp.code(sun.secret) } });
  ok(r.status === 200 && !!r.cookie, "码对了才发 cookie");
  const sunCk = r.cookie;

  r = await hit("POST", "/api/auth/login", { body: { username: "小孙", password: PW, code: sunCodes[0] } });
  ok(r.status === 200, "恢复码走的是同一个口子，不用另开一个入口");
  ok(r.headers["x-recovery-left"] === "9",
    "★用掉一条就把「还剩几条」写在响应头上★ 剩 0 条时手机再丢一次就真进不来了，而这件事没人会主动去查",
    r.headers["x-recovery-left"]);

  console.log("\n⑫ 强制二次验证那道门：卡得住，但得留着能绑的那条缝");
  I.register("小周", PW);
  const zhouCk = (await hit("POST", "/api/auth/login", { body: { username: "小周", password: PW } })).cookie;
  ok(!!zhouCk, "小周先正常登进来（这会儿还没开强制）");
  org.updateOrg("default", { settings: { require_2fa: true } }, "小赵");

  r = await hit("GET", "/api/auth/state", { cookie: ck(zhouCk) });
  ok(r.json.need_2fa_setup === true,
    "★/api/auth/state 要报 need_2fa_setup★ 不报的话界面照常画出整个工作台，他点什么弹什么错，而出路藏在一个他也打不开的设置页里");
  r = await hit("GET", "/api/whoami", { cookie: ck(zhouCk) });
  ok(r.status === 403 && r.json.need_2fa_setup === true, "门里面的接口一律 403，错误体里也带这一位", r.json);
  for (const path2 of ["/api/auth/2fa", "/api/auth/me"])
    ok((await hit("GET", path2, { cookie: ck(zhouCk) })).status === 200,
      "但 " + path2 + " 得放行——绑定这件事不能被它自己挡住");

  I.register("小吴", PW);
  const wuCk = (await hit("POST", "/api/auth/login", { body: { username: "小吴", password: PW } })).cookie;
  ok((await hit("POST", "/api/auth/logout", { cookie: ck(wuCk) })).status === 200,
    "★退出登录也得放行★ 不然这道门就是死门：绑不了的人连换个账号都做不到");

  const setup = await hit("POST", "/api/auth/2fa/setup", { cookie: ck(zhouCk), body: { password: PW } });
  ok(setup.status === 200 && !!setup.json.secret, "被挡着的人拿得到密钥");
  ok(/^data:image\/png;base64,/.test(String(setup.json.qr || "")),
    "★二维码是服务端画好的★ 放前端就得往页面里塞一个平时根本用不到的二维码库", String(setup.json.qr).slice(0, 24));
  const en = await hit("POST", "/api/auth/2fa/enable", { cookie: ck(zhouCk), body: { code: totp.code(setup.json.secret) } });
  ok(en.status === 200 && Array.isArray(en.json.recovery) && en.json.recovery.length === 10, "绑上了，恢复码当场发 10 条", en.json);
  ok((await hit("GET", "/api/whoami", { cookie: ck(zhouCk) })).status === 200, "★绑完这一刻起，门里面的接口才放行★");
  ok((await hit("GET", "/api/auth/state", { cookie: ck(zhouCk) })).json.need_2fa_setup === false,
    "state 跟着改口——界面靠这一位决定还挡不挡");
  ok((await hit("GET", "/api/whoami", { cookie: ck(sunCk) })).status === 200,
    "已经绑过的人（小孙）不受这道门影响：开强制不该把他也关在外面");

  org.updateOrg("default", { settings: { require_2fa: false } }, "小赵");
  server.close();

  console.log("\n" + (fail ? `❌ 有失败：${fail} 挂` : "✅ 全过"));
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1); // 少了这一行，这个套件挂了也是绿的——CI 看的是退出码
})();
