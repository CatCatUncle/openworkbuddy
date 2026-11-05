// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 服务商已经宣布下线的模型。
 *
 * 用户原话：「一些火山的模型设置之后发现根本没有办法用，可能官方下线啥的」。
 * 确实如此。方舟按批下线，到点接入点要么换成别的模型、要么直接关停，生图生视频不自动迁移。
 * 配好的型号在设置页里看着一切正常，直到任务跑到那一步才报错，而错误信息只说「模型不存在」。
 *
 * 这张表来自官方公告，核对日期见 CHECKED_AT：
 *   https://ark.volcengine.com/region:cn-beijing/docs/model-deprecation-notice
 *   https://ark.volcengine.com/region:cn-beijing/docs/model-deprecation-announcement-2025
 * 新一批公告出来时照格式加行，别改旧行。
 *
 * 只认完整型号：方舟的型号带日期后缀，别家对不上；deepseek-v4-pro 这种官方名不受影响。
 * 第四列是到期不迁移会怎样：
 *   off  直接关停  auto 自动换成官方指定的型号  tbd 官方还没定  keep 存量不受影响（只是不能新建）
 */
const CHECKED_AT = "2026-11-05";
const DAY = 86400000;
const WARN_DAYS = 45; // 离下线这么近就该提醒了：换型号要测效果，不是点一下的事

