// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 用户评测集（eval/custom-sets.js）。跑法：node test/eval-sets.js
 * 用户问：「评测集是不是能通过 csv excel txt 等格式上传」「或者软件里面设计评测集」。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.OPENWORKBUDDY_HOME = process.env.OPENWORKBUDDY_HOME || fs.mkdtempSync(path.join(os.tmpdir(), "owb-evset-"));
const S = require("../eval/custom-sets");

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (x !== undefined ? "  ← " + JSON.stringify(x).slice(0, 240) : "")); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-evset-t-"));
const dirOf = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };

(async () => {
  console.log("【1】标准的简写");
  const c = S.parseCriteria("结论先行:3；金额算对:!;有套话:-2\n语气礼貌");
  ok(c[0].weight === 3 && !c[0].must, "带权重");
  ok(c[1].must && c[1].weight === 5, "`!` 是必须项");
  ok(c[2].weight === -2, "负数是扣分项");
  ok(c[3].weight === 1 && c[3].text === "语气礼貌", "没写权重算 1");
  ok(S.parseCriteria("评分:12")[0].weight === 10, "权重封顶 10");

  console.log("【2】四种文件都导得进");
  const tpl = S.importFile("模板.csv", Buffer.from(S.templateCsv()));
  ok(!tpl.error && tpl.set.tasks.length === 2, "★下载的模板原样传回来能用★", tpl);
  const t0 = tpl.set.tasks[0];
  ok(t0.files["data.csv"].includes("2050") && t0.criteria.length === 3 && t0.criteria[1].must, "题目、输入文件、标准都解析对了", t0);
  ok(t0.expect.some((e) => e.type === "file" && e.name === "周报.md") && t0.expect.some((e) => e.type === "contains" && e.text === "2050"), "机器规则解析对了", t0.expect);

  const ExcelJS = require("exceljs");
  const book = new ExcelJS.Workbook();
  book.addWorksheet("题").addRows([["题目", "产物", "必须包含", "标准"], ["写周报", "周报.md", "销售额", "结论先行:3；数字对:!"], ["", "", "", ""], ["写邮件", "回复.txt", "", ""]]);
  const xlsx = S.importFile("题集.xlsx", Buffer.from(await book.xlsx.writeBuffer()));
  ok(!xlsx.error && xlsx.set.tasks.length === 2 && xlsx.set.name === "题集", "★Excel 真文件能导★ 空行跳过", xlsx);
  ok(xlsx.set.tasks[0].criteria[1].must, "Excel 里的标准也认");

  const txt = S.importFile("题.txt", Buffer.from("写一份周报\n产物：周报.md\n标准：结论先行:3\n\n写一封邮件\n必须包含：您好\n---\n总结这段话\n标准：简洁"));
  ok(!txt.error && txt.set.tasks.length === 3 && txt.set.tasks[0].prompt === "写一份周报", "TXT：一段一题，字段行不算题面", txt);
  const json = S.importFile("a.json", Buffer.from(JSON.stringify({ tasks: [{ prompt: "x", criteria: ["好:2"] }] })));
  ok(!json.error && json.set.tasks[0].criteria[0].weight === 2, "JSON 能导，标准可写成字符串", json);
  ok(/题目/.test(S.importFile("x.csv", Buffer.from("a,b\n1,2\n")).warnings.join("") + S.importFile("x.csv", Buffer.from("a,b\n1,2\n")).error), "没有「题目」列说清楚");
  const skip = S.importFile("x.csv", Buffer.from("题目,标准\n写点啥,好\n,没题目这行\n"));
  ok(skip.set.tasks.length === 1 && skip.warnings.length === 1, "缺题目的行跳过并告知", skip);

  console.log("【3】校验");
  const bad = (t) => S.validate(S.normalize({ tasks: [t] }));
  ok(/判不了分/.test(bad({ prompt: "x" })), "既没规则也没标准：判不了分");
  ok(/文件名不合法/.test(bad({ prompt: "x", criteria: ["好"], files: { "../../config.json": "x" } })), "★输入文件名带路径当场拒★ 不然能写到题目目录外面");
  ok(/路径不合法/.test(bad({ prompt: "x", expect: [{ type: "file", name: "../../config.json" }] })), "★判分规则也不许读目录外★");
  ok(/正则写错/.test(bad({ prompt: "x", expect: [{ type: "regex", pattern: "(" }] })), "坏正则当场说");
  ok(/最多/.test(S.validate(S.normalize({ tasks: Array.from({ length: 201 }, () => ({ prompt: "x", criteria: ["好"] })) }))), "题数有上限");
  const dup = S.normalize({ tasks: [{ id: "a", prompt: "x" }, { id: "a", prompt: "y" }] });
  ok(dup.tasks[0].id !== dup.tasks[1].id, "重复编号自动区分：工作目录按它建");

  console.log("【4】判分");
  const set = S.normalize({ tasks: [{ id: "a", prompt: "x", expect: [{ type: "file", name: "r.md" }, { type: "contains", text: "2050", file: "r.md" }, { type: "not_contains", text: "午饭", file: "r.md" }, { type: "reply_contains", text: "完成" }], criteria: [{ text: "好", weight: 2 }, { text: "有废话", weight: -1 }] }] });
  const task = S.toTasks(set)[0];
  ok(task.checks(dirOf("empty"), "").every((x) => !x.ok), "★空目录上一条都不许绿★ not_contains 不能白送分（方法论第八节）", task.checks(dirOf("empty2"), ""));
  const good = dirOf("good");
  fs.writeFileSync(path.join(good, "r.md"), "最高 2050");
  ok(task.checks(good, "已完成").every((x) => x.ok), "标准答案全过", task.checks(good, "已完成"));
  fs.writeFileSync(path.join(good, "r.md"), "最高 2050，午饭吃面");
  ok(task.checks(good, "已完成").filter((x) => !x.ok).length === 1, "写进不该写的就红");
  ok(task.rubric[1].startsWith("是否出现这个毛病"), "扣分项改写成问句：评委的 true 永远是这句话成立");
  const onlyCrit = S.toTasks(S.normalize({ tasks: [{ prompt: "x", criteria: ["好"] }] }))[0];
  ok(onlyCrit.checks(dirOf("e3"), "").length === 1 && onlyCrit.rubric.length === 1, "只有标准的题：机器线不挡路");

  console.log("【5】权重算分");
  const cr = [{ weight: 3 }, { weight: 2, must: true }, { weight: -2 }];
  const w = (...p) => S.weightedScore(cr, p.map((x) => (x === null ? null : { pass: x })));
  ok(w(true, true, false).pct === 100, "全做到、没毛病：100");
  ok(w(true, true, true).pct === 60, "出了毛病扣分：(3+2-2)/5 = 60");
  ok(w(false, true, false).pct === 40, "没做到的不得分");
  ok(w(true, false, false).gate_failed && !w(true, false, false).pass, "★必须项没过就不及格★ 分再高也不算");
  ok(w(false, false, true).pct === 0, "扣到负数按 0");
  ok(w(true, null, false).judged === 2 && w(true, null, false).pct === 100, "★没判的不进分母★ 不知道不等于没做到");
  ok(S.weightedScore(cr, []) === null, "一条都没判：没有分，不是 0 分");

  console.log("【6】一致性");
  ok(S.cohenKappa([[true, true], [false, false], [true, true], [false, false]]) === 1, "全一致 = 1");
  const lazy = [...Array(9).fill([true, true]), [false, true]];
  ok(S.cohenKappa(lazy) === 0, "★闭眼全判达标：一致率九成，kappa 是 0★", S.cohenKappa(lazy));
  ok(S.cohenKappa([[true, true]]) === null, "样本太少不给数");

  console.log("【7】存取");
  const saved = S.save({ name: "我的题", tasks: [{ prompt: "x", criteria: ["好"] }] });
  ok(!saved.error && S.load(saved.set.id).name === "我的题" && S.list().some((s) => s.id === saved.set.id), "存得下读得回");
  ok(S.load("../../config") === null, "id 不许穿路径");
  S.remove(saved.set.id);
  ok(S.load(saved.set.id) === null, "删得掉");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n用户评测集：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
