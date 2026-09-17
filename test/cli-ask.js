"use strict";
/**
 * 终端里回答 agent 那道选择题。
 *
 * 钉的是一件之前根本不存在的事：cli.js 从来不传 askUser，agent.js 于是认定
 * 「当前是无人值守运行，没人在线回答」，让模型自己猜。最近在场的那个人——正坐在
 * 终端前的那个——恰恰是唯一问不到的人。网页上点一下就过的岔路（报告交 Word 还是 PDF、
 * 封面走生图还是排版截图），在终端里全成了模型替你赌一把。
 *
 * 整个来回都在 cli-ask.run 里，io 是注进去的，所以这一套不需要伪终端也能逐帧验。
 */
const assert = require("assert");
const ask = require("../cli-ask");

const OPTS = [
  { label: "Word", detail: "甲方能直接批注改动，但排版在不同机器上会跑" },
  { label: "PDF", detail: "版式锁死到处一样，代价是对方改不了" },
];

/** 把一串预先写好的输入当成人在敲。readLine 读完了就回 null（＝超时/Ctrl+C 的那条路） */
function fakeIO(inputs) {
  const out = [];
  const asked = [];
  const queue = inputs.slice();
  return {
    io: {
      write: (s) => out.push(s),
      readLine: async (prompt, timeoutMs) => { asked.push({ prompt, timeoutMs }); return queue.length ? queue.shift() : null; },
      width: 72,
    },
    text: () => out.join(""),
    asked,
    left: () => queue.length,
  };
}

async function run() {
  // ---- 问题长什么样 ----
  {
    const t = ask.render({ question: "报告交哪种格式？", options: OPTS }, { width: 72 });
    assert(t.includes("报告交哪种格式？"), "问题本身没印出来");
    assert(/1\.\s*Word/.test(t) && /2\.\s*PDF/.test(t), "选项没编号：不编号人就只能照抄原文");
    // detail 是 agent.js 提示词里写死「不许省」的那一段：只印 label 的话，
    // 「AI 生图 / HTML 排版截图」对不写代码的人就是两个没有差别的词
    assert(t.includes("甲方能直接批注改动") && t.includes("版式锁死到处一样"), "选项的 detail 被吞了");
    assert(/回车＝第 1 条/.test(t), "没告诉人回车就是默认那条");
  }
  // 没有选项时不许提「敲序号」——那会让人去找根本不存在的编号
  {
    const t = ask.render({ question: "你想叫它什么名字？" }, { width: 72 });
    assert(!/序号/.test(t), "开放问题里还在让人敲序号：" + t);
  }
  // 折行按显示宽度算，中文不能被切成半个字
  {
    const lines = ask.wrap("一二三四五六七八九十", 8);
    assert(lines.length > 1, "该折的没折");
    for (const l of lines) assert(!/�/.test(l) && l.length <= 8, "中文被按码位切了：" + JSON.stringify(l));
  }

  // ---- 人敲的那半截算什么 ----
  const P = (s) => ask.parse(s, OPTS);
  assert.strictEqual(P("2").label, "PDF", "序号认不出来");
  assert.strictEqual(P(" 1 ").label, "Word", "序号两边有空格就认不出来了");
  assert.strictEqual(P("").label, "Word", "空行该＝第 1 条（问到这一步的人多半就想按默认走）");
  assert.strictEqual(P("pdf").label, "PDF", "大小写不一样就认不出来了");
  assert.strictEqual(P("Wor").label, "Word", "打了一半认不出来");
  // 越界不能悄悄当成「随口说了句话」：人是真想选第 7 条，把「7」发给模型，
  // 模型只会看见一个孤零零的 7
  assert.strictEqual(P("7").kind, "outofrange", "越界的序号被当成自由回答发出去了");
  // 选项列漏了是常事，人该能直接说别的
  assert.deepStrictEqual(P("都不要，用飞书文档"), { kind: "free", text: "都不要，用飞书文档" });
  // 两条都沾边时不许替人做主——挑错了整件事白做，那正是 agent.js 规定「只在这种岔路上才问」的原因
  const many = ask.parse("报告", [{ label: "报告交 Word" }, { label: "报告交 PDF" }]);
  assert.strictEqual(many.kind, "many", "两条都对得上却替人挑了一条");
  assert.strictEqual(ask.parse("", []).kind, "empty", "开放问题上的空行不该被当成选了什么");
  // 模型偷懒直接给字符串（老会话回放也是这样）
  assert.strictEqual(ask.parse("2", ["甲", "乙"]).label, "乙", "字符串形式的选项不认");

  // ---- 一整个来回 ----
  {
    const f = fakeIO(["2"]);
    assert.strictEqual(await ask.run({ question: "交哪种？", options: OPTS, timeoutMs: 300000 }, f.io), "PDF");
    assert(f.text().includes("选了：PDF"), "选完没回显，人不知道自己那一下按中没有");
    assert(f.asked.length === 1 && f.asked[0].timeoutMs === 300000, "超时没带给读一行的那一层");
    assert(/5 分钟/.test(f.text()), "没说清等多久它就自己走了：" + f.text());
  }
  // 认不出来要再问，但有上限：不设上限的话，一个 Ctrl+D 之外什么都不回的终端会把这儿转死
  {
    const f = fakeIO(["9", "9", "9", "9", "9"]);
    assert.strictEqual(await ask.run({ question: "交哪种？", options: OPTS }, f.io), null, "问不出来时没有放弃");
    assert.strictEqual(f.asked.length, ask.MAX_TRIES, `重问次数是 ${f.asked.length}，不是说好的 ${ask.MAX_TRIES}`);
    assert(/没有第 9 条/.test(f.text()), "越界时没说清是越界");
    assert.strictEqual(f.left(), 5 - ask.MAX_TRIES, "多读了几行，后面的输入会被这道题吃掉");
  }
  // 先答错再答对
  {
    const f = fakeIO(["报告", "1"]);
    assert.strictEqual(await ask.run({ question: "交哪种？", options: [{ label: "报告交 Word" }, { label: "报告交 PDF" }] }, f.io), "报告交 Word");
    assert(/都对得上/.test(f.text()), "含糊时没说清为什么没算数");
  }
  // 超时/Ctrl+C：readLine 回 null，整件事回 null——agent.js 收到 null 会带着
  // 「用户没回应」继续跑，而不是把这趟活儿丢掉。人走开了不该等于任务作废
  {
    const f = fakeIO([]);
    assert.strictEqual(await ask.run({ question: "交哪种？", options: OPTS }, f.io), null, "没人回答时没有还回 null");
  }
  // 自由回答原样交出去：agent.js 那边 options.find 找不到只是拿不到 detail，不会出错
  {
    const f = fakeIO(["都不要，我要飞书文档"]);
    assert.strictEqual(await ask.run({ question: "交哪种？", options: OPTS }, f.io), "都不要，我要飞书文档");
  }
  // 超时下限：agent.js 那边是 Math.max(30000, …)，这边跟着，不然会比它先放弃
  {
    const f = fakeIO(["1"]);
    await ask.run({ question: "x", options: OPTS, timeoutMs: 1 }, f.io);
    assert.strictEqual(f.asked[0].timeoutMs, 30000, "超时没托到 30 秒下限，会比 agent 先撒手");
  }

  console.log("cli-ask：通过");
}

module.exports = { run };
if (require.main === module) run().catch((e) => { console.error(e); process.exit(1); });
