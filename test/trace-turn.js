// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 对话和执行追踪互相跳、消息时间、模型速度。跑法：node test/trace-turn.js
 * 定位按时间不按序号：trace 记的第几轮是数用户消息算的，遇到上下文压缩和插话会错位。
 */
const fs = require("fs");
const path = require("path");
const { mod } = require("./lib/mod");

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (x !== undefined ? "  ← " + JSON.stringify(x) : "")); } };
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
/** 从前端真源码里切出一个顶格函数 */
function cut(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error("找不到 " + name);
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end + 2);
}
const APP01 = read("public/js/app-01.js"), APP02 = read("public/js/app-02.js"), APP05 = read("public/js/app-05.js");

process.env.OPENWORKBUDDY_HOME = process.env.OPENWORKBUDDY_HOME || fs.mkdtempSync(path.join(require("os").tmpdir(), "owb-tt-"));
const { tokenTiming } = require(mod("agent"));

console.log("【1】模型速度");
const t = tokenTiming(1000, 1300, 2300, { completion: 11 });
ok(t.ttft_ms === 300, "TTFT = 发出到第一个 token");
ok(t.tpot_ms === 100 && t.tokens_per_s === 10, "TPOT 按第一个 token 之后算：1000ms / 10 个");
ok(tokenTiming(1000, 0, 2000, { completion: 5 }) === undefined, "★不流式的渠道留空★ 不拿总耗时冒充");
ok(JSON.stringify(tokenTiming(1000, 1200, 1500, { completion: 1 })) === '{"ttft_ms":200}', "只有一个 token 算不出 TPOT，TTFT 照给");
ok(JSON.stringify(tokenTiming(1000, 1200, 1500, null)) === '{"ttft_ms":200}', "渠道没回用量也不炸");

console.log("【2】消息时间");
const I18N = { getLang: () => "zh" };
const msgTimeText = new Function("I18N", cut(APP01, "msgTimeText") + "\nreturn msgTimeText;")(I18N);
const now = new Date(2026, 10, 5, 15, 0);
ok(msgTimeText(new Date(2026, 10, 5, 9, 7), now) === "09:07", "今天只写钟点", msgTimeText(new Date(2026, 10, 5, 9, 7), now));
ok(msgTimeText(new Date(2026, 10, 4, 23, 50), now) === "昨天 23:50", "按日历天算：昨晚 11 点是昨天");
ok(/11.*3/.test(msgTimeText(new Date(2026, 10, 3, 8, 0), now)) && !/2026/.test(msgTimeText(new Date(2026, 10, 3, 8, 0), now)), "同一年不写年份");
ok(/2025/.test(msgTimeText(new Date(2025, 10, 3, 8, 0), now)), "跨年写年份");
ok(msgTimeText("不是时间", now) === "", "坏数据不显示 Invalid Date");

console.log("【3】回复 → 执行记录");
const traceForTurn = new Function(cut(APP05, "traceForTurn") + "\nreturn traceForTurn;")();
const T = (id, s) => ({ id, startTime: new Date(s).toISOString() });
const list = [T("a", 1000000), T("b", 1060000), T("c", 1120000)];
const iso = (x) => new Date(x).toISOString();
ok(traceForTurn(list, iso(1059000), iso(1119000)) === "b", "落在这一轮和下一轮之间的那条");
ok(traceForTurn(list, iso(1119000), null) === "c", "最后一轮没有下一轮");
ok(traceForTurn(list, iso(2000000), null) === "", "★找不到就是找不到★ 不跳到别的任务上");

console.log("【4】执行记录 → 对话");
const turnIndexAt = new Function(cut(APP02, "turnIndexAt") + "\nreturn turnIndexAt;")();
const turns = [[{ at: iso(1000000) }], [{ at: iso(1060000) }], [{ at: iso(1120000) }]];
ok(turnIndexAt(turns, iso(1061000)) === 1, "时间落在第二轮");
ok(turnIndexAt(turns, iso(1059000)) === 1, "任务开跑比消息落盘早一点也算这一轮：留了余量");
ok(turnIndexAt(turns, iso(5000)) === null, "比第一轮还早：不乱跳");

console.log("【5】接线");
const agent = read("src/agent/agent.js"), server = read("server.js");
ok(/if \(ownsTrace && tr\.id\) emit\(\{ type: "trace"/.test(agent), "★trace 编号始终发★ 以前只有开了 Langfuse 才发，本地账本对不上号");
ok(agent.indexOf("asstEntry") < 0 && server.indexOf("asstEntry.done_at") < server.indexOf("await flushSessionSave(sessionId);\n  send({ type: \"done\" });"), "完成时间写在存盘之前");
ok(/data-a="trace"/.test(APP01) && /amPlatformOwner\(\) \? `<button class="ta-btn" data-a="trace"/.test(APP01), "回复下面有按钮，只给能看 trace 的人");
ok(/openSession\(trace\.sessionId, \{ at: trace\.startTime \}\)/.test(APP05), "trace 详情能回到对话");
ok(/bare\.replace\(\/\^外部引擎/.test(APP05), "外部引擎的前缀归到类型标签，名字不再被截成省略号");

console.log(`\n对话与执行追踪：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
