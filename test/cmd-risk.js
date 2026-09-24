"use strict";
/**
 * 名单外那条命令，跑之前先判一句。
 *
 * 这个功能拦的是四张名单都没命中、今天一声不吭直接跑的那一类：
 * `git reset --hard`、`cat 模板 > 配置文件`、`docker volume rm`、run_node 里的 `fs.rmSync`。
 * 它只做一件事——把「直接跑」抬成「弹审批卡」。所以要守的边界是这几条：
 *
 *   1. **只往更谨慎那边动**：allow → ask，一条都不许往回走。
 *      它不能把本来要问的变成不问，更不能替人拒绝——最后拍板的永远是人。
 *   2. **该不该花这道题的钱**：整条命令每一段都只读，结构上就确定没事，答案是白买的；
 *      裁定本来就不是 allow，判了也改不了结论。免费的尺子够得着的地方不许花钱。
 *   3. **门槛**：它说「撤不回来」但自己只有六成把握，就去烦人，这个功能就废了——
 *      一个总在误报的安全闸，用户第一件事是去把它关掉。
 *   4. **闸坏了退回老行为**：没开、没配、问不成、答不上、说不准，一律照今天的样子跑。
 *      「问不成」和「问了说没事」长得完全不一样，不许走到同一个分支去。
 *   5. **发出去的东西**：命令原文要发给判断模型，但工作目录的绝对路径不许跟着出去——
 *      判这条命令危不危险，用不着知道它跑在谁的电脑上。
 *
 * 跑法：node test/cmd-risk.js
 * 不花钱、不出外网：判断模型那一趟在这儿是替换掉的假函数。
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const { src } = require("./lib/src"); // server / tools / canvas 三组源码的唯一读法，见 test/lib/src.js
const cr = require(path.join(ROOT, "cmd-risk"));
const systemone = require(path.join(ROOT, "systemone"));
const security = require(path.join(ROOT, "security"));
const jev = require(path.join(ROOT, "jev"));
const tools = require(path.join(ROOT, "tools"));
const { RISK_KEY, KIND_KEY, RISK_MIN } = cr;

let pass = 0, fail = 0, finished = false;
// 这一套里有真跑工具的用例。跑不到收尾就退出、退出码还是 0，CI 看就是一片绿——
// 判定器自己会骗人，所以钉一道：没走到最后一行就算红。
process.on("exit", (code) => {
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`);
  process.exitCode = 1;
});

function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }

/** 一条是非答案：sure 照 jev 那边同一把尺子算 */
const ans = (value, sure) => ({ key: RISK_KEY, value, sure: sure === undefined ? systemone.sureOfNoul(value) : sure });
const kind = (label) => ({ key: KIND_KEY, value: label, sure: 0.9 });
const out = (...answers) => ({ ok: true, answers });

