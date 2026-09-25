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

  // ---- ↑↓ 单子：跟审批那张一个样子，但刚摆出来那一下按的键一律不算 ----
  // 以前终端里审批是 ↑↓ 挑、提问却是「答> 」敲序号，而且空行＝第 1 条——
  // 单子出来之前就敲进缓冲区的那个回车，直接替人答了一道花钱 / 对外发布的题
  {
    const K = (name, extra) => Object.assign({ name }, extra || {});
    const late = ask.ENTER_GUARD_MS + 1;
    const key = ask.menuKey(OPTS.length); // 两条选项 + 「自己打一句」＝三行
    for (const [name, ch] of [["return", "\r"], ["enter", ""], ["1", "1"], ["2", "2"], ["3", "3"], ["escape", "\x1b"]]) {
      assert.strictEqual(key(0, K(name), ch, 0), null, `★刚摆出来就到的「${name}」不认★ 那是之前敲进缓冲区的，不是看着光标按的`);
      assert.strictEqual(key(0, K(name), ch, ask.ENTER_GUARD_MS - 1), null, `护栏时间内「${name}」都不认`);
    }
    assert.deepStrictEqual(key(0, K("return"), "\r", late), { pick: 0 }, "过了护栏，回车选光标那条");
    assert.deepStrictEqual(key(2, K("enter"), "", late), { pick: 2 }, "光标在「自己打一句」上回车，选的就是它");
    for (const [ch, want] of [["1", 0], ["2", 1], ["3", 2]]) assert.deepStrictEqual(key(0, K(ch), ch, late), { pick: want }, `「${ch}」直接选第 ${want + 1} 条`);
    for (const ch of ["4", "0", "x", "y", " ", ""]) assert.strictEqual(key(1, K(ch), ch, late), null, `「${ch}」认不出来就不管`);
    // 挪光标不算拍板，护栏时间内也照挪
    assert.deepStrictEqual(key(0, K("up"), "", 0), { sel: 2 }, "↑ 从第一条绕到「自己打一句」");
    assert.deepStrictEqual(key(2, K("down"), "", 0), { sel: 0 }, "↓ 从最后一条绕回第一条");
    assert.deepStrictEqual(key(0, K("j"), "j", 0), { sel: 1 });
    assert.deepStrictEqual(key(1, K("k"), "k", 0), { sel: 0 });
    assert.deepStrictEqual(key(0, K("tab"), "\t", 0), { sel: 1 });
    // Esc 是「这题你定」，不是 Ctrl+C 那种「整趟停下」
    assert.deepStrictEqual(key(0, K("escape"), "\x1b", late), { skip: true }, "★Esc 是跳过这题★ 不能把整趟活儿停掉");
    assert.deepStrictEqual(key(0, K("c", { ctrl: true }), "\x03", 0), { cancel: true }, "Ctrl+C 什么时候都是停这趟");
    assert.deepStrictEqual(key(0, K("d", { ctrl: true }), "\x04", 0), { cancel: true });

    const { cols } = require("../text-width");
    const m = ask.menu(1, OPTS, { width: 100, wait: "5 分钟" });
    assert.strictEqual(m.filter((l) => l.includes("❯")).length, 1, "光标只有一个");
    assert.ok(m.some((l) => l.includes("❯ 2. PDF")), "光标停在第 2 条");
    assert.ok(m.some((l) => l.includes("3. " + ask.OWN)), "最后一条得是「自己打一句」：选项列漏了是常事");
    // detail 是人唯一的判断依据，放得下就每条都摆着，不能逼人挨个挪光标才看得见
    for (const o of OPTS) assert.ok(m.join("\n").includes(o.detail), `「${o.label}」的说明被吞了`);
    assert.ok(m.join("\n").includes("5 分钟没人答"), "等多久要写出来");
    const LONG = [
      { label: "把整份报告导出成一份带目录和页眉页脚的 Word（.docx）文档交给甲方", detail: "甲方能直接在里面批注和改动，代价是排版到了别人机器上会跑，字体也可能被替换成默认的" },
      { label: "PDF", detail: "版式锁死，打印和投屏到哪儿都一样，但对方改不了一个字，要改只能回来找你重新出一版" },
      { label: "飞书文档", detail: "在线协作，谁都能评论，但离开飞书就打不开，发给外部客户还得另开权限" },
    ];
    for (const w of [30, 44, 60, 80, 120]) {
      for (let sel = 0; sel <= LONG.length; sel++) {
        const ls = ask.menu(sel, LONG, { width: w, wait: "5 分钟" });
        const widest = Math.max(...ls.map(cols));
        assert.ok(widest <= w, `★宽 ${w} 的终端里一行都不许折★ 折了重画就擦不干净（最宽 ${widest}）`);
        assert.strictEqual(ls.filter((l) => l.includes("❯")).length, 1);
      }
    }
    // 屏幕矮了：全摆开会高过屏幕，往回擦够不着顶——退成只有光标那条带说明
    const tall = ask.menu(0, LONG, { width: 44 });
    const short = ask.menu(1, LONG, { width: 44, rows: 12 });
    assert.ok(tall.length > 11, "这组选项全摆开本来就比 12 行高（不然下面测不出东西）");
    assert.ok(short.length <= 11, `★比屏幕矮一行★ 12 行的屏幕摆了 ${short.length} 行`);
    assert.ok(short.join("").includes("版式锁死") && !short.join("").includes("在线协作"), "放不下时只有光标那条带说明");

    // run() 走单子那条路
    const pickIO = (got, lines) => {
      const out = [];
      const seen = {};
      const queue = (lines || []).slice();
      return {
        io: {
          write: (s) => out.push(s),
          readLine: async (prompt, ms) => { seen.read = { prompt, ms }; return queue.length ? queue.shift() : null; },
          pick: async (p, ms) => { seen.p = p; seen.ms = ms; return got; },
          width: 72,
        },
        text: () => out.join(""),
        seen,
      };
    };
    {
      const f = pickIO({ key: "2" });
      assert.strictEqual(await ask.run({ question: "报告交哪种格式？", options: OPTS, timeoutMs: 300000 }, f.io), "PDF", "单子上选第 2 条");
      assert.ok(f.text().includes("？ 报告交哪种格式？"), "问题本身照印");
      assert.ok(f.text().includes("选了：PDF"), "选完没回显");
      assert.ok(!/敲序号|回车＝第 1 条/.test(f.text()), "有单子就别再印敲序号那套提示");
      assert.ok(!f.seen.read, "★有单子可挑就不该再摆「答> 」★");
      assert.strictEqual(f.seen.ms, 300000, "超时带给摆单子的那一层");
      assert.ok(f.seen.p.menu(0).join("\n").includes("5 分钟没人答"));
      assert.strictEqual(f.seen.p.key(0, { name: "return" }, "\r", 0), null, "★交出去的 key 带回车护栏★");
      assert.deepStrictEqual(f.seen.p.key(0, { name: "3" }, "3", 1000), { pick: 2 }, "交出去的 key 认得出第三行「自己打一句」");
    }
    // 最后那条「自己打一句」：退回敲一行，打什么交什么
    {
      const f = pickIO({ key: "3" }, ["  用飞书文档 "]);
      assert.strictEqual(await ask.run({ question: "交哪种？", options: OPTS }, f.io), "用飞书文档", "自己打的那句没交出去");
      assert.strictEqual(f.seen.read.prompt, "答> ");
      assert.strictEqual(f.seen.read.ms, 300000);
    }
    // 在那一行上空着回车＝不答，不是第 1 条：人刚说了「都不是」
    assert.strictEqual(await ask.run({ question: "交哪种？", options: OPTS }, pickIO({ key: "3" }, [""]).io), null, "说了「都不是」又空着回车，不能算成第 1 条");
    assert.strictEqual(await ask.run({ question: "交哪种？", options: OPTS }, pickIO({ key: "3" }).io), null);
    // 超时 / Esc / Ctrl+C
    assert.strictEqual(await ask.run({ question: "交哪种？", options: OPTS }, pickIO(null).io), null);
    // 手机上答的：跟敲一行同一套认法，认不准就原样交
    assert.strictEqual(await ask.run({ question: "交哪种？", options: OPTS }, pickIO({ text: "pdf" }).io), "PDF");
    assert.strictEqual(await ask.run({ question: "交哪种？", options: OPTS }, pickIO({ text: "都不要，用飞书文档" }).io), "都不要，用飞书文档");
    // 开放问题没得挑：还是敲一行
    {
      const f = pickIO({ key: "1" }, ["叫小助手"]);
      assert.strictEqual(await ask.run({ question: "你想叫它什么名字？", options: [] }, f.io), "叫小助手");
      assert.ok(!f.seen.p, "没有选项还摆了单子");
    }
  }

  console.log("cli-ask：通过");
}

module.exports = { run };
if (require.main === module) run().catch((e) => { console.error(e); process.exit(1); });