/** @type {Array<[string, string, string, string]>} [型号, 下线日, 建议换成, 到期处理] */
const TABLE = [
  ["doubao-lite-128k-240428", "2025-05-28", "doubao-1.5-pro-256k-250115", "auto"],
  ["doubao-lite-32k-240428", "2025-05-28", "doubao-1.5-lite-32k-250115", "auto"],
  ["doubao-lite-32k-240628", "2025-05-28", "doubao-1.5-lite-32k-250115", "auto"],
  ["doubao-lite-4k-browsing-intent-240615", "2025-05-28", "doubao-lite-4k-browsing-intent-240828", "auto"],
  ["doubao-pro-128k-240628", "2025-05-28", "doubao-1.5-pro-32k-250115", "auto"],
  ["doubao-pro-32k-240615", "2025-05-28", "doubao-1.5-pro-32k-250115", "auto"],
  ["doubao-pro-32k-browsing-240615", "2025-05-28", "doubao-pro-32k-browsing-241115", "auto"],
  ["doubao-pro-32k-character-240528", "2025-05-28", "doubao-1.5-pro-32k-character-250228", "auto"],
  ["doubao-pro-32k-functioncall-240515", "2025-05-28", "doubao-1.5-pro-32k-250115", "auto"],
  ["doubao-pro-32k-functioncall-240815", "2025-05-28", "doubao-1.5-pro-32k-250115", "auto"],
  ["doubao-pro-4k-character-240728", "2025-05-28", "doubao-1.5-pro-32k-character-250228", "auto"],
  ["doubao-pro-4k-functioncall-240615", "2025-05-28", "doubao-1.5-pro-32k-250115", "auto"],
  ["doubao-1.5-thinking-pro-m-250415", "2025-08-28", "doubao-seed-1.6-250615", "auto"],
  ["doubao-1.5-thinking-pro-vision-250415", "2025-08-28", "doubao-seed-1.6-250615", "auto"],
  ["doubao-1.5-ui-tars-250328", "2025-08-28", "doubao-seed-1.6-250615", "auto"],
  ["doubao-embedding-text-240515", "2025-08-28", "doubao-embedding-vision-250615", "auto"],
  ["doubao-embedding-vision-241215", "2025-08-28", "doubao-embedding-vision-250615", "auto"],
  ["doubao-lite-128k-240828", "2025-08-28", "eed-1.6-flash-250615", "auto"],
  ["doubao-lite-32k-character-241015", "2025-08-28", "eed-1.6-flash-250615", "auto"],
  ["doubao-lite-4k-character-240828", "2025-08-28", "eed-1.6-flash-250615", "auto"],
  ["doubao-pro-256k-240828", "2025-08-28", "doubao-seed-1.6-250615", "auto"],
  ["doubao-pro-256k-241115", "2025-08-28", "doubao-seed-1.6-250615", "auto"],
  ["doubao-pro-32k-240828", "2025-08-28", "doubao-seed-1.6-250615", "auto"],
  ["doubao-pro-32k-browsing-240828", "2025-08-28", "doubao-seed-1.6-250615", "auto"],
  ["doubao-pro-32k-character-240828", "2025-08-28", "doubao-seed-1.6-250615", "auto"],
  ["doubao-pro-32k-creation-241028", "2025-08-28", "doubao-seed-1.6-250615", "auto"],
  ["doubao-pro-32k-functioncall-241028", "2025-08-28", "doubao-seed-1.6-250615", "auto"],
  ["doubao-pro-32k-oracy-240928", "2025-08-28", "doubao-seed-1.6-250615", "auto"],
  ["doubao-seaweed-241128", "2025-08-28", "eedance-1.0-pro-250528", "off"],
  ["doubao-vision-lite-32k-241015", "2025-08-28", "eed-1.6-flash-250615", "auto"],
  ["doubao-vision-pro-32k-241028", "2025-08-28", "doubao-seed-1.6-250615", "auto"],
  ["doubao-vision-pro-32k-241215", "2025-08-28", "doubao-1.5-thinking-vision-pro-250428", "auto"],
  ["eek-r1-distill-qwen-32b-250120", "2025-08-28", "doubao-seed-1.6-250615", "auto"],
  ["eek-r1-distill-qwen-7b-250120", "2025-08-28", "eed-1.6-flash-250615", "auto"],
  ["character-241215", "2025-11-27", "character-250715", "auto"],
  ["deepseek-r1-250120", "2025-11-27", "deepseek-v3-1-250821", "auto"],
  ["deepseek-v3-241226", "2025-11-27", "deepseek-v3-1-250821", "auto"],
  ["doubao-1-5-pro-256k-250115", "2025-11-27", "doubao-seed-1-6-251015", "auto"],
  ["doubao-lite-32k-240828", "2025-11-27", "doubao-seed-1.6-flash-250828", "auto"],
  ["doubao-pro-32k-241215", "2025-11-27", "doubao-seed-1-6-251015", "auto"],
  ["doubao-pro-32k-browsing-241115", "2025-11-27", "doubao-seed-1-6-251015", "auto"],
  ["kimi-k2-250711", "2025-11-27", "kimi-k2-250905", "auto"],
  ["wan2-1-14b-flf2v-250417", "2025-11-27", "doubao-seedance-1-0-pro-250528", "auto"],
  ["wan2-1-14b-i2v-250225", "2025-11-27", "doubao-seedance-1-0-pro-250528", "auto"],
  ["wan2-1-14b-t2v-250225", "2025-11-27", "doubao-seedance-1-0-pro-250528", "auto"],
  ["doubao-lite-32k-character-250228", "2026-03-24", "doubao-seed-character-251128", "tbd"],
  ["doubao-lite-4k-browsing-intent-240828", "2026-03-24", "doubao-seed-2-0-mini-260215", "tbd"],
  ["doubao-seed3d-1-0-250928", "2026-03-24", "", "tbd"],
  ["gpt-oss-120b-250805", "2026-03-24", "doubao-seed-2-0-mini-260215", "tbd"],
  ["deepseek-v3-1-250821", "2026-03-31", "", "auto"],
  ["doubao-1-5-thinking-pro-250415", "2026-03-31", "doubao-seed-2-0-lite-260215", "auto"],
  ["doubao-1-5-thinking-pro-m-250428", "2026-03-31", "doubao-seed-2-0-lite-260215", "auto"],
  ["doubao-1-5-thinking-vision-pro-250428", "2026-03-31", "doubao-seed-2-0-lite-260215", "auto"],
  ["doubao-1-5-ui-tars-250428", "2026-03-31", "doubao-seed-2-0-lite-260215", "auto"],
  ["doubao-1-5-vision-lite-250315", "2026-03-31", "doubao-seed-2-0-lite-260215", "auto"],
  ["doubao-1-5-vision-pro-250328", "2026-03-31", "doubao-seed-2-0-lite-260215", "auto"],
  ["doubao-clasi-s2t-241215", "2026-03-31", "", "off"],
  ["doubao-embedding-large-text-240915", "2026-03-31", "doubao-embedding-vision-251215", "keep"],
  ["doubao-embedding-large-text-250515", "2026-03-31", "doubao-embedding-vision-251215", "keep"],
  ["doubao-embedding-text-240715", "2026-03-31", "doubao-embedding-vision-251215", "keep"],
  ["doubao-embedding-vision-250328", "2026-03-31", "doubao-embedding-vision-251215", "keep"],
  ["doubao-seed-1-6-flash-250715", "2026-03-31", "doubao-seed-2-0-mini-260215", "auto"],
  ["doubao-seed-1-6-thinking-250615", "2026-03-31", "doubao-seed-2-0-lite-260215", "auto"],
  ["doubao-seed-1-6-thinking-250715", "2026-03-31", "doubao-seed-2-0-lite-260215", "auto"],
  ["doubao-seededit-3-0-i2i-250628", "2026-03-31", "doubao-seedream-4-5-251128", "off"],
  ["kimi-k2-250905", "2026-03-31", "doubao-seed-2-0-lite-260215", "auto"],
  ["kimi-k2-thinking-251104", "2026-03-31", "doubao-seed-2-0-lite-260215", "auto"],
  ["deepseek-r1-250528", "2026-05-11", "doubao-seed-2-0-lite-260215", "auto"],
  ["deepseek-v3-250324", "2026-05-11", "doubao-seed-2-0-lite-260215", "auto"],
  ["doubao-1-5-pro-32k-character-250228", "2026-05-11", "doubao-seed-character-251128", "auto"],
  ["doubao-seed-1-6-lite-251015", "2026-05-11", "doubao-seed-2-0-mini-260215", "auto"],
  ["doubao-seed-1-8-251215", "2026-05-11", "doubao-seed-1-8-251228", "auto"],
  ["doubao-seedance-1-0-lite-i2v-250428", "2026-05-11", "doubao-seedance-2-0-fast-260128", "auto"],
  ["doubao-seedance-1-0-lite-t2v-250428", "2026-05-11", "doubao-seedance-2-0-fast-260128", "auto"],
  ["doubao-seedream-3-0-t2i-250415", "2026-05-11", "doubao-seedream-5-0-lite-260128", "auto"],
  ["deepseek-v3-2-251201", "2026-07-30", "deepseek-v4-flash-ga-260731", "auto"],
  ["deepseek-v4-flash-260425", "2026-09-21", "deepseek-v4-flash-ga-260731", "auto"],
  ["doubao-1-5-lite-32k-250115", "2026-09-21", "doubao-seed-2-0-mini-260428", "auto"],
  ["doubao-1-5-pro-32k-250115", "2026-09-21", "doubao-seed-2-0-lite-260428", "auto"],
  ["doubao-1-5-pro-32k-character-250715", "2026-09-21", "doubao-seed-character-260628", "auto"],
  ["doubao-1-5-vision-pro-32k-250115", "2026-09-21", "doubao-seed-2-0-lite-260428", "auto"],
  ["doubao-seed-1-6-250615", "2026-09-21", "doubao-seed-2-0-lite-260428", "auto"],
  ["doubao-seed-1-6-251015", "2026-09-21", "doubao-seed-2-0-lite-260428", "auto"],
  ["doubao-seed-1-6-flash-250615", "2026-09-21", "doubao-seed-2-0-mini-260428", "auto"],
  ["doubao-seed-1-6-flash-250828", "2026-09-21", "doubao-seed-2-0-mini-260428", "auto"],
  ["doubao-seed-1-6-vision-250815", "2026-09-21", "doubao-seed-2-0-lite-260428", "auto"],
  ["doubao-seed-1-8-251228", "2026-09-21", "doubao-seed-2-0-lite-260428", "auto"],
  ["doubao-seed-code-preview-251028", "2026-09-21", "doubao-seed-evolving", "auto"],
  ["doubao-seedance-1-5-pro-251215", "2026-09-21", "doubao-seedance-2-0-mini-260615", "off"],
  ["glm-4-7-251222", "2026-09-21", "glm-5-2-260617", "auto"],
  ["kimi-k2-5-260127", "2026-09-21", "doubao-seed-evolving", "auto"],
  ["doubao-seed-2-0-lite-260215", "2026-10-22", "doubao-seed-2-1-lite-260915", "auto"],
  ["doubao-seed-2-0-mini-260215", "2026-10-22", "doubao-seed-2-0-mini-260428", "auto"],
  ["deepseek-v4-pro-260425", "2026-11-24", "deepseek-v4-1-flash-260910", "tbd"],
  ["doubao-embedding-vision-250615", "2026-11-24", "doubao-embedding-vision-251215", "keep"],
  ["doubao-seed-2-0-code-preview-260215", "2026-11-24", "doubao-seed-evolving", "tbd"],
  ["doubao-seed-2-0-pro-260215", "2026-11-24", "doubao-seed-2-1-lite-260915", "tbd"],
  ["doubao-seedance-1-0-pro-250528", "2026-11-24", "doubao-seedance-2-0-mini-260615", "off"],
  ["doubao-seedance-1-0-pro-fast-251015", "2026-11-24", "doubao-seedance-2-0-mini-260615", "off"],
  ["doubao-seedream-4-0-250828", "2026-11-24", "doubao-seedream-4-0-20260415", "tbd"],
  ["doubao-seedream-4-5-251128", "2026-11-24", "doubao-seedream-5-0-pro-260628", "off"],
  ["doubao-seedream-5-0-260128", "2026-11-24", "doubao-seedream-5-0-pro-260628", "off"],
  ["doubao-seedream-5-0-lite-260128", "2026-11-24", "doubao-seedream-5-0-pro-260628", "off"],
  ["glm-5-1-260428", "2026-11-24", "doubao-seed-evolving", "tbd"],
];

