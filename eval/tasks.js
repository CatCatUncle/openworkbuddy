"use strict";
/**
 * 评测任务集 — 每个任务 = 固定题面 + 固定输入文件 + 机器判分。
 * 判分只认硬证据（文件存在、能跑通、数值精确、结构完整），绝不让模型自己给自己打分。
 * 新增任务：往 TASKS 里加一项即可，checks 返回 [{ name, ok, note }]。
 *
 * 题面可选字段（都不写就是最老实的单轮题）：
 *   turns      一串用户消息，一轮一轮喂，历史接着上一轮——考「第一轮立的规矩到第三轮还守不守」
 *   memories   开跑前种进长期记忆的条目，题面里绝不重复它们——考召回
 *   max_steps  只给这道题抬步数上限（只抬不降），长任务题用
 *   timeout_ms 同理，只给这道题抬时间上限
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
    level: 1, kind: "代码",
    rubric: [
      "用迭代（循环）实现，没有用递归",
      "智能体真的自己运行验证过（回复或过程里有运行证据）",
      "代码整洁，没有多余文件或无关内容",
    ],
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
    level: 1, kind: "数据",
    rubric: [
      "计算方式可靠（写代码算而不是心算/编造）",
      "JSON 里没有多余的包装、注释或额外字段",
    ],
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
    level: 1, kind: "检索",
    rubric: [
      "真的逐个读了五个文件（不是只读了部分就作答）",
      "回答明确不含糊（直接给出数量和文件名）",
    ],
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
        // 纯否定的断言要先钉住「真答了话」：崩了一个字没输出的时候，这条本来是白送的
        ck("没把 note2/note4 算进去", !!t.trim() && !/note[24][^，。;\s]*(?:提到|包含|含|有)「?苹果/.test(t)),
      ];
    },
  },
  {
    id: "md-report",
    name: "结构化写作（文档）",
    level: 1, kind: "写作",
    rubric: [
      "建议具体可执行（有工具名/做法/频率，不是空话）",
      "没有车轱辘话和凑字的正确废话",
      "表格和列表用得恰当（内容适合这种形式，不是硬凑结构）",
    ],
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
    level: 2, kind: "网页",
    rubric: [
      "添加、勾选完成、删除三个功能的代码逻辑都真实实现了（不是只有壳）",
      "localStorage 读写配对，刷新后能恢复数据",
      "界面有基本样式，不是裸 HTML",
    ],
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
    level: 1, kind: "调试",
    rubric: [
      "改动最小（只动了循环边界，没有整篇重写）",
      "真的运行了测试确认 PASS（有运行证据）",
    ],
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
    level: 1, kind: "代码",
    rubric: [
      "stats.py 逻辑通用（不是把答案硬编码进去）",
      "真的运行了脚本（stats_out.txt 是运行产物而不是手写的）",
    ],
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
    level: 2, kind: "综合",
    rubric: [
      "top.html 展示醒目（有样式设计，不是一行裸文本）",
      "summary.md 有信息量（比较了各品类，不是复读数字）",
      "三步都完成了，没有漏环节",
    ],
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
    level: 2, kind: "数据",
    rubric: [
      "正确处理了带引号逗号的 CSV 字段（不是裸 split）",
      "用代码计算而不是心算",
    ],
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
    level: 2, kind: "格式",
    rubric: [
      "严格遵从了输出格式（纯数组、无包装、无注释）",
      "四种不同写法的日期都识别并归一了",
    ],
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
    level: 2, kind: "检索",
    rubric: [
      "看得出是真检索到的（引用了那行日志或说明了查找方法）",
      "回答直接明确（行号和错误码一次给全）",
    ],
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
  {
    id: "gen-diagram",
    name: "画架构图（作图工具）",
    prompt: "用 gen_diagram 工具画一张「三层 Web 架构」示意图：浏览器 → Nginx → 应用服务（Node.js）→ 数据库（PostgreSQL），另有 Redis 缓存挂在应用服务旁边。kind 用 dot，filename 用 arch。不要自己手写 SVG 文件。",
    level: 2, kind: "画图",
    rubric: [
      "五个节点齐全且箭头方向正确（主链路 浏览器→Nginx→应用→数据库）",
      "Redis 是旁挂在应用服务上，没有串进主链路",
    ],
    checks(dir) {
      const t = read(dir, "arch.svg");
      return [
        ck("arch.svg 存在且是 SVG", /<svg[\s>]/i.test(t)),
        ck("关键节点齐全（Nginx/Redis/PostgreSQL）", ["Nginx", "Redis", "PostgreSQL"].every((k) => t.includes(k))),
        ck("是 graphviz 渲染的（非手写）", /Generated by graphviz|class="graph"/i.test(t)),
      ];
    },
  },
  {
    id: "refactor-multi",
    name: "跨文件重构去重（代码·难）",
    level: 3, kind: "代码",
    rubric: [
      "重构后职责清晰（utils.js 只放共享逻辑，两个模块只引用不复制）",
      "改动克制（没有顺手重写无关代码）",
      "真的运行了 main.js 验证输出",
    ],
    prompt: "当前目录 circle.js 和 rect.js 里各自复制了一份 round2 辅助函数，其中 rect.js 那份有 bug（只保留 1 位小数）。重构：把 round2 抽到新文件 utils.js（module.exports = { round2 }，保留 2 位小数），circle.js 和 rect.js 都改为 require 它，删掉各自的本地副本。不许改 main.js。完成后运行 node main.js，确认输出 [3.14,7.16] 再收工。",
    inputs: {
      "circle.js": 'function round2(x) {\n  return Math.round(x * 100) / 100;\n}\nfunction area(r) {\n  return round2(Math.PI * r * r);\n}\nmodule.exports = { area };\n',
      "rect.js": 'function round2(x) {\n  return Math.round(x * 10) / 10;\n}\nfunction area(w, h) {\n  return round2(w * h);\n}\nmodule.exports = { area };\n',
      "main.js": 'const c = require("./circle.js");\nconst r = require("./rect.js");\nconsole.log(JSON.stringify([c.area(1), r.area(2.15, 3.33)]));\n',
    },
    prepare(dir) { this._mainHash = read(dir, "main.js"); },
    checks(dir) {
      const r = runNode(["main.js"], dir);
      const cj = read(dir, "circle.js");
      const rj = read(dir, "rect.js");
      return [
        ck("main.js 输出正确（[3.14,7.16]）", r.status === 0 && (r.stdout || "").includes("[3.14,7.16]"), ((r.stderr || r.stdout) || "").slice(0, 120)),
        ck("utils.js 存在且导出 round2", /round2/.test(read(dir, "utils.js")) && /module\.exports/.test(read(dir, "utils.js"))),
        ck("两个模块都改为引用 utils", /require\(["'][.][/]utils/.test(cj) && /require\(["'][.][/]utils/.test(rj)),
        // 同样先钉住「文件还在」：把 circle.js 和 rect.js 直接删了，副本自然也就"删干净"了
        ck("本地 round2 副本已删干净", !!cj && !!rj && !/function\s+round2/.test(cj) && !/function\s+round2/.test(rj)),
        ck("main.js 未被篡改", read(dir, "main.js") === this._mainHash),
      ];
    },
  },
  {
    id: "data-join",
    name: "两表关联+缺数处理（数据·难）",
    level: 3, kind: "数据",
    rubric: [
      "缺价品类的处理方式正确（跳过并如实记录，而不是编个价格或让程序崩掉）",
      "用代码做关联计算而不是心算",
    ],
    // 水果 (10+4)*5.5=77 · 蔬菜 6*3=18 · 饮料 8*4.25=34；礼盒没有单价，必须跳过并记录
    prompt: "当前目录有 orders2.csv（品类,数量）和 prices.csv（品类,单价）。按品类关联两表算出每个品类的销售额（数量合计×单价），写成 join.json（{\"品类\": 金额number}）。凡是在价格表里查不到单价的品类，不要算也不要编价格，把品类名逐行写进 missing.txt。",
    inputs: {
      "orders2.csv": "品类,数量\n水果,10\n蔬菜,6\n饮料,8\n礼盒,2\n水果,4\n",
      "prices.csv": "品类,单价\n水果,5.5\n蔬菜,3\n饮料,4.25\n",
    },
    checks(dir) {
      let j = null;
      try { j = JSON.parse(read(dir, "join.json")); } catch {}
      const want = { 水果: 77, 蔬菜: 18, 饮料: 34 };
      const good = j && Object.keys(want).every((k) => Math.abs(Number(j[k]) - want[k]) < 0.01);
      return [
        ck("join.json 可解析", !!j),
        ck("三个品类销售额精确（77/18/34）", good, j ? JSON.stringify(j).slice(0, 100) : ""),
        ck("礼盒没被硬算进 join.json", !!j && !("礼盒" in j)),
        ck("missing.txt 记录了礼盒", /礼盒/.test(read(dir, "missing.txt"))),
      ];
    },
  },
  {
    id: "pipeline-audit",
    name: "日志管线三件套（综合·难）",
    level: 3, kind: "综合",
    rubric: [
      "三份产物的数字互相一致（summary 里引用的就是 stats 算出的）",
      "summary.md 有诊断价值（指出了错误集中在哪，不是复读数字）",
    ],
    // 6 行 5xx，耗时 120/80/200/40/310/150 → count=6, avg=150
    prompt: "当前目录 access.log 是访问日志（最后一列是耗时 ms）。三步走：1）把所有状态码为 5xx 的行原样抽到 errors.txt（一行一条，别的行不要）；2）统计 5xx 的条数和平均耗时，写成 stats.json（{\"count\": 数量, \"avg_ms\": 平均耗时}，都是 number）；3）写 summary.md 简述这批错误的情况，数字要和 stats.json 一致。",
    inputs: (() => {
      const lines = [];
      const err = { 30: 120, 55: 80, 90: 200, 130: 40, 170: 310, 190: 150 };
      for (let i = 1; i <= 200; i++) {
        const mm = String(i % 60).padStart(2, "0");
        if (err[i]) lines.push(`2026-08-24 10:${mm}:00 POST /api/pay 502 ${err[i]}ms`);
        else lines.push(`2026-08-24 10:${mm}:00 GET /api/list 200 ${(i % 30) + 5}ms`);
      }
      return { "access.log": lines.join("\n") + "\n" };
    })(),
    checks(dir) {
      const e = read(dir, "errors.txt").trim();
      const errLines = e ? e.split("\n").filter((l) => l.trim()) : [];
      let j = null;
      try { j = JSON.parse(read(dir, "stats.json")); } catch {}
      const m = read(dir, "summary.md");
      return [
        ck("errors.txt 恰好 6 条且都是 5xx", errLines.length === 6 && errLines.every((l) => /\s50\d\s/.test(l)), `抽到 ${errLines.length} 条`),
        ck("stats.json 数字精确（count=6, avg_ms=150）", !!j && j.count === 6 && Math.abs(Number(j.avg_ms) - 150) < 0.01, j ? JSON.stringify(j).slice(0, 80) : ""),
        ck("summary.md 引用的数字一致", /6/.test(m) && /150/.test(m) && m.length > 50),
      ];
    },
  },
  {
    id: "long-haul",
    name: "十二张单子照规范逐张处理（长任务·难）",
    level: 3, kind: "长任务",
    // 三十步开外还守不守得住第三步读到的那份规范——这是长任务唯一值得考的事。
    // 规范故意放在文件里而不是题面里：题面那句话在历史开头，多半不会被裁掉，
    // 裁掉的是中间那堆工具输出，规范就在那里面
    max_steps: 60,
    timeout_ms: 720000,
    rubric: [
      "十二张单子是逐张看过的（分类判断有依据，不是一把梭批量套模板）",
      "收工前自己核对过合计和分类数，不是写完就说完成了",
    ],
    prompt: "当前目录有一份 规范.md 和十二张单子 order-01.txt ~ order-12.txt。先读规范，然后照规范把十二张单子逐张处理，每张写一个 out-NN.json（NN 和单子编号对应），最后把各分类的人民币合计汇总成 total.json（格式：{\"分类名\": 合计数字}）。规范里的要求从头到尾都算数。",
    inputs: (() => {
      const spec = [
        "# 单据处理规范",
        "",
        "1. 单号里的字母一律转成**大写**（单子里写的是小写）。",
        "2. 金额一律换算成人民币，保留两位小数。美元按 1 USD = 7.2 CNY 换算，人民币的不用换。",
        "3. 分类只有三种：水果 / 蔬菜 / 饮料。按摘要判断是哪一种。",
        "4. **判不进这三类的，分类写「未分类」。任何产物里都不许出现「其他」这两个字。**",
        "5. 每张单子写一个 out-NN.json，格式：{\"单号\": \"大写单号\", \"分类\": \"分类名\", \"金额_人民币\": 数字}。",
        "",
      ].join("\n");
      const rows = [
        ["a1001", "买了三斤苹果和两个梨", "USD", "12.5"],
        ["a1002", "采购一箱矿泉水", "CNY", "36"],
        ["a1003", "西红柿和黄瓜各两斤", "CNY", "18.5"],
        ["a1004", "打印机墨盒一个", "USD", "20"],
        ["a1005", "香蕉五斤", "CNY", "22"],
        ["a1006", "可乐两听", "USD", "1.5"],
        ["a1007", "土豆十斤", "CNY", "15"],
        ["a1008", "橙汁一瓶", "CNY", "8.8"],
        ["a1009", "西瓜一个", "USD", "5"],
        ["a1010", "菠菜三把", "CNY", "6.5"],
        ["a1011", "办公椅一把", "USD", "45"],
        ["a1012", "葡萄两斤", "CNY", "27.6"],
      ];
      const out = { "规范.md": spec };
      rows.forEach(([no, memo, cur, amt], i) => {
        out["order-" + String(i + 1).padStart(2, "0") + ".txt"] = `单号: ${no}\n摘要: ${memo}\n币种: ${cur}\n金额: ${amt}\n`;
      });
      return out;
    })(),
    checks(dir) {
      const want = [
        ["A1001", "水果", 90], ["A1002", "饮料", 36], ["A1003", "蔬菜", 18.5], ["A1004", "未分类", 144],
        ["A1005", "水果", 22], ["A1006", "饮料", 10.8], ["A1007", "蔬菜", 15], ["A1008", "饮料", 8.8],
        ["A1009", "水果", 36], ["A1010", "蔬菜", 6.5], ["A1011", "未分类", 324], ["A1012", "水果", 27.6],
      ];
      const got = want.map((_, i) => {
        try { return JSON.parse(read(dir, "out-" + String(i + 1).padStart(2, "0") + ".json")); } catch { return null; }
      });
      const have = got.filter(Boolean).length;
      const noOK = got.filter((j, i) => j && String(j["单号"]) === want[i][0]).length;
      const clsOK = got.filter((j, i) => j && String(j["分类"]) === want[i][1]).length;
      const amtOK = got.filter((j, i) => j && Math.abs(Number(j["金额_人民币"]) - want[i][2]) < 0.011).length;
      let total = null;
      try { total = JSON.parse(read(dir, "total.json")); } catch {}
      const wantTotal = { 水果: 175.6, 饮料: 55.6, 蔬菜: 40, 未分类: 468 };
      const totalOK = total && Object.keys(wantTotal).every((k) => Math.abs(Number(total[k]) - wantTotal[k]) < 0.011)
        && Object.keys(total).length === 4;
      // 「其他」这两个字扫一遍所有产物：规范第 4 条就是冲着它去的
      const spilled = fs.readdirSync(dir).filter((n) => /^(out-\d+|total)\.json$/.test(n) && read(dir, n).includes("其他"));
      return [
        ck("十二张单子都有产物", have === 12, `只有 ${have} 张`),
        ck("单号全大写（规范第 1 条）", noOK === 12, `对 ${noOK}/12`),
        ck("分类判对（含两张归「未分类」）", clsOK === 12, `对 ${clsOK}/12`),
        ck("美元按 7.2 换算且保留两位（规范第 2 条）", amtOK === 12, `对 ${amtOK}/12`),
        ck("total.json 四类合计精确", !!totalOK, total ? JSON.stringify(total).slice(0, 120) : "没有 total.json"),
        // 一张产物都没有的时候这条不算过：什么都没交，谈不上「记住了规范」
        ck("★三十步之后还记得「不许出现『其他』」★", have > 0 && spilled.length === 0, spilled.join(",") || "一张产物都没有"),
      ];
    },
  },
  {
    id: "multi-turn",
    name: "改主意之后，第一轮定的规矩还算不算数（多轮）",
    level: 3, kind: "多轮",
    // 考的不是单轮能力，是「用户第一句话立的规矩，到第三句话还守不守」。
    // 真实用法里这才是常态：没人会每轮都把要求重念一遍
    rubric: [
      "第二轮的「重算」是真的重算了（不是在旧结果上打补丁）",
      "最后一轮没有反过来问用户单位是什么（第一轮已经说过了）",
    ],
    turns: [
      "当前目录有 员工.csv（姓名,部门,职级,月薪，月薪单位是元）。帮我算各部门的月薪合计，写成 部门合计.json，格式 {\"部门名\": 合计数字}。有个规矩全程都算数：金额一律换算成「万元」，数字写成两位小数（比如 3.50，不是 3.5）。",
      "等一下，实习生不算在内，重新算一遍，覆盖原来那个文件。",
      "再给我一份 最高部门.txt，只写一行：合计最高的那个部门，和它的合计数。",
    ],
    inputs: {
      "员工.csv": "姓名,部门,职级,月薪\n张伟,研发,正式,32000\n李娜,研发,正式,28000\n王芳,研发,实习生,6000\n刘洋,市场,正式,21000\n陈静,市场,正式,19000\n赵磊,市场,实习生,5000\n孙悦,行政,正式,14000\n周涛,行政,正式,12000\n",
    },
    checks(dir) {
      let j = null;
      try { j = JSON.parse(read(dir, "部门合计.json")); } catch {}
      const want = { 研发: 6, 市场: 4, 行政: 2.6 };
      const near = (a, b) => Math.abs(Number(a) - b) < 0.005;
      const t = read(dir, "最高部门.txt");
      const lines = t.split("\n").filter((l) => l.trim());
      return [
        ck("部门合计.json 三个部门齐全", !!j && Object.keys(want).every((k) => j[k] != null), j ? JSON.stringify(j).slice(0, 100) : ""),
        ck("★第二轮的改主意生效了：实习生没算进去★", !!j && Object.keys(want).every((k) => near(j[k], want[k])), j ? JSON.stringify(j).slice(0, 100) : ""),
        ck("最高部门.txt 只有一行且点名研发", lines.length === 1 && lines[0].includes("研发"), lines.join(" / ").slice(0, 80)),
        ck("★第一轮定的万元口径活到了第三轮★", /6\.00/.test(t) && !/60000/.test(t), t.slice(0, 80)),
      ];
    },
  },
  {
    id: "memory-recall",
    name: "没人再说一遍的老规矩（记忆召回）",
    level: 2, kind: "记忆",
    // 长期记忆里躺着五条，只有三条跟这次交付有关。题面一个字都不提这些规矩——
    // 提了就成了照抄题面，考的就不是召回了
    memories: [
      "交付物里一律不要 emoji，一个都不要",
      "所有报告结尾必须单起一行写「—— 海川科技数据组」",
      "日期一律写成 2026-01-01 这种带横杠的格式，不要写成 1月1日",
      "常用浏览器是 Firefox，装的扩展别乱动",
      "内部沟通用飞书，不用钉钉",
    ],
    rubric: [
      "趋势描述跟数据对得上（不是套话）",
      "没有把记忆里的规矩复述进正文（照做就行，不用报备）",
    ],
    prompt: "当前目录有 本周数据.csv（日期,访问量）。整理成一份 周报.md，说清楚这周的走势，以及最高的是哪天、多少。",
    inputs: {
      "本周数据.csv": "日期,访问量\n2026-09-14,1200\n2026-09-15,1350\n2026-09-16,1580\n2026-09-17,1420\n2026-09-18,1910\n2026-09-19,2050\n2026-09-20,1760\n",
    },
    checks(dir) {
      const t = read(dir, "周报.md");
      return [
        ck("周报.md 存在", exists(dir, "周报.md")),
        ck("说对了最高那天（2026-09-19 · 2050）", /2026-09-19/.test(t) && /2050/.test(t)),
        ck("★记忆第 1 条：一个 emoji 都没有★", !!t && !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(t)),
        ck("★记忆第 2 条：结尾那行落款在★", /——\s*海川科技数据组/.test(t)),
        ck("★记忆第 3 条：日期没写成「9月19日」★", !!t && !/\d+\s*月\s*\d+\s*日/.test(t)),
      ];
    },
  },
];

module.exports = { TASKS };
