"use strict";
/**
 * 内网 / 私有化模式。
 *
 * 不少客户是国央企，机器上不去外网——注意这不是"慢"，是防火墙**默默把包丢掉**、不回 RST，
 * 于是所有超时都得等满，用户看到的是长时间卡住而不是干脆的报错。还有一些明确要求
 * 不用国外组件、整套私有化部署在内网里。
 *
 * 这个开关打开之后，凡是"要能连上境外才用得了"的东西一律标出来并排到后面，
 * 别让用户填完 Key、等上几十秒，再对着一个 fetch failed 发呆。
 *
 * 三个来源，优先级从高到低：
 *   1. 环境变量 OPENWORKBUDDY_INTRANET=1 / true / on  —— 私有化部署最省事（Docker、systemd 里加一行）
 *      （旧名 OWB_INTRANET 继续认，见下面 isIntranet 里那段）
 *   2. config.json 里 { "intranet": true }
 *   3. 都没有 → 关
 * 显式写 0 / false / off 的优先级同样最高，用来在一台设了全局变量的机器上单独关掉。
 */
const fs = require("fs");
const { dataPath } = require("./paths");

const ON = /^(1|true|on|yes)$/i;
const OFF = /^(0|false|off|no)$/i;

/** 读开关。两个入参都可注入，方便测试，也方便调用方把已经读好的 config 传进来别重复读盘 */
function isIntranet({ env = process.env, cfg = null } = {}) {
  // 新名字是 OPENWORKBUDDY_INTRANET，跟别的环境变量一个前缀；OWB_INTRANET 是旧名，认但不再写进文档。
  // 为什么不直接删掉旧名：它已经写在别人的 systemd / docker-compose 里了，改名当天悄悄失效的话，
  // 那台连不上外网的机器会重新变回「一切正常」的样子——用户填完 Key、等到超时才知道出不去。
  const raw = String((env && (env.OPENWORKBUDDY_INTRANET || env.OWB_INTRANET)) || "").trim();
  if (ON.test(raw)) return true;
  if (OFF.test(raw)) return false;     // 显式关掉，不再往下看 config
  let c = cfg;
  if (c === null) {
    // 配置文件坏了/没有，不是打开内网模式的理由——默认关，跟没配过一样
    try { c = JSON.parse(fs.readFileSync(dataPath("config.json"), "utf8")); } catch { c = {}; }
  }
  return (c && c.intranet) === true;
}

module.exports = { isIntranet };
