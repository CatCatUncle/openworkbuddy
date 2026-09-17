"use strict";
/**
 * TOTP（totp.js）的判据测试。
 *
 * 这份测试的重心不在「我写的能不能自洽」，而在**跟全世界对不对得上**。
 * 二次验证这种东西，自洽是没有意义的：用户拿的是 Google Authenticator / 1Password，
 * 我这边算出来的必须跟它们一个字不差。所以主菜是 RFC 4226 和 RFC 6238 的标准向量——
 * 那是所有 app 共同的答案，对上了才叫对。
 *
 * 剩下几节盯的是三个「写错了不报错、只会偶发」的地方：
 *   · 64 位计数器的高低半段（JS 移位只有 32 位，>>> 32 是个经典坑）
 *   · 时间窗（太紧 → 用户反复输对却过不去；太松 → 码的寿命被悄悄拉长）
 *   · 重放（一个码在它那 30 秒里能被用无数次，除非调用方记住用过哪一格）
 *
 * 每一节都配反向对照：既证明该过的过，也证明**换一个输入就不过**。
 */
const path = require("path");
const totp = require(path.join(__dirname, "..", "totp"));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });

// RFC 4226 / 6238 两份文档用的都是这把密钥："12345678901234567890"
const RFC_SECRET = totp.base32Encode(Buffer.from("12345678901234567890", "ascii"));

// ── ① base32 先立住：它错了，下面全部会跟着错，而且错得像「密钥不对」 ────────
console.log("\n① base32 编解码");
eq(RFC_SECRET, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "RFC 那把密钥编出来是这串（Google Authenticator 里贴的就是它）");
eq(totp.base32Decode(RFC_SECRET).toString("ascii"), "12345678901234567890", "解回去是原文");
// 用户是**照着屏幕手抄**这串的，app 又常按 4 位一组显示。不擦空格的话，
// 抄得越认真越连不上——这条不是锦上添花，是这条路能不能走通
eq(totp.base32Decode("gezd gnbv gy3t qojq GEZDGNBVGY3TQOJQ").toString("ascii"), "12345678901234567890",
   "小写、空格、分组都认（用户是照着屏幕手抄的）");
