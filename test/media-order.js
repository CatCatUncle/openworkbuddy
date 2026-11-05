// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 模型下线登记（retired-models.js）和生图生视频按顺序回退。跑法：node test/media-order.js
 * 用户原话：「一些火山的模型设置之后发现根本没有办法用」「设置多个的时候按照顺序去尝试」。
 * 回退最怕的不是不换，是**换错**：已下单的再发一单是重复扣费，被审核拦的换模型重发是绕审核。
 */
const { mod } = require("./lib/mod");
const r = require(mod("retired-models"));
const mm = require(mod("media-models"));
const mh = require(mod("media-health"));

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } };
const NOW = Date.parse("2026-11-05T12:00:00+08:00");

console.log("【1】登记表本身没错位");
ok(r.TABLE.length >= 100, `官方公告 ${r.TABLE.length} 条`);
ok(r.TABLE.every(([id, eos, to]) => id !== to), "★没有一条建议换成它自己★ 解析错位时就长这样");
ok(r.TABLE.every(([, eos]) => /^\d{4}-\d{2}-\d{2}$/.test(eos)), "每条都有下线日");
ok(new Set(r.TABLE.map((x) => x[0])).size === r.TABLE.length, "没有重复");
ok(r.retirementOf("doubao-seedance-2-0-fast-260128") === null, "★迁移目标不算下线★ 这条曾被错判过");
ok(r.retirementOf("deepseek-v4-pro") === null && r.retirementOf("") === null, "官方名、空串不受影响");

console.log("【2】判定");
const soon = r.retirementOf("doubao-seedream-4-5-251128", NOW);
ok(soon && soon.soon && !soon.gone && soon.onExpire === "off", "快下线：还能用但要提醒，到期直接关停");
ok(/不会自动迁移/.test(r.noteOf(soon)) && /seedream-5-0-pro/.test(r.noteOf(soon)), "一句话说清后果和换谁");
const gone = r.retirementOf("doubao-seedream-4-5-251128", Date.parse("2026-12-01T00:00:00+08:00"));
ok(gone.gone && /已于/.test(r.noteOf(gone)), "过了日子判已下线");
ok(!r.retirementOf("doubao-seedream-4-5-251128", Date.parse("2026-11-24T10:00:00+08:00")).gone, "当天不判死：宁可晚半天");
const keep = r.retirementOf("doubao-embedding-vision-250615", NOW);
ok(keep && !keep.gone && /存量还能用/.test(r.noteOf(keep)), "只停新建的不说成下线");
const chain = r.retirementOf("deepseek-r1-250528", NOW);
ok(chain && chain.to !== "doubao-seed-2-0-lite-260215", "★建议的型号也下线了就接着往下找★ 别把人指向另一个死型号：" + chain.to);

console.log("【3】目录不推荐");
ok(!mm.catalogFor("image", "ark").some((m) => m.id === "doubao-seedream-4-5-251128"), "快关停的不进目录");
for (const cap of Object.keys(mm.CATALOG)) ok(mm.catalogFor(cap).every((m) => r.recommendable(m.id)), `${cap} 目录里没有已下线的`);

console.log("【4】什么失败才换下一个");
const E = (content, more) => ({ content, isError: true, ...more });
ok(mh.worthNextModel(E("接口错误 404：ModelNotOpen")), "型号没了：换");
ok(mh.worthNextModel(E("接口错误 402 余额不足")), "没余额：换");
ok(mh.worthNextModel(E("接口错误 429 限流")), "限流：换");
ok(mh.worthNextModel(E("接口错误 503")), "服务挂了：换");
ok(mh.worthNextModel(E("【图像模型这条渠道已暂停】", { mediaBreaker: true })), "本地熔断：换");
ok(!mh.worthNextModel(E("等结果超时", { submitted: "task_1" })), "★已下单：不换★ 再发就是第二单");
ok(!mh.worthNextModel(E("上游已经收下这一单（任务号 x），接口错误 503")), "★文案里说收下了也不换★");
ok(!mh.worthNextModel(E("接口错误 400 InputImageSensitiveContentDetected.PrivacyInformation")), "★内容被拦：不换★ 换模型重发是绕审核");
ok(!mh.worthNextModel(E("接口错误 400 尺寸不合法")), "参数错：不换，下一个照样错");
ok(!mh.worthNextModel(E("用户已停止", { stopped: true })), "用户停的：不换");
ok(!mh.worthNextModel({ content: "ok", isError: false }), "成功了：不换");

console.log("【5】回退顺序");
const media = { list: [
  { id: "a", cap: "image", name: "主力", model: "m1", base_url: "u1" },
  { id: "b", cap: "image", name: "备用", model: "m2", base_url: "u2" },
  { id: "c", cap: "video", name: "视频", model: "v1", base_url: "u3" },
  { id: "d", cap: "image", name: "没配完", model: "", base_url: "u4" },
  { id: "e", cap: "image", name: "已下线", model: "doubao-seedream-3-0-t2i-250415", base_url: "u5" },
  { id: "f", cap: "image", name: "第三", model: "m3", base_url: "u6" },
] };
const order = mm.fallbackOrder(media, "image", media.list[0]).map((m) => m.name);
ok(order.join() === "备用,第三", "同能力、按设置顺序、跳过试过的、没配完的、已下线的：" + order.join());

console.log(`\n下线登记与回退：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
