"use strict";
/**
 * 评测任务集 — 每个任务 = 固定题面 + 固定输入文件 + 机器判分。
 * 判分只认硬证据（文件存在、能跑通、数值精确、结构完整），绝不让模型自己给自己打分。
 * 新增任务：往 TASKS 里加一项即可，checks 返回 [{ name, ok, note }]。
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// 子进程跑 node 验证成果代码：桌面版里 execPath 是 Electron，必须 ELECTRON_RUN_AS_NODE
function runNode(args, cwd) {
  return spawnSync(process.execPath, args, {
    cwd, timeout: 15000, encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
}
const exists = (dir, name) => fs.existsSync(path.join(dir, name));
const read = (dir, name) => { try { return fs.readFileSync(path.join(dir, name), "utf8"); } catch { return ""; } };
const ck = (name, ok, note) => ({ name, ok: !!ok, note: note || "" });
// 成果 html 常见烂尾：写一半截断 / script 标签不配对（和 Goal 验收员的自动体检同一套判据）
function htmlIntact(t) {
  if (!t) return false;
  if (/<html[\s>]/i.test(t) && !/<\/html>/i.test(t)) return false;
  return (t.match(/<script[\s>]/gi) || []).length === (t.match(/<\/script>/gi) || []).length;
}

const SALES_CSV = "品类,金额\n水果,120\n蔬菜,80\n水果,99.5\n饮料,45\n蔬菜,60\n水果,141.5\n饮料,88\n蔬菜,69\n";

const TASKS = [
  {
    id: "js-func",
    name: "写函数并自测（代码）",
    prompt: "在当前目录写一个 fib.js，CommonJS 风格导出 module.exports = { fibonacci }。fibonacci(n) 用迭代实现，返回第 n 个斐波那契数（fibonacci(0)=0，fibonacci(1)=1）。写完自己运行验证一遍再收工。",
    checks(dir) {
      const out = [ck("fib.js 存在", exists(dir, "fib.js"))];
      const r = runNode(["-e", 'const{fibonacci}=require("./fib.js");const a=[fibonacci(0),fibonacci(1),fibonacci(10),fibonacci(20)];if(JSON.stringify(a)!==JSON.stringify([0,1,55,6765]))throw new Error("got "+a);console.log("OK")'], dir);
      out.push(ck("fibonacci(0/1/10/20) 全对", r.status === 0 && /OK/.test(r.stdout || ""), (r.stderr || "").slice(0, 120)));
      return out;
    },
  },
  {
    id: "csv-sum",
    name: "CSV 分类合计（数据）",
    prompt: "当前目录有 sales.csv（两列：品类,金额）。按品类合计金额，把结果写成 result.json，格式：{\"品类名\": 合计数字}，数字用 number 不要字符串。",
    inputs: { "sales.csv": SALES_CSV },
    checks(dir) {
      const out = [ck("result.json 存在", exists(dir, "result.json"))];
      let j = null;
      try { j = JSON.parse(read(dir, "result.json")); } catch {}
      out.push(ck("JSON 可解析", !!j));
      const want = { 水果: 361, 蔬菜: 209, 饮料: 133 };
      const good = j && Object.keys(want).every((k) => Math.abs(Number(j[k]) - want[k]) < 0.01);
      out.push(ck("三个品类合计精确（含小数）", good, j ? JSON.stringify(j).slice(0, 100) : ""));
      return out;
    },
  },
  {
    id: "fact-find",
    name: "多文件检索回答（事实）",
    prompt: "当前目录有 note1.txt 到 note5.txt 五个文件。逐个读完后回答：内容里提到「苹果」的文件一共有几个？分别是哪几个文件？",
    inputs: {
      "note1.txt": "今天买了苹果和香蕉，苹果很甜。",
      "note2.txt": "会议纪要：下周发布新版本，重点是性能优化。",
      "note3.txt": "购物清单：苹果、牛奶、面包。",
      "note4.txt": "跑步 5 公里，配速 6 分钟。",
      "note5.txt": "苹果发布会定在九月，先看直播再决定。",
    },
    checks(dir, finalText) {
      const t = String(finalText || "");
      return [
        ck("说对了数量（3 个）", /3\s*个|三个/.test(t)),
        ck("点名 note1/note3/note5", ["note1", "note3", "note5"].every((n) => t.includes(n))),
        ck("没把 note2/note4 算进去", !/note[24][^，。;\s]*(?:提到|包含|含|有)「?苹果/.test(t)),
      ];
    },
  },
  {
    id: "md-report",
    name: "结构化写作（文档）",
    prompt: "写一份《远程办公效率指南》保存为 guide.md：至少 3 个二级标题（##）章节、一个至少 3 行的 markdown 表格、一个要点列表。内容要实用，不要凑字。",
    checks(dir) {
      const t = read(dir, "guide.md");
      return [
        ck("guide.md 存在且非空", t.length > 200),
        ck("≥3 个二级标题", (t.match(/^## /gm) || []).length >= 3),
        ck("有 markdown 表格", /\|[\s:-]*-{3,}/.test(t)),
        ck("有要点列表", /^[-*] /m.test(t)),
      ];
    },
  },
  {
    id: "html-app",
    name: "单文件网页应用（前端）",
    prompt: "做一个单文件 todo.html 待办应用：输入框和添加按钮，列表项可勾选完成、可删除，数据存 localStorage，刷新不丢。所有代码（HTML/CSS/JS）都写在这一个文件里。",
    checks(dir) {
      const t = read(dir, "todo.html");
      return [
        ck("todo.html 存在且非空", t.length > 500),
        ck("有输入框和按钮", /<input/i.test(t) && /<button|onclick/i.test(t)),
        ck("用了 localStorage", /localStorage/.test(t)),
        ck("HTML 结构完整（无截断/标签配对）", htmlIntact(t)),
      ];
    },
  },
  {
    id: "fix-bug",
    name: "修 bug 不改测试（调试）",
    prompt: "当前目录 buggy.js 里的 sumRange(a, b) 应该返回 a 到 b（含两端）所有整数的和，现在结果不对。修复 buggy.js，然后运行 node test_buggy.js 确认输出 PASS。不许改 test_buggy.js。",
    inputs: {
      "buggy.js": 'function sumRange(a, b) {\n  let s = 0;\n  for (let i = a; i < b; i++) s += i;\n  return s;\n}\nmodule.exports = { sumRange };\n',
      "test_buggy.js": 'const assert = require("assert");\nconst { sumRange } = require("./buggy.js");\nassert.strictEqual(sumRange(1, 5), 15);\nassert.strictEqual(sumRange(3, 3), 3);\nassert.strictEqual(sumRange(0, 10), 55);\nconsole.log("PASS");\n',
    },
    prepare(dir) { this._testHash = read(dir, "test_buggy.js"); },
    checks(dir) {
      const r = runNode(["test_buggy.js"], dir);
      return [
        ck("test_buggy.js 跑通 PASS", r.status === 0 && /PASS/.test(r.stdout || ""), (r.stderr || "").slice(0, 120)),
        ck("测试文件未被篡改", read(dir, "test_buggy.js") === this._testHash),
      ];
    },
  },
  {
    id: "py-run",
    name: "写脚本并真的运行（Python）",
    prompt: "当前目录 numbers.txt 每行一个数。写 stats.py 读它算平均值，把结果（只写数字）写进 stats_out.txt。必须实际运行 stats.py，确认 stats_out.txt 生成了再收工。",
    inputs: { "numbers.txt": "12\n7\n33\n48\n20\n" },
    checks(dir) {
      const t = read(dir, "stats_out.txt").trim();
      return [
        ck("stats.py 存在", exists(dir, "stats.py")),
        ck("stats_out.txt 已生成（证明真跑了）", t.length > 0),
        ck("平均值正确（24）", Math.abs(parseFloat(t) - 24) < 0.01, t.slice(0, 40)),
      ];
    },
  },
  {
    id: "multi-step",
    name: "读数→算→出两份成果（链路）",
    prompt: "当前目录有 sales.csv（品类,金额）。三步走：1）算出合计金额最高的品类和它的合计值；2）生成 top.html 页面，醒目展示「本月冠军品类：XXX（合计 YYY 元）」；3）写 summary.md 用两三句话总结各品类表现。",
    inputs: { "sales.csv": SALES_CSV },
    checks(dir) {
      const h = read(dir, "top.html");
      const m = read(dir, "summary.md");
      return [
        ck("top.html 存在且写对冠军（水果 361）", /水果/.test(h) && /361/.test(h)),
        ck("top.html 结构完整", htmlIntact(h)),
        ck("summary.md 存在且非空", m.length > 50),
      ];
    },
  },
  {
    id: "csv-tricky",
    name: "带引号逗号的 CSV（解析陷阱）",
    prompt: "当前目录 orders.csv 是标准 CSV（字段含逗号时用双引号包起来）。算出总营业额（每行 单价×数量 之和），写进 revenue.txt，只写数字。",
    inputs: { "orders.csv": '品名,单价,数量\n"苹果,红富士",5.5,3\n香蕉,3.2,10\n"坚果礼盒,混合装",89,2\n牛奶,12.5,4\n' },
    checks(dir) {
      // 5.5*3 + 3.2*10 + 89*2 + 12.5*4 = 16.5+32+178+50 = 276.5；裸 split(",") 会把引号字段劈开算错
      const t = read(dir, "revenue.txt").trim();
      return [
        ck("revenue.txt 存在", t.length > 0),
        ck("总营业额精确（276.5）", Math.abs(parseFloat(t) - 276.5) < 0.01, t.slice(0, 40)),
      ];
    },
  },
  {
    id: "strict-format",
    name: "严格输出格式（指令遵从）",
    prompt: "当前目录 memo.txt 里散落着几个日期，写法不一。把所有日期抽出来，统一成 YYYY-MM-DD 格式，按时间升序，写成 dates.json（一个字符串数组，不要包对象、不要注释）。",
    inputs: { "memo.txt": "项目启动会定在2026年8月3日。上次验收是 03/15/2026（美式写法）。年底 2026-12-01 上线，别忘了 2026年1月20日 的年会总结。\n" },
    checks(dir) {
      let j = null;
      try { j = JSON.parse(read(dir, "dates.json")); } catch {}
      const want = ["2026-01-20", "2026-03-15", "2026-08-03", "2026-12-01"];
      return [
        ck("dates.json 是数组", Array.isArray(j)),
        ck("四个日期全对且升序", Array.isArray(j) && JSON.stringify(j) === JSON.stringify(want), j ? JSON.stringify(j).slice(0, 80) : ""),
      ];
    },
  },
  {
    id: "log-needle",
    name: "大文件捞针（检索定位）",
    // 300 行日志里只有一行 ERROR，藏着错误码；考真读文件而不是编造
    prompt: "当前目录 app.log 有几百行日志。找出其中唯一一行 ERROR 级别的日志，回答：它在第几行？错误码是什么？",
    inputs: (() => {
      const lines = [];
      for (let i = 1; i <= 300; i++) {
        if (i === 217) lines.push(`2026-08-23 14:${String(i % 60).padStart(2, "0")}:11 ERROR [payment] 扣款失败 code=EPAY_4417 order=88213`);
        else lines.push(`2026-08-23 14:${String(i % 60).padStart(2, "0")}:0${i % 10} INFO [web] GET /api/health 200 ${i}ms`);
      }
      return { "app.log": lines.join("\n") + "\n" };
    })(),
    checks(dir, finalText) {
      const t = String(finalText || "");
      return [
        ck("行号正确（217）", /217/.test(t)),
        ck("错误码正确（EPAY_4417）", /EPAY_4417/.test(t)),
      ];
    },
  },
];

module.exports = { TASKS };
