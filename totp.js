// @ts-check
/**
 * TOTP（RFC 6238）—— 二次验证的算术部分。
 *
 * 为什么自己写而不是装个库：这段东西一共就是「HMAC 一次、按最后 4 位取偏移、截 31 位、取模」，
 * 加上一个 base32。全在 node 自带的 crypto 里，装一个包反而多一处供应链面。
 * 但**自己写就必须拿 RFC 的标准向量对答案**——这类代码写错了不会报错，
 * 只会变成「有时候能过有时候不能过」，用户会以为是手机时间不准，查上半天。
 * 向量在 test/totp.js 里，RFC 4226 的 10 条 + RFC 6238 的 6 条，一条都不能少。
 *
 * 只做 SHA-1 / 6 位 / 30 秒这一档：Google Authenticator、1Password、微软那个，
 * 认的都是这一档。otpauth:// 里就算写了 algorithm=SHA256，好几个 app 也直接忽略——
 * 于是你这边算 SHA256、它那边算 SHA1，死活对不上。不给选，就不会有人踩。
 */
const crypto = require("crypto");

const STEP_SEC = 30; // 一格多长
const DIGITS = 6;

// ---------- base32（RFC 4648，不带 = 补位）----------
// 用它不是为了省事，是因为用户要**照着屏幕把这串敲进手机**（扫不了码的时候）。
// base64 里有大小写之分还有 +/，念都念不清楚；base32 全大写、只有 A-Z 和 2-7。
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  // 把用户手抄可能带进来的东西先擦掉：空格（app 常按 4 位分组显示）、= 补位、大小写
  const s = String(str || "").toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (!s || /[^A-Z2-7]/.test(s)) throw new Error("密钥不是合法的 base32");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---------- HOTP（RFC 4226）----------
function hotp(secretBuf, counter, digits = DIGITS) {
  const msg = Buffer.alloc(8);
  // 计数器是 64 位大端。JS 的位运算只有 32 位，高低两半分开写——
  // 直接 `counter >>> 32` 会得到 counter 本身（移位数按 mod 32 算），那是个经典坑
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = crypto.createHmac("sha1", secretBuf).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f; // 动态截断：偏移藏在最后一个字节的低 4 位
  const bin =
    ((mac[off] & 0x7f) << 24) | // 最高位要抹掉：留着的话不同语言对「符号位」的理解不一样
    ((mac[off + 1] & 0xff) << 16) |
    ((mac[off + 2] & 0xff) << 8) |
    (mac[off + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** 生成一把新密钥。20 字节 = 160 位，跟 HMAC-SHA1 的块长对齐，也是 RFC 4226 的建议值 */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** 当前这一格的码。传 at 是为了让测试能定住时间 */
function code(secret, at = Date.now()) {
  return hotp(base32Decode(secret), Math.floor(at / 1000 / STEP_SEC));
}

/**
 * 验一个码。
 *
 * @param window 前后各放几格。默认 1（±30 秒）——**不是随便定的**：
 *   手机时钟跟服务器差个十几秒很常见，卡到 0 就会有人反复输对却过不去；
 *   放太宽（比如 ±5）等于把每个码的有效期从 30 秒拉到 5 分半，
 *   别人从你肩后瞄一眼再慢慢敲也来得及。1 是这两头之间的常规取法。
 *
 * @returns 对上了返回那一格的序号（**调用方必须存下来防重放**），没对上返回 null。
 *   为什么返回格号而不是 true：一个码在它那 30 秒里可以被用无数次。
 *   有人在你背后看一眼、或者从日志里翻出来，30 秒内是可以重放的。
 *   调用方把上次用掉的格号记下来、只接受更大的，这条路才算堵上。
 */
function verify(secret, token, { at = Date.now(), window = 1 } = {}) {
  const t = String(token || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(t)) return null;
  let key;
  try {
    key = base32Decode(secret);
  } catch {
    return null;
  }
  const now = Math.floor(at / 1000 / STEP_SEC);
  for (let d = -window; d <= window; d++) {
    const step = now + d;
    if (step < 0) continue;
    // 逐格比，且用等时比较。== 会在第一个不同的字符上就返回，
    // 理论上能按耗时一位一位试出正确的码——6 位数字本来熵就不高，不值得留这个口子
    const want = Buffer.from(hotp(key, step));
    const got = Buffer.from(t);
    if (want.length === got.length && crypto.timingSafeEqual(want, got)) return step;
  }
  return null;
}

/**
 * 扫码用的 otpauth:// 链接。
 *
 * label 里那个冒号是 Google 定的格式（issuer:account），所以用户名和 issuer 里
 * 但凡自己带了冒号就会把它劈坏 —— encodeURIComponent 会把 : 编成 %3A，正好躲开。
 */
function otpauthURL(username, secret, issuer = "OpenWorkBuddy") {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(username)}`;
  const q = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SEC) });
  return `otpauth://totp/${label}?${q}`;
}

module.exports = { generateSecret, code, verify, otpauthURL, base32Encode, base32Decode, hotp, STEP_SEC, DIGITS };