const BY_ID = new Map(TABLE.map((r) => [r[0], r]));

/**
 * 这个型号的下线情况；不在表里返回 null。
 * @param {string} id
 * @param {number} [now]
 * @returns {null | { id: string, eos: string, to: string, onExpire: string, gone: boolean, soon: boolean, days: number }}
 */
function retirementOf(id, now = Date.now()) {
  const r = BY_ID.get(String(id || "").trim());
  if (!r) return null;
  const [mid, eos, first, onExpire] = r;
  // 官方当时建议的型号后来也可能下线了：顺着往下找到还活着的，别把人指向另一个死型号
  let to = first;
  for (let i = 0; i < 8; i++) {
    const n = BY_ID.get(to);
    if (!n || !n[2] || n[2] === to || n[3] === "keep") break;
    if (Date.parse(n[1] + "T23:59:59+08:00") > now) break;
    to = n[2];
  }
  // 公告按北京时间下午两点算，这里取当天结束：宁可晚半天说「已下线」，别把还能用的判死
  const end = eos ? Date.parse(eos + "T23:59:59+08:00") : NaN;
  const days = Number.isFinite(end) ? Math.ceil((end - now) / DAY) : Infinity;
  const gone = onExpire !== "keep" && days <= 0;
  return { id: mid, eos, to, onExpire, gone, soon: !gone && days <= WARN_DAYS, days };
}

/** 目录里还该不该推荐它：已下线、快下线、不能新建的都不再摆 */
function recommendable(/** @type {string} */ id, now = Date.now()) {
  const r = retirementOf(id, now);
  return !r || !(r.gone || r.soon || r.onExpire === "keep");
}

/**
 * 给人看的一句话。设置页、测试连接、任务报错共用一份，别各写各的。
 * @param {ReturnType<typeof retirementOf>} r
 */
function noteOf(r) {
  if (!r) return "";
  const next = r.to ? `，官方建议换成 ${r.to}` : "";
  if (r.onExpire === "keep") return `${r.id} 已停止新建接入点，存量还能用${next}。`;
  if (r.gone) return `${r.id} 已于 ${r.eos} 下线${next}。`;
  const after = r.onExpire === "off" ? "到期直接关停，不会自动迁移" : r.onExpire === "auto" ? "到期会自动换成官方指定的型号，效果可能变化" : "到期处理方式官方还没定";
  return `${r.id} 将在 ${r.eos} 下线（还有 ${r.days} 天），${after}${next}。`;
}

module.exports = { TABLE, CHECKED_AT, WARN_DAYS, retirementOf, recommendable, noteOf };