const ALLOW = { action: "allow" };
const SEC = { ...security.DEFAULTS, gateway: true, cmd_risk_gate: true, permission_mode: "auto" };

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log("\n① 免费的粗筛：哪些命令根本不用花钱问");
  // ─────────────────────────────────────────────────────────────
  {
    const free = [
      ["ls -la", "看一眼目录"],
      ["cat 说明.md", "读文件"],
      ["git status", "带子命令的工具，只认确定只读的那几个子命令"],
      ["git log --oneline | head -20", "管道两头都只读"],
      ["grep -rn foo . 2>&1", "2>&1 拆段之后剩下的那个「1」不是命令，别当成会动东西的"],
      ["echo hi > /dev/null", "写 /dev/null 不落盘"],
      ["npm ls", "npm 的只读子命令"],
      ["ps aux | grep node", "看进程"],
      ["/usr/bin/wc -l 稿子.md", "带路径的也认得出来"],
      ["ENV=1 cat x", "前面挂着 VAR= 的照样剥得掉"],
    ];
    for (const [cmd, why] of free) ok(cr.firstMutating(cmd) === "", `★不花钱★ ${cmd}　—— ${why}`, cr.firstMutating(cmd));

    const paid = [
      ["git reset --hard origin/main", "把没提交的改动冲掉——四张名单一张都不命中"],
      ["git clean -fdx", "同上"],
      ["git checkout -- .", "同上"],
      ["cat 模板 > 配置文件.json", "头是 cat，只看头的话是只读的，实际把人家配置盖了"],
      ["truncate -s 0 重要.log", "清空"],
      ["mv 素材目录 /tmp/x", "没删，但也找不着了"],
      ["docker volume rm data", "连数据卷一起没"],
      ["npm publish", "发出去了就收不回来"],
      ["pm2 delete all", "带子命令的工具，子命令不在只读表里"],
      ["echo a && rm -rf b", "挑出来的是真会动东西的那一段"],
      ["echo $(git clean -fd)", "$() 里头的也得挖出来单独算"],
      ["node build.js", "认不出来的一律当成会动东西"],
      ["sed -i 's/a/b/' f", "sed 带上 -i 就开始写了，所以它压根没进只读表"],
      ["find . -name x -delete", "find 同理"],
    ];
    for (const [cmd, why] of paid) ok(cr.firstMutating(cmd) !== "", `★该花这道题的钱★ ${cmd}　—— ${why}`, cr.firstMutating(cmd));

    eq(cr.firstMutating("echo a && rm -rf b"), "rm -rf b", "  └ 挑出来的是那段可疑的，不是整条（摆给判断模型看的要准）");
    eq(cr.firstMutating(""), "", "  └ 空命令不花钱");
    eq(cr.firstMutating(null), "", "  └ 传了空也不炸");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n② 代码那扇门：只守 shell 一扇是守不住的");
  // ─────────────────────────────────────────────────────────────
  {
    ok(cr.firstMutatingCode("fs.rmSync(p, { recursive: true })") === "fs.rmSync",
      "★run_node 里删东西也得过这一道★ checkCode 今天只拦「碰黑名单」和「开子进程」");
    ok(cr.firstMutatingCode("await fs.promises.unlink(f)") !== "", "  └ promises 那一套同样认");
    ok(cr.firstMutatingCode('fetch(u, { method: "DELETE" })') !== "", "  └ 对外发 DELETE 也算");
    ok(cr.firstMutatingCode("const r = JSON.parse(fs.readFileSync(f)); console.log(r)") === "",
      "★读文件不花钱★ 粗筛认的是会动东西的那几个调用");
    ok(cr.firstMutatingCode("fs.mkdirSync(d, { recursive: true })") === "",
      "  └ 建目录不毁东西，故意没列进去：列了等于每个存结果的脚本都白花一道题");
    ok(cr.firstMutatingCode("fs.appendFileSync(log, line)") === "", "  └ 往后接一段同理");
    ok(cr.firstMutatingCode("") === "", "  └ 空代码不花钱");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n③ 四道免费的闸挡在花钱前面");
  // ─────────────────────────────────────────────────────────────
  {
    const cmd = "git reset --hard";
    ok(cr.needsJudge({ verdict: ALLOW, sec: SEC, text: cmd, kind: "命令" }) !== "",
      "★本来要一声不吭跑的，这才轮到它★");
    eq(cr.needsJudge({ verdict: { action: "ask", rule: "删除保护" }, sec: SEC, text: "rm -rf x", kind: "命令" }), "",
      "★已经要问了就不问★ 判了也改不了结论，纯浪费");
    eq(cr.needsJudge({ verdict: { action: "deny", rule: "只看不动" }, sec: SEC, text: cmd, kind: "命令" }), "",
      "  └ 已经要拦了同理");
    eq(cr.needsJudge({ verdict: ALLOW, sec: { ...SEC, gateway: false }, text: cmd, kind: "命令" }), "",
      "★安全网关关着就不问★ 用户明说了「别拦我」，这时候弹卡是不听人话");
    eq(cr.needsJudge({ verdict: ALLOW, sec: { ...SEC, cmd_risk_gate: false }, text: cmd, kind: "命令" }), "",
      "★开关没开就不问★");
    eq(cr.needsJudge({ verdict: ALLOW, sec: { ...SEC, cmd_risk_gate: "on" }, text: cmd, kind: "命令" }), "",
      "  └ 只认布尔的 true：配置里写了个字符串不算开（默认必须是关的）");
    eq(cr.needsJudge({ verdict: ALLOW, sec: SEC, text: "git status", kind: "命令" }), "",
      "★结构上确定没事就不问★ 答案是白买的");
    eq(cr.needsJudge({}), "", "  └ 什么都没传也不炸");
    eq(security.DEFAULTS.cmd_risk_gate, false, "★默认关★ 它要把命令原文发到外面去，这事得用户自己点头");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n④ 什么样的回答才配把一条命令拦下来");
  // ─────────────────────────────────────────────────────────────
  {
    const hot = cr.readRisk(out(ans(0.9), kind("删掉或者覆盖了拿不回来的东西")));
    ok(hot && hot.label === "删掉或者覆盖了拿不回来的东西", "★说撤不回来、而且拿得准 → 拦★", hot);
    ok(cr.readRisk(out(ans(0.49))) === null, "★说撤得回来就别拦★ 概率没过半");
    ok(cr.readRisk(out(ans(0.02))) === null,
      `★倒向「撤得回来」也是有主意★ 0.02 算出来的确定度是 ${systemone.pct(systemone.sureOfNoul(0.02))}——只看确定度那道闸正好拦反`);
    ok(cr.readRisk(out(ans(0.5))) === null,
      "  └ 正正好一半 = 完全没主意（sure 算出来是 0），照旧跑");
    // ★反向对照★ 上游那边自己报一个 confidence 过来。noul 这一类的「有多拿得准」是我们按概率算的，
    // 不是它报的——真让它报，它可以一边说「五五开」一边说「我九成九确定」，闸就被它自己说开了。
    const raw = systemone.readAnswers({
      answers: { [RISK_KEY]: { type: "noul", noul: 0.5, confidence: 0.99 } },
    });
    ok(cr.readRisk({ ok: true, answers: raw.answers }) === null,
      "★确定度不许上游自己报★ 从真的回包一路读下来：说五五开就是没主意，它报多高的 confidence 都开不了这道闸");
    eq(raw.answers[0].sure, 0, "  └ 读回包那一层就把它按概率算回来了");
    ok(cr.readRisk(out(ans(0.84))) === null,
      `  └ 概率 0.84（确定度 ${systemone.pct(systemone.sureOfNoul(0.84))}）不到门槛：说不准就照旧跑，不拿它的犹豫去烦人`);
    ok(cr.readRisk(out(ans(0.85))) !== null,
      `  └ 概率 0.85 正好压线（确定度 ${systemone.pct(RISK_MIN)}）：门槛是「到了就算」`);
    ok(cr.readRisk(out(ans(null))) === null, "  └ 没答上来：照旧跑");
    ok(cr.readRisk(out({ key: "别的题", value: 0.99, sure: 0.99 })) === null,
      "  └ 答的是另一道题：按题名取，不是拿第一条顶上");
    ok(cr.readRisk({ ok: true }) === null, "  └ 一条答案都没有也不炸");
    ok(cr.readRisk(out({ key: RISK_KEY, value: "撤不回来", sure: 0.99 })) === null,
      "★答非所问不算答★ 上游哪天把是非题当单选答了，value 是一句话——拿它跟 0.5 比大小，比出来的没有意义");
    // 门槛给了个不是数的：NaN 拿去比大小永远是 false，闸会整个哑掉。这儿挡了一道，
    // so.gate 里头还挡了一道——两道门槛都是 0.7，所以单拆哪一道都看不出差别。
    // 看不出差别的东西最容易被人顺手删掉，所以两道各钉一条。
    ok(cr.readRisk(out(ans(0.9)), "不是数") !== null, "  └ 门槛给了个不是数的，退回默认门槛");
    ok(cr.readRisk(out(ans(0.6)), "不是数") === null, "  └ ★真退回默认门槛，不是把闸弄哑★ 说不准的那条不许这么混过去");
    eq(systemone.gate({ key: RISK_KEY, value: 0.9, sure: 0.6 }, "不是数").act, false,
      "  └ 下游那道也一样挡（这两道是同一件事的两层保险，拆哪层都还是对的）");
    ok(cr.readRisk(out(ans(0.9)), 0.99) === null, "  └ 门槛调严了就真的更严");
    const noKind = cr.readRisk(out(ans(0.95)));
    ok(noKind && noKind.label === "", "  └ 单选那道没答上来照样能拦，只是卡上少一句为什么");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑤ 审批卡上那句话");
  // ─────────────────────────────────────────────────────────────
  {
    const d = cr.readRisk(out(ans(0.96), kind("把东西发到了外面")));
    const rule = cr.riskRule(d);
    ok(/把东西发到了外面/.test(rule), "★卡上写清为什么问你★ Jev 不会写字，理由只能是它选的那一类", rule);
    ok(/确定度/.test(rule) && /%/.test(rule), "  └ 少跑这一步的凭据（确定度）得给人看见", rule);

    const up = cr.upgrade("git reset --hard origin/main", d, "命令");
    eq(up.action, "ask", "★只抬成「问一句」★ 不许替人放行，更不许替人拒绝");
    eq(up.ruleKey, security.ruleFor("git reset --hard origin/main"),
      "  └「以后别再问这类」按命令+子命令记：批过 git reset 不等于把 git push -f 也放过去");
    ok(up.ruleKey === "git reset" && up.ruleKey !== "git", "  └ 粒度就是这一级", up.ruleKey);
    const upCode = cr.upgrade("fs.rmSync", d, "代码");
    eq(upCode.ruleKey, "", "★代码那扇门不给「以后别再问」★ 同一个 key 底下什么都能写，按一下等于敞开整扇门");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑥ 摆给它看的现场：给够，但别给多");
  // ─────────────────────────────────────────────────────────────
  {
    const home = "/Users/某人/工作空间/项目";
    const st = cr.riskState({ text: "rm -rf 缓存", seg: "rm -rf 缓存", where: "子目录", mode: "自动", kind: "命令" });
    ok(st.includes("【它要跑的命令】") && st.includes("【其中这一段是名单外的】") && st.includes("【跑在哪儿】"),
      "★三段都带标题★ 不贴标签的话，模型分不清哪段是命令哪段是现场");
    ok(st.includes("自动"), "  └ 当前权限档位也告诉它");
    const st2 = cr.riskState({ text: "x".repeat(9999), seg: "x", kind: "命令" });
    ok(st2.length < 4000, `  └ 超长命令截得住（${st2.length} 字符）`);
    ok(st2.includes("工作空间根目录"), "  └ 没给工作目录就说「根目录」，不留空让它猜");
    ok(!home.split("/").some((seg) => seg && st.includes(seg)) || !st.includes(home),
      "★绝对路径不跟着出去★ 判这条命令危不危险，用不着知道它跑在谁的电脑上");
    const code = cr.riskState({ text: "fs.rmSync(p)", seg: "fs.rmSync", kind: "代码" });
    ok(code.includes("【它要跑的代码】"), "  └ 代码那扇门说的是「代码」，不是「命令」");

    const { questions, errs } = systemone.normalizeQuestions(cr.riskQuestions("命令"));
    eq(errs.length, 0, "★题目本身得是上游收得下的★ 写错了要本地就发现，不是发一趟等 400", errs);
    eq(questions[RISK_KEY].type, "noul", "  └ 是非题定拦不拦");
    eq(questions[KIND_KEY].type, "choice", "  └ 单选题只为卡片上那句为什么");
    ok(Object.keys(questions[KIND_KEY].criteria).length >= 4, "  └ 选项够分得清几类后果");
    ok(/这条命令/.test(questions[RISK_KEY].instructions), "  └ 命令那门问的是命令");
    ok(/这段代码/.test(systemone.normalizeQuestions(cr.riskQuestions("代码")).questions[RISK_KEY].instructions),
      "  └ 代码那门问的是代码（同一道题换个说法，模型才知道在看什么）");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑦ 同一条命令别问第二遍");
  // ─────────────────────────────────────────────────────────────
  {
    cr.forget();
    eq(cr.recall("git reset --hard").hit, false, "  └ 没判过就是没判过");
    cr.remember("git  reset   --hard", null);
    eq(cr.recall("git reset --hard").hit, true, "★空白多几个也算同一条★ 不然换个空格就再花一次钱");
    eq(cr.recall("git reset --hard").verdict, null, "  └ 判过没事的，记的是「没事」");
    const up = cr.upgrade("rm -rf x", cr.readRisk(out(ans(0.99), kind("删掉或者覆盖了拿不回来的东西"))), "命令");
    cr.remember("rm -rf x", up);
    eq(cr.recall("rm -rf x").verdict.action, "ask",
      "★记账只省钱，不省安全★ 判危险的那条，第二次照样弹卡");
    cr.forget();
    eq(cr.recall("rm -rf x").hit, false, "  └ 清得掉");
    for (let i = 0; i < cr.MEMO_MAX + 5; i++) cr.remember("cmd " + i, null);
    eq(cr.recall("cmd 0").hit, false, "★记不下就丢最早的★ 服务器一开几个月，这张表不能无限长");
    eq(cr.recall("cmd " + (cr.MEMO_MAX + 4)).hit, true, "  └ 新的还在");
    cr.forget();
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑧ 真跑一趟：从命令闸一路到审批卡");
  // ─────────────────────────────────────────────────────────────
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-risk-"));
    const cfg = { decide: { api_key: "假的-只为过配没配那道闸", route: "typesafe" }, providers: [] };
    const real = jev.askMetered;
    let asked = [];
    const stub = (reply) => { jev.askMetered = async (_c, args, o) => { asked.push({ args, o }); return typeof reply === "function" ? reply(args) : reply; }; };
    const run = (name, input, sec, extra) => tools.withWorkspace(tmp, () =>
      tools.executeTool(name, input, { security: sec, decideConfig: cfg, timeoutMs: 20000, ...(extra || {}) }));
    // 等审批条上出现这一条，拿到它再放行/拒绝；等不到就是接线断了
    const waitCard = async (pred) => {
      for (let i = 0; i < 150; i++) {
        const hit = security.listApprovals().find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 20));
      }
      return null;
    };

    try {
      // A 判危险 → 弹卡 → 人拒绝 → 命令没跑
      cr.forget(); asked = [];
      stub(out(ans(0.97), kind("删掉或者覆盖了拿不回来的东西")));
      const target = path.join(tmp, "别动我.txt");
      fs.writeFileSync(target, "原样\n");
      const pending = run("run_shell", { command: "echo 盖掉了 > 别动我.txt" }, { ...SEC });
      const card = await waitCard((a) => /别动我/.test(a.text));
      ok(!!card, "★名单外那条命令弹出了审批卡★ 四张名单一张都没命中，今天是直接就跑");
      if (card) {
        ok(/判断模型/.test(card.rule) && /确定度/.test(card.rule), "  └ 卡上写清是谁判的、有多确定", card.rule);
        ok(/删掉或者覆盖/.test(card.rule), "  └ 也写清了它担心的是哪一类", card.rule);
        security.resolveApproval(card.id, false, "once");
      }
      const r = await pending;
      eq(r.isError, true, "★人说不批，就真的没跑★");
      eq(fs.readFileSync(target, "utf8"), "原样\n", "  └ 文件一个字没变（拦在执行之前，不是执行完再报）");
      eq(asked.length, 1, "  └ 只问了一道题的钱");
      ok(/名单外/.test((asked[0].o || {}).meta || ""), "  └ 记账上标明了是哪一处花的", (asked[0].o || {}).meta);

      // A2 同一条危险命令再来一遍：钱不花第二遍，卡照样弹（接着 A 的记账，中间不能清）
      asked = [];
      const again = run("run_shell", { command: "echo 盖掉了 > 别动我.txt" }, { ...SEC });
      const card1b = await waitCard((a) => /别动我/.test(a.text));
      ok(!!card1b, "★记账只省钱，不省安全★ 省掉的是那道题的钱，不是那张卡");
      if (card1b) security.resolveApproval(card1b.id, false, "once");
      await again;
      eq(asked.length, 0, "  └ 这一遍一分钱没花");
      eq(fs.readFileSync(target, "utf8"), "原样\n", "  └ 文件还是原样");

      // B 判没事 → 不弹卡，照常跑
      cr.forget(); asked = [];
      stub(out(ans(0.02), kind("只动了能重新生成的产物")));
      const b = await run("run_shell", { command: "echo 产物 > 构建产物.txt" }, { ...SEC });
      eq(b.isError, false, "★判没事就别拦★ 一个总在误报的安全闸，用户第一件事是去把它关掉");
      eq(fs.existsSync(path.join(tmp, "构建产物.txt")), true, "  └ 命令真跑了");
      eq(asked.length, 1, "  └ 花了一道题");

      // C 同一条命令再来一遍：不再花钱
      const c = await run("run_shell", { command: "echo 产物 > 构建产物.txt" }, { ...SEC });
      eq(c.isError, false, "  └ 第二遍照样跑");
      eq(asked.length, 1, "★同一条命令一次运行里只问一遍★ 第二遍是拿钱买一个已经知道的答案");

      // D 开关没打开：一道题都不花
      cr.forget(); asked = [];
      const d = await run("run_shell", { command: "echo x > 开关关着.txt" }, { ...SEC, cmd_risk_gate: false });
      eq(d.isError, false, "★默认那条路一点没变★");
      eq(asked.length, 0, "  └ 开关没开就一分钱不花");

      // E 只读命令：一道题都不花
      cr.forget(); asked = [];
      const e = await run("run_shell", { command: "echo 只是看看" }, { ...SEC });
      eq(e.isError, false, "  └ 只读命令照跑");
      eq(asked.length, 0, "★结构上确定没事的不花钱★");

      // F 没配判断模型：照旧跑
      cr.forget(); asked = [];
      const f = await tools.withWorkspace(tmp, () => tools.executeTool("run_shell", { command: "echo x > 没配.txt" }, { security: { ...SEC } }));
      eq(f.isError, false, "★没配判断模型，一切照旧★");
      eq(asked.length, 0, "  └ 也不会去发请求");

      // G 问不成：照旧跑，而且要留痕
      cr.forget(); asked = [];
      jev.askMetered = async () => { throw new Error("上游 500"); };
      const warns = [];
      const realWarn = console.warn;
      console.warn = (...a) => warns.push(a.join(" "));
      const g = await run("run_shell", { command: "echo x > 问不成.txt" }, { ...SEC });
      console.warn = realWarn;
      eq(g.isError, false, "★问不成也照旧跑★ 这道闸自己坏了，不能把活儿卡在这儿");
      ok(warns.some((w) => /名单外|风险/.test(w)), "  └ 但要留痕：后台飞轮吞异常等于这个功能悄悄没了", warns);

      // H 上游回了个 ok:false（额度满、Key 不对这一类）：跟异常同样退回老路
      cr.forget(); asked = [];
      stub({ ok: false, error: "额度用完了" });
      const h = await run("run_shell", { command: "echo x > 额度满.txt" }, { ...SEC });
      eq(h.isError, false, "  └ 上游说不行，也照旧跑（「问不成」不许走成「问了说危险」）");

      // H2 问不成的那条不许记成「判过、没事」——记岔了，这条命令这一整轮就再也不会被问
      asked = [];
      stub(out(ans(0.97), kind("删掉或者覆盖了拿不回来的东西")));
      const pend4 = run("run_shell", { command: "echo x > 额度满.txt" }, { ...SEC });
      const card4 = await waitCard((a) => /额度满/.test(a.text));
      ok(!!card4, "★没问成不算判过★ 额度回来之后，同一条命令得重新问，不能拿一次失败当免死金牌");
      if (card4) security.resolveApproval(card4.id, false, "once");
      await pend4;
      eq(asked.length, 1, "  └ 这一遍才真花了那道题的钱");

      // I run_node 那扇门
      cr.forget(); asked = [];
      stub(out(ans(0.95), kind("删掉或者覆盖了拿不回来的东西")));
      const keep = path.join(tmp, "代码要删的.txt");
      fs.writeFileSync(keep, "还在\n");
      const pend2 = run("run_node", { code: 'const fs=require("fs");fs.rmSync("代码要删的.txt");console.log("删了")' }, { ...SEC });
      const card2 = await waitCard((a) => /rmSync/.test(a.text) || /rmSync/.test(a.rule || ""));
      ok(!!card2, "★run_node 里删东西也弹卡★ 只守 shell 一扇门是守不住的");
      if (card2) {
        eq(card2.ruleKey, "", "  └ 代码那张卡上没有「以后别再问这类」（一按等于敞开整扇门）");
        security.resolveApproval(card2.id, false, "once");
      }
      await pend2;
      eq(fs.readFileSync(keep, "utf8"), "还在\n", "  └ 拒了就真没删");

      // J 只读的代码不花钱
      cr.forget(); asked = [];
      const j = await run("run_node", { code: 'console.log(1+1)' }, { ...SEC });
      eq(j.isError, false, "  └ 不动东西的代码照跑");
      eq(asked.length, 0, "★代码那边同样是免费的尺子先量★");
    } finally {
      jev.askMetered = real;
      cr.forget();
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑨ 接线：开关摆得出来、存得下去、回得来");
  // ─────────────────────────────────────────────────────────────
  {
    const ui = fs.readFileSync(path.join(ROOT, "public", "js", "app-06.js"), "utf8");
    ok(/id="sec-crisk"|"sec-crisk"/.test(ui), "★设置里摆得出来★ 开关存在但找不到＝没有");
    ok(/cmd_risk_gate: pane\.querySelector\("#sec-crisk"\)\.checked/.test(ui), "  └ 勾了真存得下去");
    ok(/sec\.cmd_risk_gate === true/.test(ui), "  └ 存过之后回来还是勾着的（写了但从来没渲染是另一种坏）");
    const at = ui.indexOf('"sec-crisk"'), near = ui.indexOf('"sec-cak"');
    ok(at > near && at - near < 1200, "★就近★ 摆在命令名单那张卡里：它管的就是那两张名单管不到的部分");
    const seg = ui.slice(at, at + 1600);
    ok(/美金|花钱/.test(seg), "  └ 说清楚它花钱");
    ok(/发给判断模型|发到外面|原文会发/.test(seg), "★说清命令原文会发出去★ 这事得用户知情才叫自己点头");
    ok(/判断模型/.test(seg) && /没配/.test(seg), "  └ 没配判断模型时当面说清勾了也不生效");

    const i18n = fs.readFileSync(path.join(ROOT, "public", "js", "i18n.js"), "utf8");
    ok(i18n.includes('"名单外先判一句"'), "  └ 标题有英文（这个产品是双语的，漏一条就半中半英）");

    const srv = src("server");
    ok(/"gateway", "delete_protect", "cmd_risk_gate"/.test(srv), "  └ 后端收这个开关（前端存了后端不收＝存不下去）");

    const sec = fs.readFileSync(path.join(ROOT, "security.js"), "utf8");
    ok(/cmd_risk_gate: false/.test(sec), "  └ 默认值写在安全策略那张表里");

    const ag = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8");
    ok(/decideConfig: \{ decide: config\.decide, providers: config\.providers \}/.test(ag),
      "★只把认路要用的两样递下去★ 不把整份 config（连着所有 Key）塞进工具层");
    ok(!/decideConfig: config\b/.test(ag), "  └ ★反向对照★ 没有图省事直接把整份递下去的写法");

    const tl = src("tools");
    ok(/judgeRisk\(security\.checkCommand/.test(tl) && /judgeRisk\(security\.checkCode/.test(tl),
      "★两扇门都接上了★ 只守 shell 那扇是守不住的");
    ok(/timeoutMs: 8000/.test(tl.slice(tl.indexOf("const judgeRisk"), tl.indexOf("const judgeRisk") + 2600)),
      "  └ 挡在一条命令前头，等不起默认那 20 秒");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑧ 替用户在桌面上打开文件：不判，直接问");
  // ─────────────────────────────────────────────────────────────
  {
    // 用户每次交付完都被弹一个 Finder / 浏览器窗口，记忆里明明记着「别替我打开」。提示词和记忆都是建议，
    // 这一条改成闸：open / xdg-open / start / explorer 一律先问。它不是「撤不回来」那种风险（判断模型管的），
    // 是「用户没要求就别替他做」那种——四张名单外、判断模型再准也不该放行，所以写死在名单里
    const base = { ...security.DEFAULTS };
    const chk = (c) => security.checkCommand(base, c);
    for (const c of ["open 封面.png", "open -a Safari https://example.com", "xdg-open 报告.pdf", "start out.html", "explorer ."]) {
      const r = chk(c);
      ok(r.action === "ask" && /打开文件或网页/.test(r.rule), `★${c.split(" ")[0]} 先问★ ${c}`, r);
    }
    ok(chk("cat readme.md && open 封面.png").action === "ask", "  └ 藏在 && 后面也认");
    ok(chk("echo open the door").action === "allow", "（对照）open 当参数出现不算");
    ok(chk("node open.js").action === "allow", "（对照）文件名里带 open 不算");
    ok(chk("ls -la").action === "allow", "（对照）平常命令照旧放行");
    ok(security.DESKTOP_OPEN_CMDS instanceof Set && security.DESKTOP_OPEN_CMDS.has("open"), "  └ 名单导出来，别处能查");
    const ag = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8");
    ok(/不要用 open \/ xdg-open \/ start 替用户打开文件或网页/.test(ag), "★提示词里也写明了★ 闸拦的是动作，提示词省的是那一问");
  }

  finished = true;
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
