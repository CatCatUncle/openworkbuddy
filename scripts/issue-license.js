#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle)
"use strict";
/**
 * 签发商业授权码。只有作者用得上：私钥在作者自己机器上，不在仓库里。
 *
 *   node scripts/issue-license.js init                  生成签名钥匙（已有就不动）
 *   node scripts/issue-license.js pubkey                打印公钥（贴进 license.js 的 PUBLIC_KEYS）
 *   node scripts/issue-license.js issue --to "公司全称" [--scope internal] [--seats 50]
 *                                   [--days 365 | --until 2027-09-30] [--id OWB-2026-001] [--note "…"]
 *   node scripts/issue-license.js verify <授权码>       用仓库里的公钥验一遍
 *
 * 私钥默认放 ~/.config/openworkbuddy/license-signing-key.pem（权限 600），
 * 换地方用 OWB_LICENSE_KEY 指过去。**丢了就再也签不出能被老版本认的码**——
 * 只能生成一把新的、把新公钥追加进 license.js、发一版，老版本还是只认旧钥匙。所以备份一份。
 *
 * 每签一张，往私钥旁边的 issued-licenses.jsonl 记一行：给了谁、什么范围、什么时候到期。
 * 这本账也不进仓库——客户名单不是公开信息。
 *
 * 授权码格式：OWB1.<载荷 base64url>.<签名 base64url>，签的是前两段连同中间那个点。
 * 验签逻辑只有一份，在 license.js 里；这里 verify 直接调它，免得两边各写一套、慢慢长歪。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const KEY_FILE = process.env.OWB_LICENSE_KEY || path.join(os.homedir(), ".config", "openworkbuddy", "license-signing-key.pem");
const LEDGER = path.join(path.dirname(KEY_FILE), "issued-licenses.jsonl");
const SCOPES = ["internal", "service", "delivery", "oem", "all"];

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function pubkeyOf(priv) {
  return crypto.createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64");
}

function loadKey() {
  if (!fs.existsSync(KEY_FILE)) die(`还没有签名钥匙：${KEY_FILE}\n先跑 node scripts/issue-license.js init`);
  return crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
}

/** 参数拆成 { _: [位置参数], flags: {名: 值} }。--k v 和 --k=v 都认；后面没写值的给 true，由调用方去拦 */
function args(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const eq = a.indexOf("=");
    const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
    // 同一个参数写两遍，以前是后一个悄悄生效。离线码签出去收不回来，宁可停下来问
    if (Object.prototype.hasOwnProperty.call(out.flags, k)) die(`--${k} 写了两遍，留一个`);
    out.flags[k] = eq > 0 ? a.slice(eq + 1) : argv[i + 1] != null && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return out;
}

function day(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function init() {
  if (fs.existsSync(KEY_FILE)) {
    console.log(`钥匙已经在了，没动：${KEY_FILE}`);
    console.log("公钥：" + pubkeyOf(loadKey()));
    return;
  }
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(KEY_FILE, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  console.log(`已生成签名钥匙：${KEY_FILE}（只有你自己能读）`);
  console.log("公钥（贴进 license.js 的 PUBLIC_KEYS）：" + pubkeyOf(privateKey));
  console.log("记得备份这把私钥。丢了的话，已经发出去的版本再也认不了你新签的码。");
}

/** 签一张。单拿出来给测试用：测试传自己现造的钥匙，不碰作者那把 */
function sign(payload, privateKey) {
  const body = "OWB1." + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.sign(null, Buffer.from(body), privateKey);
  return body + "." + sig.toString("base64url");
}

/** issue 认的参数。打错一个字母（--util、--seat）以前是悄悄忽略，签出一张永久或不限席位的码 */
const ISSUE_FLAGS = ["to", "scope", "seats", "days", "until", "id", "note"];

function issue({ _: pos, flags: o }) {
  const unknown = Object.keys(o).filter((k) => !ISSUE_FLAGS.includes(k));
  if (unknown.length) die(`认不出的参数：${unknown.map((k) => "--" + k).join(" ")}\nissue 只认：${ISSUE_FLAGS.map((k) => "--" + k).join(" ")}`);
  // 值里带空格又没加引号，多出来的那几截会变成位置参数，以前直接丢掉——备注只签进去半句
  if (pos.length > 1) die(`多出来的参数：${pos.slice(1).join(" ")}（值里有空格的话加引号）`);
  const to = String(o.to || "").trim();
  if (!to || to === "true") die('要写授权给谁：--to "公司全称"');
  // 后面忘了写值的参数，args() 给的是 true。+true = 1：--days 空着会悄悄签出一张明天就到期的码，
  // --seats 空着就是 1 席——签给付了钱的人，他第二个同事一注册就挂待办
  for (const k of ["scope", "seats", "days", "until", "id"]) if (o[k] === true) die(`--${k} 后面要写一个值`);
  const scope = String(o.scope || "internal");
  if (!SCOPES.includes(scope)) die(`--scope 只认这几个：${SCOPES.join(" / ")}`);
  // 只认纯数字：以前 Math.floor 把 2.5 悄悄变成 2
  if (o.seats != null && !/^\d+$/.test(String(o.seats))) die("--seats 要写一个不小于 0 的整数（0 = 不限）");
  const seats = o.seats == null ? 0 : +o.seats;
  if (o.days != null && o.until != null) die("--days 和 --until 只能写一个");
  const now = new Date();
  let exp = "";
  if (o.until != null) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(o.until));
    // 往返一遍才知道日子是不是真的：new Date(2027, 1, 31) 会悄悄滚到 3 月 3 日
    const d = m && new Date(+m[1], +m[2] - 1, +m[3]);
    if (!d || day(d) !== o.until) die("--until 要写一个真实存在的日期，格式 YYYY-MM-DD");
    // 到期日当天还算有效（license.js 的 verify），所以今天可以，昨天不行
    if (o.until < day(now)) die(`--until ${o.until} 已经过去了，签出来就是一张过期的码`);
    exp = String(o.until);
  } else if (o.days != null) {
    if (!/^[1-9]\d*$/.test(String(o.days))) die("--days 要写一个正整数");
    exp = day(new Date(now.getTime() + +o.days * 86400000));
  }
  const payload = {
    id: String(o.id || `OWB-${day(now).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex")}`),
    to, scope, seats, iat: day(now), exp,
    ...(o.note && o.note !== true ? { note: String(o.note) } : {}),
  };
  const code = sign(payload, loadKey());
  fs.appendFileSync(LEDGER, JSON.stringify({ ...payload, issued_at: now.toISOString() }) + "\n", { mode: 0o600 });
  console.log(code);
  console.error(`\n已签发 ${payload.id} → ${to}（${scope}，${seats || "不限"} 席，${exp ? exp + " 到期" : "永久"}），记在 ${LEDGER}`);
}

function verifyCmd(code) {
  // 带 .js：macOS 上 "../license" 会先撞上 LICENSE（许可证全文），见 admin.js 顶上
  const license = require("../src/domains/account/license.js");
  const v = license.verify(code);
  if (!v.ok) die("验不过：" + v.error);
  console.log(JSON.stringify(v.license, null, 2));
}

if (require.main === module) {
  const o = args(process.argv.slice(2));
  const cmd = o._[0];
  if (cmd === "init") init();
  else if (cmd === "pubkey") console.log(pubkeyOf(loadKey()));
  else if (cmd === "issue") issue(o);
  else if (cmd === "verify") verifyCmd(o._[1] || "");
  else die("用法见文件头：init / pubkey / issue / verify");
}

module.exports = { sign };