eq(totp.base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ====").toString("ascii"), "12345678901234567890", "末尾的 = 补位不影响");
let threw = false;
try { totp.base32Decode("这不是base32!!"); } catch { threw = true; }
ok(threw, "反向对照：不是 base32 的串当场拒，不是默默解出一堆垃圾");

// ── ② RFC 4226 的 HOTP 标准向量（10 条，一条都不能少）────────────────────
console.log("\n② RFC 4226 HOTP 标准向量");
const HOTP_VECTORS = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
const key = Buffer.from("12345678901234567890", "ascii");
HOTP_VECTORS.forEach((want, counter) => {
  eq(totp.hotp(key, counter), want, `HOTP 计数器 ${counter} → ${want}`);
});
ok(totp.hotp(key, 0) !== totp.hotp(key, 1), "反向对照：换个计数器就换个码（不是恒定输出）");

// ── ③ RFC 6238 的 TOTP 标准向量 ───────────────────────────────────────────
// 文档给的是 8 位，这里比对后 6 位——我们这一档固定 6 位，取的是同一个数的尾巴。
// 这一节顺带把 64 位计数器验了：T=20000000000 那条的格号是 666666666，
// 早就越过 32 位，高半段写错的话只有这一条会挂，前面几条照样绿。
console.log("\n③ RFC 6238 TOTP 标准向量（含 64 位计数器那条）");
const TOTP_VECTORS = [
  [59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
  [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"],
];
for (const [sec, want8] of TOTP_VECTORS) {
  eq(totp.code(RFC_SECRET, sec * 1000), want8.slice(-6), `T=${sec} → ${want8.slice(-6)}（RFC 给的 8 位是 ${want8}）`);
}

// ── ④ 时间窗：松紧都得是有意的 ───────────────────────────────────────────
console.log("\n④ 时间窗 ±1 格");
const T = 1111111111 * 1000;
const cur = totp.code(RFC_SECRET, T);
const prev = totp.code(RFC_SECRET, T - 30000);
const next = totp.code(RFC_SECRET, T + 30000);
ok(totp.verify(RFC_SECRET, cur, { at: T }) !== null, "当前这一格当然过");
ok(totp.verify(RFC_SECRET, prev, { at: T }) !== null, "上一格也过（手机比服务器慢几秒是常态）");
ok(totp.verify(RFC_SECRET, next, { at: T }) !== null, "下一格也过（手机比服务器快几秒同理）");
ok(totp.verify(RFC_SECRET, totp.code(RFC_SECRET, T - 60000), { at: T }) === null,
   "再往前一格就不过了——反向对照：窗是 ±1，不是敞着的");
ok(totp.verify(RFC_SECRET, totp.code(RFC_SECRET, T + 60000), { at: T }) === null, "再往后一格也不过");
ok(totp.verify(RFC_SECRET, cur, { at: T, window: 0 }) !== null, "window: 0 时当前格仍过");
ok(totp.verify(RFC_SECRET, prev, { at: T, window: 0 }) === null, "window: 0 时上一格不过（窗口参数真的在起作用）");

// ── ⑤ 防重放的把手：verify 得告诉调用方「是哪一格」──────────────────────
console.log("\n⑤ 返回格号，不是 true");
const step = totp.verify(RFC_SECRET, cur, { at: T });
eq(step, Math.floor(T / 1000 / 30), "对上了返回的是格号本身");
ok(typeof step === "number", "返回的是数字不是布尔——调用方要靠它记住「这一格用过了」");
eq(totp.verify(RFC_SECRET, prev, { at: T }), Math.floor(T / 1000 / 30) - 1, "上一格返回的是上一格的号");

// ── ⑥ 垃圾输入一律 null，不抛 ────────────────────────────────────────────
// 这些串是从登录框直接来的，抛异常就等于给了一条把 500 打出来的路
console.log("\n⑥ 垃圾输入");
for (const bad of ["", null, undefined, "12345", "1234567", "abcdef", "12 34 56", {}, [], "000000000000"]) {
  ok(totp.verify(RFC_SECRET, bad, { at: T }) === null, `${JSON.stringify(bad)} → null（不抛）`);
}
ok(totp.verify("这不是密钥", cur, { at: T }) === null, "密钥本身是坏的也只返回 null，不抛");
eq(totp.verify(RFC_SECRET, " " + cur + " ", { at: T }), step, "前后空格擦掉还是认（用户从 app 里复制常带空格）");

// ── ⑦ 生成的密钥 ────────────────────────────────────────────────────────
console.log("\n⑦ generateSecret");
const s1 = totp.generateSecret(), s2 = totp.generateSecret();
eq(s1.length, 32, "20 字节编成 32 个 base32 字符");
ok(/^[A-Z2-7]+$/.test(s1), "只含 base32 字母表里的字符（用户要照着念）");
ok(s1 !== s2, "两次生成不一样（反向对照：不是写死的）");
ok(totp.verify(s1, totp.code(s1), {}) !== null, "自己生成的密钥自己验得过");
ok(totp.verify(s2, totp.code(s1), {}) === null, "反向对照：拿另一把密钥的码验不过");

// ── ⑧ otpauth:// 链接 ───────────────────────────────────────────────────
console.log("\n⑧ otpauth:// 链接");
const url = totp.otpauthURL("张三", s1);
ok(url.startsWith("otpauth://totp/"), "协议头对");
ok(url.includes("secret=" + s1), "带着密钥");
ok(/issuer=OpenWorkBuddy/.test(url), "带着 issuer（手机上那一行显示的就是它）");
ok(/algorithm=SHA1/.test(url) && /digits=6/.test(url) && /period=30/.test(url), "三个参数都写明，不靠对方猜默认值");
// 用户名里带冒号会把 issuer:account 这个格式劈坏，扫出来变成另一个账号名
const tricky = totp.otpauthURL("a:b", s1);
ok(!/\/OpenWorkBuddy:a:b\?/.test(tricky) && /%3A/.test(tricky), "用户名里的冒号被转义掉（不然 label 格式会被劈坏）");

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
